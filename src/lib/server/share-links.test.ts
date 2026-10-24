import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-share-links-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle') } };
});

const fs = await import('node:fs');
const path = await import('node:path');
const { db, rawDb, schema } = await import('./db');
const { cfg } = await import('./config');
const { createCategoryFromTemplate, getCategoryById } = await import('./services/categories');
const { addLog, createItem } = await import('./services/items');
const { saveShares } = await import('./services/access');
const links = await import('./services/share-links');
const listLoad = (await import('../../routes/s/[token]/+page.server')).load;
const itemLoad = (await import('../../routes/s/[token]/items/[id]/+page.server')).load;
const mediaGet = (await import('../../routes/s/[token]/media/[imageId]/+server')).GET;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);

function person(name: string) {
	return db()
		.insert(schema.users)
		.values({ username: name, displayName: `${name[0].toUpperCase()}${name.slice(1)}`, passwordHash: 'x' })
		.returning()
		.get();
}

/** Runs something that must fail and gives the HTTP status it failed with */
function statusOf(fn: () => unknown): number | null {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status ?? -1;
	}
	return null;
}

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function addImage(userId: number, target: { itemId?: number; logId?: number }, extra = {}) {
	const id = uuid();
	return db()
		.insert(schema.images)
		.values({
			userId,
			...target,
			kind: 'upload',
			path: `u${userId}/${id}.webp`,
			thumbPath: `u${userId}/t/${id}.webp`,
			...extra
		})
		.returning()
		.get();
}

const daniel = person('daniel');
const partner = person('partner'); // a household member the list is shared with
const stranger = person('stranger');
const whiskey = createCategoryFromTemplate(daniel.id, 'whiskey');
const { category: whiskeyCat } = getCategoryById(daniel.id, whiskey.id);
const otherList = createCategoryFromTemplate(daniel.id, 'wine');
const partnersList = createCategoryFromTemplate(partner.id, 'whiskey');

// Daniel's own view of the list
const lagavulin = createItem(
	daniel.id,
	{
		categoryId: whiskey.id,
		title: 'Lagavulin 16',
		subtitle: 'Islay',
		status: 'tasted',
		rating: 90,
		favorite: true,
		notes: "Daniel's note on the bottle",
		custom: { distillery: 'Lagavulin', age: 16, price: 99, abv: 43 }
	},
	['smoky', 'islay']
);
const wishItem = createItem(daniel.id, {
	categoryId: whiskey.id,
	title: 'Pappy Van Winkle',
	status: 'wishlist'
});
createItem(daniel.id, { categoryId: whiskey.id, title: 'Springbank 21' }); // no status
const wine = createItem(daniel.id, { categoryId: otherList.id, title: 'Barolo', status: 'tasted' });
const strangersItem = createItem(partner.id, { categoryId: partnersList.id, title: 'Partner secret dram' });

addLog(
	daniel.id,
	lagavulin.id,
	{
		date: '2026-10-12',
		rating: 80,
		notes: 'Smoke and seaweed',
		location: 'The Snug',
		price: 12.5,
		custom: { nose: 'Peat', palate: 'Brine', finish: 'Long' }
	},
	whiskeyCat.statuses
);
addLog(daniel.id, lagavulin.id, { date: '2026-10-14', rating: 100 }, whiskeyCat.statuses);

// Partner has the list shared with them and keeps their own progress, logs and photos on it
saveShares(daniel.id, whiskey.id, [{ userId: partner.id, role: 'edit' }]);
rawDb()
	.prepare(
		`INSERT INTO item_progress (item_id, user_id, status, rating, favorite, notes, updated_at)
		 VALUES (?, ?, 'finished', 20, 1, 'PARTNER-PRIVATE-NOTE', ?)`
	)
	.run(lagavulin.id, partner.id, Date.now());
addLog(
	partner.id,
	lagavulin.id,
	{ date: '2026-10-13', rating: 30, notes: 'PARTNER-LOG-NOTE', location: 'PARTNER-PLACE', price: 777 },
	whiskeyCat.statuses
);
const partnerLog = rawDb()
	.prepare('SELECT id FROM item_logs WHERE user_id = ? AND item_id = ?')
	.get(partner.id, lagavulin.id) as { id: number };

describe('managing a link', () => {
	it('is for the list owner only', () => {
		for (const who of [partner.id, stranger.id]) {
			expect(statusOf(() => links.createShareLink(who, whiskey.id))).not.toBeNull();
			expect(statusOf(() => links.getShareLink(who, whiskey.id))).not.toBeNull();
			expect(statusOf(() => links.turnOffShareLink(who, whiskey.id))).not.toBeNull();
			expect(statusOf(() => links.setShareExpiry(who, whiskey.id, null))).not.toBeNull();
		}
		// A sharee can see the list but may not manage it; a stranger can't even tell it exists
		expect(statusOf(() => links.createShareLink(partner.id, whiskey.id))).toBe(403);
		expect(statusOf(() => links.createShareLink(stranger.id, whiskey.id))).toBe(404);
		// Sharing someone's "view" role is no different
		saveShares(daniel.id, whiskey.id, [{ userId: partner.id, role: 'view' }]);
		expect(statusOf(() => links.createShareLink(partner.id, whiskey.id))).toBe(403);
		saveShares(daniel.id, whiskey.id, [{ userId: partner.id, role: 'edit' }]);
		expect(rawDb().prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
	});

	it('makes a long random token, one active link per list', () => {
		expect(links.getShareLink(daniel.id, whiskey.id, NOW)).toBeNull();
		const a = links.createShareLink(daniel.id, whiskey.id, NOW);
		expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a).toMatchObject({ viewCount: 0, lastViewedAt: null, expiresAt: null, expired: false });
		const b = links.createShareLink(daniel.id, whiskey.id, NOW + 1000);
		expect(b.token).not.toBe(a.token);
		expect(links.getShareLink(daniel.id, whiskey.id, NOW)!.token).toBe(b.token);
		const active = rawDb()
			.prepare('SELECT COUNT(*) AS n FROM share_links WHERE category_id = ? AND revoked_at IS NULL')
			.get(whiskey.id);
		expect(active).toEqual({ n: 1 });
		links.turnOffShareLink(daniel.id, whiskey.id, NOW);
		expect(links.getShareLink(daniel.id, whiskey.id, NOW)).toBeNull();
	});

	it('reads the expiry choices', () => {
		expect(links.parseExpiry('none', '', NOW)).toBeNull();
		expect(links.parseExpiry('7', '', NOW)).toBe(NOW + 7 * DAY);
		expect(links.parseExpiry('30', '', NOW)).toBe(NOW + 30 * DAY);
		const custom = links.parseExpiry('custom', '2026-12-31', NOW) as number;
		expect(new Date(custom).getFullYear()).toBe(2026);
		expect(new Date(custom).getHours()).toBe(23);
		expect(links.parseExpiry('custom', '2026-01-01', NOW)).toBe('invalid'); // already past
		expect(links.parseExpiry('custom', 'soon', NOW)).toBe('invalid');
		expect(links.parseExpiry('yesterday', '', NOW)).toBe('invalid');
	});
});

describe('opening a link', () => {
	it('finds the list by token; revoked, expired, unknown and malformed all look the same', () => {
		const link = links.createShareLink(daniel.id, whiskey.id, NOW);
		expect(links.viewSharedList(link.token, NOW).name).toBe('Whiskey');

		const failures = new Map<string, unknown>();
		const fail = (label: string, token: string, at = NOW) => {
			try {
				links.viewSharedList(token, at);
			} catch (e) {
				failures.set(label, {
					status: (e as { status: number }).status,
					body: (e as { body: unknown }).body
				});
				return;
			}
			failures.set(label, 'opened');
		};
		fail('unknown', 'A'.repeat(43));
		fail('malformed', 'nope');
		fail('empty', '');

		// Expired (and back again when the expiry moves)
		links.setShareExpiry(daniel.id, whiskey.id, NOW + DAY);
		expect(links.viewSharedList(link.token, NOW + DAY - 1).name).toBe('Whiskey');
		fail('expired', link.token, NOW + DAY);
		expect(links.getShareLink(daniel.id, whiskey.id, NOW + 2 * DAY)!.expired).toBe(true);
		links.setShareExpiry(daniel.id, whiskey.id, null);
		expect(links.viewSharedList(link.token, NOW + 2 * DAY).name).toBe('Whiskey');

		// Turned off
		links.turnOffShareLink(daniel.id, whiskey.id, NOW);
		fail('revoked', link.token);

		// Replaced by a new link: only the new one works
		const first = links.createShareLink(daniel.id, whiskey.id, NOW);
		const second = links.createShareLink(daniel.id, whiskey.id, NOW);
		fail('regenerated', first.token);
		expect(links.viewSharedList(second.token, NOW).name).toBe('Whiskey');

		expect(new Set([...failures.values()].map((v) => JSON.stringify(v))).size).toBe(1); // one and the same answer, nothing to tell them apart
		expect([...failures.values()][0]).toMatchObject({ status: 404 });
	});

	it('counts views, at most once a minute', () => {
		const { token } = links.createShareLink(daniel.id, whiskey.id, NOW);
		const info = () => links.getShareLink(daniel.id, whiskey.id, NOW)!;
		links.viewSharedList(token, NOW);
		links.viewSharedList(token, NOW + 30_000); // too soon
		expect(info()).toMatchObject({ viewCount: 1, lastViewedAt: NOW });
		links.viewSharedList(token, NOW + 61_000);
		expect(info()).toMatchObject({ viewCount: 2, lastViewedAt: NOW + 61_000 });
		// Opening an item doesn't count; a refused token doesn't either
		links.viewSharedItem(token, lagavulin.id, NOW + 300_000);
		expect(statusOf(() => links.viewSharedList('B'.repeat(43), NOW + 300_000))).toBe(404);
		expect(info().viewCount).toBe(2);
	});
});

describe('what a visitor sees', () => {
	let token = '';
	beforeAll(() => {
		token = links.createShareLink(daniel.id, whiskey.id, NOW).token;
	});

	it('shows the list through the owner: their statuses and ratings, planned items apart', () => {
		const list = links.viewSharedList(token, NOW);
		expect(list).toMatchObject({
			name: 'Whiskey',
			icon: '🥃',
			owner: 'Daniel',
			itemCount: 3,
			plannedLabel: 'Wishlist'
		});
		const byTitle = Object.fromEntries(list.items.map((i) => [i.title, i]));
		expect(byTitle['Lagavulin 16']).toMatchObject({
			statusLabel: 'Tasted',
			planned: false,
			rating: 90, // Daniel's, not the partner's 20
			favorite: true,
			extra: 'Lagavulin · 16 yrs',
			lastLoggedAt: '2026-10-14'
		});
		expect(byTitle['Pappy Van Winkle']).toMatchObject({ planned: true, statusLabel: 'Wishlist' });
		expect(byTitle['Springbank 21']).toMatchObject({ planned: false, statusLabel: null });
		expect(list.items.filter((i) => i.planned).map((i) => i.title)).toEqual(['Pappy Van Winkle']);
		// Nothing about anyone else, or about other lists
		const text = JSON.stringify(list);
		for (const secret of ['PARTNER', 'Partner', 'partner', 'stranger', 'Barolo', 'Wine']) {
			expect(text).not.toContain(secret);
		}
	});

	it("shows the owner's notes and logs only", () => {
		const item = links.viewSharedItem(token, lagavulin.id, NOW);
		expect(item).toMatchObject({
			title: 'Lagavulin 16',
			subtitle: 'Islay',
			statusLabel: 'Tasted',
			rating: 90,
			favorite: true,
			notes: "Daniel's note on the bottle",
			tags: ['islay', 'smoky'],
			moreLogs: 0,
			listening: null,
			list: { name: 'Whiskey', owner: 'Daniel' }
		});
		expect(item.fields.map((f) => f.label)).toEqual(['Distillery', 'Age', 'ABV', 'Price']);
		expect(item.logs.map((l) => l.date)).toEqual(['2026-10-14', '2026-10-12']);
		expect(item.logs[1]).toMatchObject({
			rating: 80,
			notes: 'Smoke and seaweed',
			location: 'The Snug',
			price: 12.5,
			fields: [
				{ label: 'Nose', value: 'Peat' },
				{ label: 'Palate', value: 'Brine' },
				{ label: 'Finish', value: 'Long' }
			]
		});
		const text = JSON.stringify(item);
		for (const secret of ['PARTNER', 'Partner', 'partner', '777', 'stranger']) {
			expect(text).not.toContain(secret);
		}
		// What the page is given has no user ids, usernames or e-mails either
		const data = JSON.stringify([links.viewSharedList(token, NOW), item]);
		expect(data).not.toContain('daniel"'); // the username (display names only)
		expect(data).not.toMatch(/"(userId|user_id|username|email)"/);
	});

	it('refuses items from other lists, other people and unknown ids', () => {
		for (const id of [wine.id, strangersItem.id, 99_999, -1, 1.5]) {
			expect(statusOf(() => links.viewSharedItem(token, id, NOW))).toBe(404);
		}
		// Through the route too: ids that aren't plain numbers never reach the database
		const args = (p: Record<string, string>) => ({ params: { token, ...p } }) as never;
		expect(statusOf(() => itemLoad(args({ id: String(wine.id) })))).toBe(404);
		expect(statusOf(() => itemLoad(args({ id: '1e3' })))).toBe(404);
		expect(statusOf(() => itemLoad(args({ id: '-1' })))).toBe(404);
		expect(statusOf(() => itemLoad(args({ id: String(lagavulin.id), token: 'x'.repeat(43) })))).toBe(404);
	});

	it('loads through the routes without a session', () => {
		const list = listLoad({ params: { token } } as never) as { token: string; list: { name: string } };
		expect(list.list.name).toBe('Whiskey');
		const item = itemLoad({ params: { token, id: String(lagavulin.id) } } as never) as {
			item: { title: string };
		};
		expect(item.item.title).toBe('Lagavulin 16');
		expect(statusOf(() => listLoad({ params: { token: 'z'.repeat(43) } } as never))).toBe(404);
	});

	it('sums up last.fm listening and caps long histories', () => {
		const album = createItem(daniel.id, { categoryId: whiskey.id, title: 'Pretend album' });
		const stmt = rawDb().prepare(
			`INSERT INTO item_logs (item_id, user_id, date, custom, source, source_key, created_at, notes)
			 VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`
		);
		for (let i = 0; i < 60; i++) {
			stmt.run(
				album.id,
				daniel.id,
				`2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
				null,
				null,
				NOW,
				`by hand ${i}`
			);
		}
		for (let i = 0; i < 40; i++) {
			stmt.run(album.id, daniel.id, '2026-02-02', 'lastfm', `k${i}`, NOW, 'imported');
		}
		rawDb()
			.prepare(
				`INSERT INTO lastfm_albums (user_id, key, artist, title, item_id, plays, last_uts)
				 VALUES (?, 'k', 'A', 'Pretend album', ?, 40, ?)`
			)
			.run(daniel.id, album.id, Math.floor(Date.UTC(2026, 1, 2, 12) / 1000));

		const item = links.viewSharedItem(token, album.id, NOW);
		expect(item.logs).toHaveLength(50);
		expect(item.moreLogs).toBe(10);
		expect(JSON.stringify(item.logs)).not.toContain('imported');
		expect(item.listening).toEqual({ plays: 40, lastPlayed: '2026-02-02' });
	});

	it('shows setlists and episodes of the owner’s logs', () => {
		const band = createItem(daniel.id, { categoryId: whiskey.id, title: 'A band' });
		addLog(
			daniel.id,
			band.id,
			{
				date: '2026-09-01',
				external: {
					setlist: {
						id: 'abc',
						url: 'https://www.setlist.fm/x',
						tour: 'Big Tour',
						songs: [{ name: 'One' }, { name: 'Two', set: 'Encore', cover: 'Someone' }],
						private: 'drop me'
					}
				}
			},
			whiskeyCat.statuses
		);
		const log = links.viewSharedItem(token, band.id, NOW).logs[0];
		expect(log.setlist).toEqual({
			tour: 'Big Tour',
			url: 'https://www.setlist.fm/x',
			songs: [{ name: 'One' }, { name: 'Two', set: 'Encore', cover: 'Someone' }]
		});
	});
});

describe('photos', () => {
	let token = '';
	beforeAll(() => {
		token = links.createShareLink(daniel.id, whiskey.id, NOW).token;
	});
	const photo = addImage(daniel.id, { itemId: lagavulin.id });
	const second = addImage(daniel.id, { itemId: lagavulin.id });
	rawDb().prepare('UPDATE items SET cover_image_id = ? WHERE id = ?').run(second.id, lagavulin.id);
	const myLog = rawDb()
		.prepare('SELECT id FROM item_logs WHERE user_id = ? AND item_id = ? LIMIT 1')
		.get(daniel.id, lagavulin.id) as { id: number };
	const myLogPhoto = addImage(daniel.id, { logId: myLog.id });
	const partnerLogPhoto = addImage(partner.id, { logId: partnerLog.id });
	const wineLog = addLog(daniel.id, wine.id, { date: '2026-10-01' }, whiskeyCat.statuses);
	const winePhoto = addImage(daniel.id, { itemId: wine.id });
	const wineLogPhoto = addImage(daniel.id, { logId: wineLog.id });
	const partnersPhoto = addImage(partner.id, { itemId: strangersItem.id });
	const linked = addImage(
		daniel.id,
		{ itemId: wishItem.id },
		{
			kind: 'url_link',
			path: null,
			thumbPath: null,
			sourceUrl: 'https://example.com/cover.jpg'
		}
	);

	it('serves only photos of the list’s items and of the owner’s logs on them', () => {
		const rel = (img: { id: number }, size: 'thumb' | 'full' = 'full') =>
			links.sharedImageFile(token, img.id, size, NOW);
		expect(rel(photo)).toBe(photo.path);
		expect(rel(photo, 'thumb')).toBe(photo.thumbPath);
		expect(rel(myLogPhoto)).toBe(myLogPhoto.path);
		expect(rel(partnerLogPhoto)).toBeNull(); // a household member's log photo
		expect(rel(winePhoto)).toBeNull(); // another list
		expect(rel(wineLogPhoto)).toBeNull();
		expect(rel(partnersPhoto)).toBeNull(); // another person's list
		expect(rel(linked)).toBeNull(); // linked images load from their own source
		expect(rel({ id: 99_999 })).toBeNull();
		expect(links.sharedImageFile('C'.repeat(43), photo.id, 'full', NOW)).toBeNull();
	});

	it('never serves a path that is not an upload file name', () => {
		const bad = addImage(
			daniel.id,
			{ itemId: lagavulin.id },
			{ path: 'u1/../../etc/passwd', thumbPath: null }
		);
		expect(links.sharedImageFile(token, bad.id, 'full', NOW)).toBeNull();
		expect(links.sharedImageFile(token, bad.id, 'thumb', NOW)).toBeNull();
		rawDb().prepare('DELETE FROM images WHERE id = ?').run(bad.id);
	});

	it('lists photo addresses through the token, the cover first', () => {
		const item = links.viewSharedItem(token, lagavulin.id, NOW);
		expect(item.images.map((i) => i.full)).toEqual([
			`/s/${token}/media/${second.id}`,
			`/s/${token}/media/${photo.id}`
		]);
		expect(item.images[0].thumb).toBe(`/s/${token}/media/${second.id}?size=thumb`);
		const log = item.logs.find((l) => l.images.length)!;
		expect(log.images[0].full).toBe(`/s/${token}/media/${myLogPhoto.id}`);
		expect(JSON.stringify(item)).not.toContain('u1/'); // no storage paths
		// A linked cover goes straight to its source
		const list = links.viewSharedList(token, NOW);
		expect(list.items.find((i) => i.id === wishItem.id)!.cover).toBe('https://example.com/cover.jpg');
		expect(list.items.find((i) => i.id === lagavulin.id)!.cover).toBe(
			`/s/${token}/media/${second.id}?size=thumb`
		);
	});

	it('streams the stored file with private caching, and refuses what it must', async () => {
		const abs = path.join(cfg().uploadsDir, photo.path!);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, Buffer.from('webp-bytes'));
		const ask = async (imageId: number | string, t = token, query = '') =>
			mediaGet({
				params: { token: t, imageId: String(imageId) },
				url: new URL(`http://x/s/${t}/media/${imageId}${query}`),
				request: new Request('http://x/')
			} as never);

		const ok = await ask(photo.id);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('cache-control')).toBe('private, max-age=3600');
		expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('webp-bytes');

		const gone = await ask(second.id).catch((e) => e); // row is fine, file missing
		expect(gone.status).toBe(404);
		for (const bad of [winePhoto.id, partnerLogPhoto.id, linked.id, 'abc', '1e2', '-3']) {
			const r = await ask(bad).catch((e) => e);
			expect(r.status).toBe(404);
		}
		const wrongToken = await ask(photo.id, 'D'.repeat(43)).catch((e) => e);
		expect(wrongToken.status).toBe(404);

		// Turned off: the photo stops being served at once
		links.turnOffShareLink(daniel.id, whiskey.id, NOW);
		const off = await ask(photo.id).catch((e) => e);
		expect(off.status).toBe(404);
	});
});

describe('deleting', () => {
	it('removes links with their list', () => {
		const list = createCategoryFromTemplate(daniel.id, 'cheese');
		const { token } = links.createShareLink(daniel.id, list.id);
		rawDb().prepare('DELETE FROM categories WHERE id = ?').run(list.id);
		expect(rawDb().prepare('SELECT COUNT(*) AS n FROM share_links WHERE token = ?').get(token)).toEqual({
			n: 0
		});
	});
});
