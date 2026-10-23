import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lastfm-'));
	return {
		env: {
			DATA_DIR: dir,
			MIGRATIONS_DIR: path.resolve('drizzle'),
			LASTFM_API_KEY: 'abcdef0123456789abcdef0123456789'
		}
	};
});

const { db, rawDb, schema } = await import('./db');
const categories = await import('./services/categories');
const items = await import('./services/items');
const access = await import('./services/access');
const sync = await import('./services/lastfm-sync');
const { setLastfmMinInterval, lastfm } = await import('./providers/lastfm');
const { albumKey, lastfmAlbumId } = await import('./album-match');
const { hasListeningLogs } = await import('./services/journal');
const { env } = await import('$env/dynamic/private');
const { GET: statusApi } = await import('../../routes/api/lastfm/status/+server');

setLastfmMinInterval(0);

// --- A fake last.fm ---------------------------------------------------------------------------

interface Play {
	uts: number;
	artist: string;
	album: string;
	track: string;
	mbid?: string;
}

const server = {
	plays: new Map<string, Play[]>(),
	private: new Set<string>(),
	/** Returns a response to replace the real answer, or undefined */
	hook: null as null | ((method: string, url: URL) => Response | undefined),
	/** Every user.getRecentTracks request made */
	recent: [] as URL[],
	/** A "now playing" entry sits on top of the newest page */
	nowPlaying: false
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function trackJson(p: Play) {
	return {
		artist: { '#text': p.artist, mbid: '' },
		album: { '#text': p.album, mbid: p.mbid ?? '' },
		name: p.track,
		image: p.album
			? [{ size: 'extralarge', '#text': `https://img.example/${encodeURIComponent(p.album)}.png` }]
			: [],
		date: { uts: String(p.uts), '#text': 'x' }
	};
}

function fakeLastfm(input: string | URL): Response {
	const url = new URL(String(input));
	const method = url.searchParams.get('method') ?? '';
	const user = url.searchParams.get('user') ?? '';
	const hooked = server.hook?.(method, url);
	if (hooked) return hooked;
	if (method === 'user.getInfo') {
		const known = [...server.plays.keys()].find((k) => k.toLowerCase() === user.toLowerCase());
		if (!known) return json({ error: 6, message: 'User not found' }, 404);
		return json({ user: { name: known, playcount: '1000', registered: { unixtime: '1100000000' } } });
	}
	if (method === 'user.getRecentTracks') {
		server.recent.push(url);
		if (server.private.has(user))
			return json({ error: 17, message: 'Login: User required to be logged in' }, 403);
		const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : 0;
		const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : Infinity;
		const limit = Number(url.searchParams.get('limit') ?? 50);
		const all = (server.plays.get(user) ?? [])
			.filter((p) => p.uts >= from && p.uts <= to)
			.sort((a, b) => b.uts - a.uts);
		const pageNo = Number(url.searchParams.get('page') ?? 1);
		const np = server.nowPlaying && pageNo === 1 && to >= Math.floor(Date.now() / 1000);
		const take = np ? limit - 1 : limit;
		const page = all.slice((pageNo - 1) * limit, (pageNo - 1) * limit + take).map(trackJson);
		const tracks: unknown[] = np
			? [
					{
						artist: { '#text': 'Someone' },
						name: 'Now',
						album: { '#text': 'Live' },
						'@attr': { nowplaying: 'true' }
					},
					...page
				]
			: page;
		return json({
			recenttracks: {
				track: tracks.length === 1 ? tracks[0] : tracks,
				'@attr': { total: String(all.length) }
			}
		});
	}
	return json({ error: 3, message: 'Invalid Method' }, 400);
}

// --- Fixtures -----------------------------------------------------------------------------------

const NOW = new Date(2024, 5, 10, 18, 0, 0); // Mon 10 Jun 2024, 18:00 local
const nowS = () => Math.floor(Date.now() / 1000);
const local = (y: number, mo: number, d: number, h = 12, mi = 0) =>
	Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
const dayOf = (uts: number) => {
	const d = new Date(uts * 1000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

beforeEach(() => {
	// A fresh limiter each time: the clock jumps around between tests
	setLastfmMinInterval(0);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	server.plays.clear();
	server.private.clear();
	server.hook = null;
	server.recent = [];
	server.nowPlaying = false;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => fakeLastfm(input))
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

let seq = 0;
function person(name?: string) {
	const username = name ?? `person${++seq}`;
	const user = db()
		.insert(schema.users)
		.values({ username, displayName: username.toUpperCase(), passwordHash: 'x' })
		.returning()
		.get();
	return user;
}

/** A person with an Albums list */
function listener() {
	const user = person();
	const list = categories.createCategoryFromTemplate(user.id, 'albums');
	const lfm = `fm${user.id}`; // their last.fm username
	return { user, list, lfm };
}

/** `n` plays, 10 minutes apart going back from an hour ago, spread over `albums` albums */
function history(n: number, albums = 30, start = nowS() - 3600): Play[] {
	return Array.from({ length: n }, (_, i) => ({
		uts: start - i * 600,
		artist: `Artist ${i % albums}`,
		album: `Album ${i % albums}`,
		track: `Track ${i}`
	}));
}

async function connect(who: { user: { id: number }; list: { id: number }; lfm: string }) {
	return sync.connectLastfm(who.user.id, { username: who.lfm, categoryId: who.list.id });
}

/** Reads pages until the window is done (or something stops it) */
async function drain(userId: number, max = 60) {
	let last: string = 'more';
	for (let i = 0; i < max && last === 'more'; i++) last = await sync.runPage(userId);
	return last;
}

/** The history requests made for the import itself (not the one-play probe made on connect) */
const pages = () => server.recent.filter((u) => u.searchParams.get('limit') === '200');

const account = (userId: number) =>
	db().select().from(schema.lastfmAccounts).where(eq(schema.lastfmAccounts.userId, userId)).get();

const count = (sql: string, ...args: unknown[]) =>
	(
		rawDb()
			.prepare(sql)
			.get(...args) as { n: number }
	).n;
const logsOf = (userId: number) =>
	rawDb()
		.prepare(
			`SELECT l.id, l.item_id AS itemId, l.date, l.external, l.source_key AS key, i.title FROM item_logs l
			 JOIN items i ON i.id = l.item_id WHERE l.user_id = ? AND l.source = 'lastfm' ORDER BY i.title, l.date`
		)
		.all(userId) as {
		id: number;
		itemId: number;
		date: string;
		external: string;
		key: string;
		title: string;
	}[];
const albumRow = (userId: number, title: string) =>
	rawDb()
		.prepare(
			`SELECT id, item_id AS itemId, linked_at AS linkedAt, created_item AS createdItem, promoted, status_before AS statusBefore,
				plays FROM lastfm_albums WHERE user_id = ? AND title = ?`
		)
		.get(userId, title) as {
		id: number;
		itemId: number | null;
		linkedAt: number | null;
		createdItem: number;
		promoted: number;
		statusBefore: string | null;
		plays: number;
	};
const itemByTitle = (categoryId: number, title: string) =>
	db()
		.select()
		.from(schema.items)
		.where(eq(schema.items.title, title))
		.all()
		.find((i) => i.categoryId === categoryId);
const itemCount = (categoryId: number) =>
	count('SELECT COUNT(*) AS n FROM items WHERE category_id = ?', categoryId);

// --- 1-5: the backfill ---------------------------------------------------------------------------

describe('backfill', () => {
	it('imports a 3-page history into items, covers, statuses and one log per album per day', async () => {
		const w = listener();
		const plays = history(450);
		server.plays.set(w.lfm, plays);
		await connect(w);
		expect(await drain(w.user.id)).toBe('done');
		expect(pages()).toHaveLength(3);
		expect(itemCount(w.list.id)).toBe(30);

		const a0 = itemByTitle(w.list.id, 'Album 0')!;
		expect(a0.provider).toBe('lastfm');
		expect(a0.providerKind).toBe('album');
		expect(a0.subtitle).toBe('Artist 0');
		expect(a0.status).toBe('listened');
		const cover = db().select().from(schema.images).where(eq(schema.images.id, a0.coverImageId!)).get();
		expect(cover).toMatchObject({ kind: 'url_link', sourceUrl: 'https://img.example/Album%200.png' });

		// One log per (album, local day), carrying that day's play count
		const expected = new Map<string, number>();
		for (const p of plays) {
			const k = `${p.album}|${dayOf(p.uts)}`;
			expected.set(k, (expected.get(k) ?? 0) + 1);
		}
		const logs = logsOf(w.user.id);
		expect(logs).toHaveLength(expected.size);
		for (const l of logs) {
			expect(JSON.parse(l.external)).toEqual({ lastfm: { plays: expected.get(`${l.title}|${l.date}`) } });
		}
		expect(logs.reduce((s, l) => s + JSON.parse(l.external).lastfm.plays, 0)).toBe(450);

		const acct = account(w.user.id)!;
		expect(acct.job).toBeNull();
		expect(acct.syncedUntil).toBe(nowS());
		expect(acct.backfilledAt).not.toBeNull();
		expect(acct.plays).toBe(450);
		expect(acct.albums).toBe(30);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(450);
		expect(albumRow(w.user.id, 'Album 0').plays).toBe(15);
		expect(sync.getLastfmAccount(w.user.id)).toMatchObject({
			state: 'idle',
			plays: 450,
			albums: 30,
			backfilled: true
		});
	});

	it('skips "now playing" and plays without an album, and keeps going past the now-playing page', async () => {
		const w = listener();
		const plays = [...history(400, 20), { uts: nowS() - 30, artist: 'Nobody', album: '', track: 'Single' }];
		server.plays.set(w.lfm, plays);
		server.nowPlaying = true;
		await connect(w);
		expect(await drain(w.user.id)).toBe('done');
		// 400 real plays with an album; the single (no album) and the now-playing entry are not stored
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(400);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(20);
		expect(itemByTitle(w.list.id, 'Live')).toBeUndefined();
		expect(itemByTitle(w.list.id, 'Single')).toBeUndefined();
	});

	it('uses the server-local day: 23:30 and 00:30 are two logs', async () => {
		const w = listener();
		const late = local(2024, 6, 5, 23, 30);
		const early = local(2024, 6, 6, 0, 30);
		server.plays.set(w.lfm, [
			{ uts: early, artist: 'Band', album: 'Night', track: 'B' },
			{ uts: late, artist: 'Band', album: 'Night', track: 'A' }
		]);
		await connect(w);
		await drain(w.user.id);
		const logs = logsOf(w.user.id);
		expect(logs.map((l) => l.date)).toEqual([dayOf(late), dayOf(early)]);
		expect(dayOf(late)).not.toBe(dayOf(early));
		expect(logs.every((l) => JSON.parse(l.external).lastfm.plays === 1)).toBe(true);
	});

	it('resumes after a failed page and ends with the same data as an uninterrupted run', async () => {
		const plays = history(450);
		const clean = listener();
		server.plays.set(clean.lfm, plays);
		await connect(clean);
		await drain(clean.user.id);

		const w = listener();
		server.plays.set(w.lfm, plays);
		await connect(w);
		// The second history request fails like a dropped connection
		let n = 0;
		server.hook = (method) => {
			if (method === 'user.getRecentTracks' && ++n === 2) throw new TypeError('fetch failed');
		};
		expect(await drain(w.user.id)).toBe('idle');
		let acct = account(w.user.id)!;
		expect(acct.job).toBe('backfill');
		expect(acct.errorCode).toBe('unreachable');
		expect(acct.jobDone).toBe(200);
		expect(acct.nextSyncAt).toBeGreaterThan(Date.now());
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(200);
		// Too early: nothing happens until the retry time
		expect(await sync.runPage(w.user.id)).toBe('idle');

		vi.setSystemTime(Date.now() + 61_000);
		server.hook = null;
		expect(await drain(w.user.id)).toBe('done');
		acct = account(w.user.id)!;
		expect(acct.errorCode).toBeNull();
		expect(acct.errorCount).toBe(0);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(450);
		expect(itemCount(w.list.id)).toBe(itemCount(clean.list.id));
		const shape = (id: number) => logsOf(id).map((l) => `${l.title}|${l.date}|${l.external}`);
		expect(shape(w.user.id)).toEqual(shape(clean.user.id));
	});

	it('changes nothing when the same plays arrive again', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(120, 10));
		await connect(w);
		await drain(w.user.id);
		const before = {
			logs: logsOf(w.user.id),
			items: itemCount(w.list.id),
			plays: count('SELECT COUNT(*) AS n FROM lastfm_scrobbles')
		};
		const again = [...(server.plays.get(w.lfm) ?? [])].map((p) => ({
			uts: p.uts,
			artist: p.artist,
			albumMbid: null,
			album: p.album,
			track: p.track,
			artistMbid: null,
			imageUrl: null
		}));
		expect(sync.applyScrobbles(w.user.id, again).inserted).toBe(0);
		expect(logsOf(w.user.id)).toEqual(before.logs);
		expect(itemCount(w.list.id)).toBe(before.items);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles')).toBe(before.plays);
	});
});

// --- 6: incremental sync -----------------------------------------------------------------------

describe('incremental sync', () => {
	it('asks only for plays after the watermark and adds to the existing day log', async () => {
		const w = listener();
		const first = nowS() - 3600; // 17:00 today
		server.plays.set(w.lfm, [{ uts: first, artist: 'Band', album: 'Record', track: 'One' }]);
		await connect(w);
		await drain(w.user.id);
		const log = logsOf(w.user.id)[0];
		expect(JSON.parse(log.external)).toEqual({ lastfm: { plays: 1 } });
		const watermark = account(w.user.id)!.syncedUntil;
		expect(watermark).toBe(nowS());

		// Not due yet
		expect(await sync.runPage(w.user.id)).toBe('idle');

		vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000)); // 19:01
		server.plays.get(w.lfm)!.push({ uts: nowS() - 600, artist: 'Band', album: 'Record', track: 'Two' });
		server.recent = [];
		expect(await drain(w.user.id)).toBe('done');
		expect(pages()).toHaveLength(1);
		// Each sync starts two days before the watermark, to catch plays submitted late
		expect(pages()[0].searchParams.get('from')).toBe(String(watermark - 2 * 86_400 + 1));

		const after = logsOf(w.user.id);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(log.id);
		expect(JSON.parse(after[0].external)).toEqual({ lastfm: { plays: 2 } });
		expect(account(w.user.id)!.syncedUntil).toBe(nowS());
		expect(albumRow(w.user.id, 'Record').plays).toBe(2);
	});

	it('syncs daily when asked to', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(5, 2));
		await connect(w);
		await drain(w.user.id);
		expect(account(w.user.id)!.nextSyncAt).toBe(Date.now() + 3_600_000);
		sync.updateLastfmSettings(w.user.id, { syncEvery: 'daily', journalMode: 'hide' });
		expect(account(w.user.id)).toMatchObject({ syncEvery: 'daily', journalMode: 'hide' });
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
		await drain(w.user.id);
		expect(account(w.user.id)!.nextSyncAt).toBe(Date.now() + 24 * 3_600_000);
	});
});

describe('late scrobbles', () => {
	const DAY_S = 86_400;
	const HOUR_MS = 3_600_000;
	const plays = (userId: number) =>
		count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', userId);

	it('picks up a play submitted late inside the two-day window, without duplicating anything', async () => {
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 3600, artist: 'Band', album: 'Record', track: 'One' }]);
		await connect(w);
		await drain(w.user.id);
		const watermark = account(w.user.id)!.syncedUntil;
		expect(logsOf(w.user.id)).toHaveLength(1);

		// A phone syncs an hour later: the play happened yesterday afternoon
		vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
		const late = watermark - DAY_S;
		server.plays.get(w.lfm)!.push({ uts: late, artist: 'Band', album: 'Record', track: 'Late' });
		server.recent = [];
		expect(await drain(w.user.id)).toBe('done');
		expect(pages()[0].searchParams.get('from')).toBe(String(watermark - 2 * DAY_S + 1));

		const logs = logsOf(w.user.id);
		expect(logs).toHaveLength(2);
		expect(logs.map((l) => l.date)).toEqual([dayOf(late), dayOf(watermark - 3600)].sort());
		expect(logs.map((l) => JSON.parse(l.external).lastfm.plays)).toEqual([1, 1]);
		expect(albumRow(w.user.id, 'Record').plays).toBe(2);
		expect(plays(w.user.id)).toBe(2);

		// The next sync re-reads both plays and changes nothing
		vi.setSystemTime(new Date(NOW.getTime() + 123 * 60_000));
		expect(await drain(w.user.id)).toBe('done');
		expect(logsOf(w.user.id)).toEqual(logs);
		expect(albumRow(w.user.id, 'Record').plays).toBe(2);
		expect(plays(w.user.id)).toBe(2);
		expect(itemCount(w.list.id)).toBe(1);
	});

	it('looks two weeks back once a day, and only then finds a play older than two days', async () => {
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 3600, artist: 'Band', album: 'Record', track: 'One' }]);
		await connect(w);
		await drain(w.user.id);
		const watermark = account(w.user.id)!.syncedUntil;

		const old = watermark - 5 * DAY_S;
		server.plays.get(w.lfm)!.push({ uts: old, artist: 'Band', album: 'Record', track: 'Old' });

		// An hour later: the normal window doesn't reach it
		vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
		await drain(w.user.id);
		expect(plays(w.user.id)).toBe(1);

		// A day later: the daily deep look reaches fourteen days back
		vi.setSystemTime(new Date(NOW.getTime() + 25 * HOUR_MS));
		const before = account(w.user.id)!.syncedUntil;
		server.recent = [];
		await drain(w.user.id);
		expect(pages()[0].searchParams.get('from')).toBe(String(before - 14 * DAY_S + 1));
		expect(plays(w.user.id)).toBe(2);
		expect(logsOf(w.user.id).map((l) => l.date)).toContain(dayOf(old));
		expect(account(w.user.id)!.deepSyncAt).toBe(Date.now());

		// …and the next sync is shallow again
		vi.setSystemTime(new Date(NOW.getTime() + 27 * HOUR_MS));
		const synced = account(w.user.id)!.syncedUntil;
		server.recent = [];
		await drain(w.user.id);
		expect(pages()[0].searchParams.get('from')).toBe(String(synced - 2 * DAY_S + 1));
		expect(plays(w.user.id)).toBe(2);
	});

	it('does not reach before the beginning of time on a young account', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(3, 1));
		await connect(w);
		await drain(w.user.id);
		db()
			.update(schema.lastfmAccounts)
			.set({ syncedUntil: 1000, deepSyncAt: 0 })
			.where(eq(schema.lastfmAccounts.userId, w.user.id))
			.run();
		vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR_MS));
		server.recent = [];
		await drain(w.user.id);
		expect(pages()[0].searchParams.has('from')).toBe(false);
	});
});

describe('filling in album details', () => {
	const info = (name: string, artist: string) => ({
		album: {
			name,
			artist,
			url: `https://www.last.fm/music/${artist}/${name}`,
			image: [{ size: 'extralarge', '#text': `https://img.example/better-${name}.png` }],
			listeners: '1200',
			playcount: '34000',
			tags: { tag: [{ name: 'indie rock' }, { name: 'Seen Live' }, { name: '2001' }, { name: 'dream pop' }] },
			tracks: { track: [{ duration: '200' }, { duration: '100' }] },
			wiki: { summary: 'A quiet record. <a href="https://www.last.fm/x">Read more on Last.fm</a>' }
		}
	});
	const itemMeta = (id: number) => {
		const r = rawDb()
			.prepare('SELECT metadata, description, cover_image_id AS cover FROM items WHERE id = ?')
			.get(id) as { metadata: string; description: string | null; cover: number | null };
		return { ...r, meta: JSON.parse(r.metadata) as Record<string, unknown> };
	};
	/** Marks every other pending album done, so a test only sees its own */
	const settleOthers = () =>
		rawDb()
			.prepare(
				`UPDATE items SET metadata = json_set(metadata, '$.enriched', json('true'))
				 WHERE provider = 'lastfm' AND json_extract(metadata, '$.enriched') = 0`
			)
			.run();

	it('adds genres, a description and facts, and marks the album done', async () => {
		settleOthers();
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 60, artist: 'Slowdive', album: 'Souvlaki', track: 'Alison' }]);
		await connect(w);
		await drain(w.user.id);
		const item = itemByTitle(w.list.id, 'Souvlaki')!;
		expect(itemMeta(item.id).meta.enriched).toBe(false);

		server.hook = (method) => (method === 'album.getInfo' ? json(info('Souvlaki', 'Slowdive')) : undefined);
		expect(await sync.enrichNext()).toBe(true);
		const after = itemMeta(item.id);
		expect(after.meta).toMatchObject({
			enriched: true,
			genres: ['indie rock', 'dream pop'],
			artist: 'Slowdive'
		});
		expect(after.description).toBe('A quiet record.');
		const facts = after.meta.facts as { label: string }[];
		expect(facts.map((f) => f.label)).toEqual([
			'Artist',
			'Tracks',
			'Length',
			'Listeners',
			'Scrobbles worldwide'
		]);
		// The cover from the plays stays; there is nothing more to do
		expect(after.cover).not.toBeNull();
		expect(await sync.enrichNext()).toBe(false);
	});

	it('keeps an existing description and cover, and adds a cover when there is none', async () => {
		settleOthers();
		const w = listener();
		server.plays.set(w.lfm, [
			{ uts: nowS() - 60, artist: 'Band', album: 'Has Words', track: 'a' },
			{ uts: nowS() - 120, artist: 'Band', album: 'No Cover', track: 'b' }
		]);
		await connect(w);
		await drain(w.user.id);
		const words = itemByTitle(w.list.id, 'Has Words')!;
		const bare = itemByTitle(w.list.id, 'No Cover')!;
		const before = itemMeta(words.id).cover;
		rawDb().prepare("UPDATE items SET description = 'Mine' WHERE id = ?").run(words.id);
		rawDb().prepare('UPDATE items SET cover_image_id = NULL WHERE id = ?').run(bare.id);
		rawDb().prepare('DELETE FROM images WHERE item_id = ?').run(bare.id);

		server.hook = (method, url) =>
			method === 'album.getInfo' ? json(info(url.searchParams.get('album')!, 'Band')) : undefined;
		while (await sync.enrichNext());
		expect(itemMeta(words.id)).toMatchObject({ description: 'Mine', cover: before });
		const filled = itemMeta(bare.id);
		expect(filled.description).toBe('A quiet record.');
		const cover = rawDb()
			.prepare('SELECT kind, source_url AS url FROM images WHERE id = ?')
			.get(filled.cover!);
		expect(cover).toEqual({ kind: 'url_link', url: 'https://img.example/better-No Cover.png' });
	});

	it('marks an album last.fm does not know as done, and tries again after a temporary error', async () => {
		settleOthers();
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 60, artist: 'Nobody', album: 'Unlisted', track: 'x' }]);
		await connect(w);
		await drain(w.user.id);
		const item = itemByTitle(w.list.id, 'Unlisted')!;

		server.hook = (method) =>
			method === 'album.getInfo' ? json({ error: 16, message: 'Temporary error' }, 500) : undefined;
		expect(await sync.enrichNext()).toBe(false);
		expect(itemMeta(item.id).meta.enriched).toBe(false);

		server.hook = (method) =>
			method === 'album.getInfo' ? json({ error: 6, message: 'Album not found' }, 404) : undefined;
		expect(await sync.enrichNext()).toBe(true);
		const done = itemMeta(item.id);
		expect(done.meta).toMatchObject({ enriched: true, genres: [] });
		expect(done.description).toBeNull();
		expect(await sync.enrichNext()).toBe(false);
	});

	it('runs from the scheduler once nothing is being imported', async () => {
		settleOthers();
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 60, artist: 'Slowdive', album: 'Just For A Day', track: 'x' }]);
		await connect(w);
		server.hook = (method) =>
			method === 'album.getInfo' ? json(info('Just For A Day', 'Slowdive')) : undefined;
		await sync.lastfmTick(5_000);
		expect(itemMeta(itemByTitle(w.list.id, 'Just For A Day')!.id).meta.enriched).toBe(true);
	});
});

// --- 7-8: matching ------------------------------------------------------------------------------

describe('matching', () => {
	it('reuses a MusicBrainz and a hand-added item, but keeps editions separate', async () => {
		const w = listener();
		const mb = items.createItem(w.user.id, {
			categoryId: w.list.id,
			title: 'OK Computer',
			subtitle: 'Radiohead · 1997 · Album',
			status: 'to-listen',
			provider: 'musicbrainz',
			providerKind: 'album',
			providerId: 'mb-1'
		});
		const hand = items.createItem(w.user.id, {
			categoryId: w.list.id,
			title: 'In Rainbows',
			subtitle: 'Radiohead'
		});
		server.plays.set(w.lfm, [
			{ uts: nowS() - 100, artist: 'Radiohead', album: 'OK Computer', track: 'Airbag' },
			{ uts: nowS() - 200, artist: 'Radiohead', album: 'In Rainbows', track: 'Nude' },
			{ uts: nowS() - 300, artist: 'Radiohead', album: 'OK Computer (Deluxe Edition)', track: 'Lucky' }
		]);
		await connect(w);
		await drain(w.user.id);

		expect(albumRow(w.user.id, 'OK Computer')).toMatchObject({
			itemId: mb.id,
			createdItem: 0,
			promoted: 1,
			statusBefore: 'to-listen'
		});
		expect(albumRow(w.user.id, 'In Rainbows')).toMatchObject({
			itemId: hand.id,
			createdItem: 0,
			promoted: 1,
			statusBefore: null
		});
		const deluxe = albumRow(w.user.id, 'OK Computer (Deluxe Edition)');
		expect(deluxe.itemId).not.toBeNull();
		expect([mb.id, hand.id]).not.toContain(deluxe.itemId);
		expect(deluxe.createdItem).toBe(1);
		expect(itemCount(w.list.id)).toBe(3);
		expect(items.getItem(w.user.id, mb.id).status).toBe('listened');
		expect(items.getItem(w.user.id, hand.id).status).toBe('listened');
		// The matched item keeps its MusicBrainz identity
		expect(items.getItem(w.user.id, mb.id).provider).toBe('musicbrainz');
	});

	it('keeps a compilation with an album mbid on one album row', async () => {
		const w = listener();
		server.plays.set(w.lfm, [
			{ uts: nowS() - 100, artist: 'Band A', album: 'Now That’s Music', track: 'a', mbid: 'comp-1' },
			{ uts: nowS() - 200, artist: 'Band B', album: 'Now That’s Music', track: 'b', mbid: 'comp-1' },
			{ uts: nowS() - 300, artist: 'Band C', album: 'Now That’s Music', track: 'c', mbid: 'comp-1' }
		]);
		await connect(w);
		await drain(w.user.id);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(1);
		expect(albumRow(w.user.id, 'Now That’s Music').plays).toBe(3);
		expect(itemCount(w.list.id)).toBe(1);
	});
});

// --- 9-10: sharing and list access --------------------------------------------------------------

describe('shared lists', () => {
	function shared() {
		const owner = person();
		const list = categories.createCategoryFromTemplate(owner.id, 'albums');
		const importer = person();
		access.saveShares(owner.id, list.id, [{ userId: importer.id, role: 'edit' }]);
		return { owner, importer, list, lfm: `fm${importer.id}` };
	}

	it('puts items on the owner, the importer’s progress in item_progress, and shows plays to the owner', async () => {
		const s = shared();
		const known = items.createItem(s.owner.id, {
			categoryId: s.list.id,
			title: 'Album 1',
			subtitle: 'Artist 1',
			status: 'owned'
		});
		server.plays.set(s.lfm, history(40, 4));
		await sync.connectLastfm(s.importer.id, { username: s.lfm, categoryId: s.list.id });
		await drain(s.importer.id);

		expect(itemCount(s.list.id)).toBe(4);
		for (const i of db()
			.select()
			.from(schema.items)
			.all()
			.filter((x) => x.categoryId === s.list.id)) {
			expect(i.userId).toBe(s.owner.id);
		}
		// The owner's own status is untouched (here: set by hand; elsewhere: still empty)
		expect(items.getItem(s.owner.id, known.id).status).toBe('owned');
		expect(items.getItem(s.owner.id, itemByTitle(s.list.id, 'Album 0')!.id).status).toBeNull();
		expect(items.getItem(s.owner.id, itemByTitle(s.list.id, 'Album 0')!.id).lastLoggedAt).toBeNull();
		// The importer's is theirs
		const mine = items.getItem(s.importer.id, itemByTitle(s.list.id, 'Album 0')!.id);
		expect(mine.status).toBe('listened');
		expect(mine.lastLoggedAt).not.toBeNull();
		const prog = db()
			.select()
			.from(schema.itemProgress)
			.all()
			.filter((p) => p.userId === s.importer.id);
		expect(prog).toHaveLength(4);
		expect(prog.every((p) => p.status === 'listened' && p.lastLoggedAt)).toBe(true);
		expect(
			db()
				.select()
				.from(schema.itemProgress)
				.all()
				.some((p) => p.userId === s.owner.id)
		).toBe(false);
		// The logs are the importer's
		expect(
			count('SELECT COUNT(*) AS n FROM item_logs WHERE user_id = ? AND source = ?', s.owner.id, 'lastfm')
		).toBe(0);
		expect(logsOf(s.importer.id).length).toBeGreaterThan(0);
		// …and the owner sees the importer's plays on the household card
		const detail = items.getItemDetail(s.owner.id, itemByTitle(s.list.id, 'Album 0')!.id);
		expect(detail.household).toHaveLength(1);
		expect(detail.household[0]).toMatchObject({ name: s.importer.displayName, plays: 10 });
		expect(detail.listening).toBeNull();
		expect(items.getItemDetail(s.importer.id, itemByTitle(s.list.id, 'Album 0')!.id).listening).toMatchObject(
			{ plays: 10 }
		);
	});

	it('offers only lists the person can add to', async () => {
		const owner = person();
		const view = categories.createCategoryFromTemplate(owner.id, 'albums');
		const edit = categories.createCategoryFromTemplate(owner.id, 'movies');
		const friend = person();
		access.saveShares(owner.id, view.id, [{ userId: friend.id, role: 'view' }]);
		access.saveShares(owner.id, edit.id, [{ userId: friend.id, role: 'edit' }]);
		const mine = categories.createCategoryFromTemplate(friend.id, 'whiskey');
		const albums = categories.createCategoryFromTemplate(friend.id, 'albums');
		const lists = sync.lastfmTargetLists(friend.id);
		const ids = lists.map((l) => l.id);
		expect(ids).not.toContain(view.id);
		expect(ids).toEqual(expect.arrayContaining([edit.id, mine.id, albums.id]));
		// Album lists first, the person's own default
		expect(lists[0]).toMatchObject({ id: albums.id, isDefault: true, hasAlbumKind: true });
		expect(lists.find((l) => l.id === edit.id)).toMatchObject({ own: false, ownerName: owner.displayName });
		server.plays.set('friendfm', history(3, 1));
		await expect(
			sync.connectLastfm(friend.id, { username: 'friendfm', categoryId: view.id })
		).rejects.toThrow(/can't add albums/);
	});

	it('keeps recording plays when the list is lost, and catches up once there is one again', async () => {
		const s = shared();
		server.plays.set(s.lfm, history(450, 12));
		await sync.connectLastfm(s.importer.id, { username: s.lfm, categoryId: s.list.id });
		expect(await sync.runPage(s.importer.id)).toBe('more');
		const before = itemCount(s.list.id);
		expect(before).toBe(12);

		// Unshared mid-import, with albums the first page didn't have yet
		access.saveShares(s.owner.id, s.list.id, [{ userId: s.importer.id, role: null }]);
		server.plays.get(s.lfm)!.forEach((p, i) => {
			if (i >= 200) {
				p.artist = `Late Artist`;
				p.album = `Late ${i % 5}`;
			}
		});
		expect(await drain(s.importer.id)).toBe('done');
		const acct = account(s.importer.id)!;
		expect(acct.errorCode).toBe('list');
		expect(acct.errorMessage).toMatch(/can't add to 'Albums' any more/);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', s.importer.id)).toBe(450);
		expect(itemCount(s.list.id)).toBe(before); // nothing new was created
		expect(sync.getLastfmAccount(s.importer.id)!.error).toMatchObject({ code: 'list' });
		expect(
			count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ? AND item_id IS NULL', s.importer.id)
		).toBe(5);

		// A list of their own to catch up into
		const own = categories.createCategoryFromTemplate(s.importer.id, 'albums');
		sync.updateLastfmSettings(s.importer.id, { categoryId: own.id });
		expect(account(s.importer.id)!.errorCode).toBeNull();
		expect(itemCount(own.id)).toBe(5);
		expect(logsOf(s.importer.id).length).toBeGreaterThan(5);
		expect(sync.getLastfmAccount(s.importer.id)).toMatchObject({
			categoryId: own.id,
			categoryName: 'Albums'
		});
	});
});

// --- 11: statuses -------------------------------------------------------------------------------

describe('statuses', () => {
	it('only moves empty or planned statuses to the first done status', async () => {
		const w = listener();
		const owned = items.createItem(w.user.id, {
			categoryId: w.list.id,
			title: 'Owned One',
			subtitle: 'A',
			status: 'owned'
		});
		const planned = items.createItem(w.user.id, {
			categoryId: w.list.id,
			title: 'Planned One',
			subtitle: 'A',
			status: 'to-listen'
		});
		const bare = items.createItem(w.user.id, { categoryId: w.list.id, title: 'Bare One', subtitle: 'A' });
		server.plays.set(
			w.lfm,
			['Owned One', 'Planned One', 'Bare One'].map((t, i) => ({
				uts: nowS() - 100 * (i + 1),
				artist: 'A',
				album: t,
				track: t
			}))
		);
		await connect(w);
		await drain(w.user.id);
		expect(items.getItem(w.user.id, owned.id).status).toBe('owned');
		expect(items.getItem(w.user.id, planned.id).status).toBe('listened');
		expect(items.getItem(w.user.id, bare.id).status).toBe('listened');
		expect(albumRow(w.user.id, 'Owned One').promoted).toBe(0);
		expect(albumRow(w.user.id, 'Planned One')).toMatchObject({ promoted: 1, statusBefore: 'to-listen' });
		// The play still became a log on the owned one
		expect(logsOf(w.user.id).map((l) => l.title)).toContain('Owned One');
	});

	it('leaves the status alone in a list that has no done status', async () => {
		const user = person();
		const list = categories.createCategory(user.id, {
			name: 'Shelf',
			icon: '💿',
			color: 'teal',
			statuses: [
				{ key: 'want', label: 'Want', group: 'planned' },
				{ key: 'have', label: 'Have', group: 'active' }
			],
			providerKinds: []
		});
		server.plays.set('shelffm', history(6, 3));
		await sync.connectLastfm(user.id, { username: 'shelffm', categoryId: list.id });
		await drain(user.id);
		expect(itemCount(list.id)).toBe(3);
		const rows = db()
			.select()
			.from(schema.items)
			.all()
			.filter((i) => i.categoryId === list.id);
		expect(rows.every((i) => i.status === null)).toBe(true);
		expect(logsOf(user.id).length).toBeGreaterThan(0);
		expect(
			db()
				.select()
				.from(schema.categories)
				.all()
				.find((c) => c.id === list.id)!.providerKinds
		).toContain('lastfm:album');
	});
});

// --- 12: deleted items --------------------------------------------------------------------------

describe('deleted albums', () => {
	it('stay deleted until they are re-added, with logs for all their days', async () => {
		const w = listener();
		const plays = [
			{ uts: local(2024, 6, 1), artist: 'Band', album: 'Gone', track: 'a' },
			{ uts: local(2024, 6, 3), artist: 'Band', album: 'Gone', track: 'b' },
			{ uts: local(2024, 6, 5), artist: 'Band', album: 'Kept', track: 'c' }
		];
		server.plays.set(w.lfm, plays);
		await connect(w);
		await drain(w.user.id);
		const gone = itemByTitle(w.list.id, 'Gone')!;
		await items.deleteItem(w.user.id, gone.id);
		expect(albumRow(w.user.id, 'Gone')).toMatchObject({ itemId: null });
		expect(albumRow(w.user.id, 'Gone').linkedAt).not.toBeNull();
		expect(sync.getLastfmAccount(w.user.id)!.removedCount).toBe(1);

		// Another play of it arrives
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
		server.plays.get(w.lfm)!.push({ uts: nowS() - 100, artist: 'Band', album: 'Gone', track: 'd' });
		await drain(w.user.id);
		expect(itemByTitle(w.list.id, 'Gone')).toBeUndefined();
		expect(albumRow(w.user.id, 'Gone').plays).toBe(3);

		expect(sync.readdRemovedAlbums(w.user.id)).toBe(1);
		const back = itemByTitle(w.list.id, 'Gone')!;
		expect(back).toBeDefined();
		expect(back.status).toBe('listened');
		const dates = logsOf(w.user.id)
			.filter((l) => l.title === 'Gone')
			.map((l) => l.date);
		expect(dates).toEqual([dayOf(local(2024, 6, 1)), dayOf(local(2024, 6, 3)), dayOf(nowS())]);
		expect(sync.getLastfmAccount(w.user.id)!.removedCount).toBe(0);
		expect(sync.readdRemovedAlbums(w.user.id)).toBe(0);
	});
});

// --- 13: errors ---------------------------------------------------------------------------------

describe('errors', () => {
	const failWith = (error: number, status = 200) => {
		server.hook = (method) =>
			method === 'user.getRecentTracks' ? json({ error, message: 'nope' }, status) : undefined;
	};
	async function started() {
		const w = listener();
		server.plays.set(w.lfm, history(5, 2));
		await connect(w);
		return w;
	}

	it('does not retry a user that does not exist', async () => {
		const w = await started();
		failWith(6, 404);
		expect(await sync.runPage(w.user.id)).toBe('idle');
		expect(account(w.user.id)).toMatchObject({ errorCode: 'notfound' });
		server.hook = null;
		server.recent = [];
		vi.setSystemTime(new Date(NOW.getTime() + 3 * 86_400_000));
		expect(await sync.runPage(w.user.id)).toBe('idle');
		expect(server.recent).toHaveLength(0);
		// Only "Sync now" tries again
		expect(sync.requestSync(w.user.id)).toEqual({ started: true });
		expect(await drain(w.user.id)).toBe('done');
	});

	it('retries a private profile the next day', async () => {
		const w = await started();
		failWith(17, 403);
		await sync.runPage(w.user.id);
		const a = account(w.user.id)!;
		expect(a.errorCode).toBe('private');
		expect(a.nextSyncAt).toBe(Date.now() + 86_400_000);
		expect(sync.getLastfmAccount(w.user.id)!.error).toMatchObject({ code: 'private', retryAt: a.nextSyncAt });
		expect(a.job).toBe('backfill');
	});

	it('pauses on a rejected key until a key is saved again', async () => {
		const w = await started();
		failWith(10, 403);
		await sync.runPage(w.user.id);
		expect(account(w.user.id)).toMatchObject({ errorCode: 'auth' });
		server.hook = null;
		vi.setSystemTime(new Date(NOW.getTime() + 3 * 86_400_000));
		expect(await sync.runPage(w.user.id)).toBe('idle');
		expect(sync.resetLastfmAuthErrors()).toBe(1);
		expect(account(w.user.id)).toMatchObject({ errorCode: null, nextSyncAt: 0 });
		expect(await drain(w.user.id)).toBe('done');
	});

	it('backs off on rate limits, doubling up to an hour', async () => {
		const w = await started();
		failWith(29, 429);
		await sync.runPage(w.user.id);
		expect(account(w.user.id)).toMatchObject({
			errorCode: 'rate',
			errorCount: 1,
			nextSyncAt: Date.now() + 5 * 60_000
		});
		vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1000));
		await sync.runPage(w.user.id);
		expect(account(w.user.id)).toMatchObject({ errorCount: 2, nextSyncAt: Date.now() + 10 * 60_000 });
		expect(sync.retryDelay('rate', 9)).toBe(3_600_000);
		expect(sync.retryDelay('unreachable', 1)).toBe(60_000);
		expect(sync.retryDelay('unreachable', 3)).toBe(240_000);
		expect(sync.retryDelay('unreachable', 20)).toBe(3_600_000);
	});

	it('keeps the job through a network error and limits "Sync now"', async () => {
		const w = await started();
		server.hook = () => {
			throw new TypeError('fetch failed');
		};
		await sync.runPage(w.user.id);
		const a = account(w.user.id)!;
		expect(a).toMatchObject({ job: 'backfill', errorCode: 'unreachable', errorCount: 1 });
		expect(a.nextSyncAt).toBe(Date.now() + 60_000);
		server.hook = null;
		expect(sync.requestSync(w.user.id)).toEqual({ started: true });
		expect(sync.requestSync(w.user.id).started).toBe(false); // once a minute
		expect(await drain(w.user.id)).toBe('done');
		expect(sync.requestSync(w.user.id, Date.now() + 61_000)).toEqual({ started: true });
	});
});

// --- 14-15: disconnecting and deleting -----------------------------------------------------------

describe('disconnect and delete', () => {
	it('keeps the data on disconnect, and reconnecting resumes without doubling anything', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(250, 15));
		await connect(w);
		await drain(w.user.id);
		const logs = logsOf(w.user.id);
		const itemsBefore = itemCount(w.list.id);

		sync.disconnectLastfm(w.user.id);
		expect(sync.getLastfmAccount(w.user.id)).toBeNull();
		expect(logsOf(w.user.id)).toEqual(logs);
		expect(itemCount(w.list.id)).toBe(itemsBefore);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(15);

		await connect(w);
		await drain(w.user.id);
		expect(logsOf(w.user.id)).toEqual(logs);
		expect(itemCount(w.list.id)).toBe(itemsBefore);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(250);
		expect(sync.getLastfmAccount(w.user.id)).toMatchObject({ plays: 250, albums: 15 });
	});

	it('deletes only imported logs, restores statuses, and keeps anything somebody touched', async () => {
		const w = listener();
		const friend = person();
		access.saveShares(w.user.id, w.list.id, [{ userId: friend.id, role: 'edit' }]);
		const planned = items.createItem(w.user.id, {
			categoryId: w.list.id,
			title: 'Was Planned',
			subtitle: 'A',
			status: 'to-listen'
		});
		const handLog = items.addLog(
			w.user.id,
			planned.id,
			{ date: '2024-01-01', notes: 'vinyl night' },
			categories.getCategoryById(w.user.id, w.list.id).category.statuses,
			{ promote: false }
		);
		server.plays.set(
			w.lfm,
			['Was Planned', 'Rated', 'Friends', 'Untouched', 'Untouched Too'].map((t, i) => ({
				uts: nowS() - 1000 * (i + 1),
				artist: 'A',
				album: t,
				track: t
			}))
		);
		await connect(w);
		await drain(w.user.id);
		expect(items.getItem(w.user.id, planned.id).status).toBe('listened');
		expect(items.getItem(w.user.id, planned.id).lastLoggedAt).not.toBeNull();

		// Someone rates one; the friend logs another
		items.updateItem(w.user.id, itemByTitle(w.list.id, 'Rated')!.id, { rating: 80 });
		items.addLog(
			friend.id,
			itemByTitle(w.list.id, 'Friends')!.id,
			{ date: '2024-02-02' },
			categories.getCategoryById(friend.id, w.list.id).category.statuses
		);

		const logsBefore = count(
			'SELECT COUNT(*) AS n FROM item_logs WHERE user_id = ? AND source = ?',
			w.user.id,
			'lastfm'
		);
		const preview = sync.previewDeleteImported(w.user.id);
		expect(preview).toEqual({ logs: logsBefore, items: 2, restored: 1 });
		// A preview changes nothing
		expect(sync.getLastfmAccount(w.user.id)).not.toBeNull();
		expect(itemByTitle(w.list.id, 'Untouched')).toBeDefined();

		const result = sync.deleteImportedListening(w.user.id);
		expect(result).toEqual(preview);
		expect(sync.getLastfmAccount(w.user.id)).toBeNull();
		expect(logsOf(w.user.id)).toHaveLength(0);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(0);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(0);
		// Hand-written log and the item it belongs to stay, with the status it had before
		expect(
			db()
				.select()
				.from(schema.itemLogs)
				.all()
				.find((l) => l.id === handLog.id)
		).toBeDefined();
		expect(items.getItem(w.user.id, planned.id).status).toBe('to-listen');
		expect(items.getItem(w.user.id, planned.id).lastLoggedAt).toBe('2024-01-01');
		// Touched albums stay; untouched ones go
		expect(itemByTitle(w.list.id, 'Rated')).toBeDefined();
		expect(itemByTitle(w.list.id, 'Friends')).toBeDefined();
		expect(itemByTitle(w.list.id, 'Untouched')).toBeUndefined();
		expect(itemByTitle(w.list.id, 'Untouched Too')).toBeUndefined();
	});
});

// --- 16: privacy ---------------------------------------------------------------------------------

describe('privacy', () => {
	it('never shows another person’s last.fm username', async () => {
		const owner = person();
		const list = categories.createCategoryFromTemplate(owner.id, 'albums');
		const friend = person();
		access.saveShares(owner.id, list.id, [{ userId: friend.id, role: 'edit' }]);
		server.plays.set('Secret_Name', history(10, 2));
		server.plays.set('Owner_Name', history(10, 2));
		await sync.connectLastfm(friend.id, { username: 'Secret_Name', categoryId: list.id });
		await sync.connectLastfm(owner.id, { username: 'Owner_Name', categoryId: list.id });
		await drain(friend.id);
		await drain(owner.id);

		const view = JSON.stringify(sync.getLastfmAccount(owner.id));
		expect(view).toContain('Owner_Name');
		expect(view).not.toContain('Secret_Name');
		const res = await statusApi({ locals: { user: { id: owner.id } } } as never);
		const body = JSON.stringify(await res.json());
		expect(body).toContain('Owner_Name');
		expect(body).not.toContain('Secret_Name');
		const item = itemByTitle(list.id, 'Album 0')!;
		const detail = JSON.stringify(items.getItemDetail(owner.id, item.id));
		expect(detail).not.toContain('Secret_Name');
		expect(items.getItemDetail(owner.id, item.id).household[0].plays).toBeGreaterThan(0);
		expect(JSON.stringify(sync.lastfmTargetLists(owner.id))).not.toContain('Secret_Name');
		const none = await statusApi({ locals: { user: { id: person().id } } } as never);
		expect(await none.json()).toEqual({ connected: false });
	});
});

// --- 17: connecting ------------------------------------------------------------------------------

describe('connecting', () => {
	it('checks the username and the privacy of the history', async () => {
		const w = listener();
		await expect(
			sync.connectLastfm(w.user.id, { username: 'nobodyhere', categoryId: w.list.id })
		).rejects.toThrow("There's no last.fm user called 'nobodyhere'.");
		await expect(
			sync.connectLastfm(w.user.id, { username: '1bad name', categoryId: w.list.id })
		).rejects.toThrow(/no last.fm user/);
		server.plays.set('hidden', []);
		server.private.add('hidden');
		await expect(
			sync.connectLastfm(w.user.id, { username: 'hidden', categoryId: w.list.id })
		).rejects.toThrow(/listening history is private on last\.fm\. On last\.fm open Settings → Privacy/);
		expect(sync.getLastfmAccount(w.user.id)).toBeNull();
	});

	it('uses last.fm’s own capitalization and starts a backfill', async () => {
		const w = listener();
		server.plays.set('CamelCase', history(2, 1));
		const view = await sync.connectLastfm(w.user.id, { username: 'camelcase', categoryId: w.list.id });
		expect(view).toMatchObject({
			username: 'CamelCase',
			state: 'importing',
			backfilled: false,
			categoryName: 'Albums'
		});
		expect(account(w.user.id)).toMatchObject({ job: 'backfill', jobFrom: 0, jobEnd: nowS(), jobTo: nowS() });
	});

	it('creates an Albums list on request, and adds last.fm to an owned list', async () => {
		const user = person();
		const stuff = categories.createCategory(user.id, {
			name: 'Music',
			icon: '🎵',
			color: 'teal',
			statuses: [
				{ key: 'todo', label: 'To do', group: 'planned' },
				{ key: 'done', label: 'Done', group: 'done' }
			],
			providerKinds: ['musicbrainz:album']
		});
		server.plays.set('newlist', history(4, 2));
		const view = await sync.connectLastfm(user.id, { username: 'newlist', categoryId: 'new' });
		const created = categories.listCategories(user.id).find((c) => c.id === view.categoryId)!;
		expect(created).toMatchObject({ name: 'Albums' });
		expect(created.providerKinds).toContain('lastfm:album');
		expect(created.id).not.toBe(stuff.id);

		const other = person();
		const own = categories.createCategory(other.id, {
			name: 'Music',
			icon: '🎵',
			color: 'teal',
			statuses: stuff.statuses,
			providerKinds: ['musicbrainz:album']
		});
		server.plays.set('ownlist', history(4, 2));
		await sync.connectLastfm(other.id, { username: 'ownlist', categoryId: own.id });
		expect(categories.getCategoryById(other.id, own.id).category.providerKinds).toEqual([
			'musicbrainz:album',
			'lastfm:album'
		]);
	});

	it('moves to another list from the settings and keeps what is already placed', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(10, 5));
		await connect(w);
		await drain(w.user.id);
		const other = categories.createCategoryFromTemplate(w.user.id, 'albums');
		expect(() => sync.updateLastfmSettings(w.user.id, { categoryId: 99999 })).toThrow();
		sync.updateLastfmSettings(w.user.id, { categoryId: other.id });
		expect(itemCount(w.list.id)).toBe(5);
		expect(itemCount(other.id)).toBe(0);
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 3_600_000));
		server.plays.get(w.lfm)!.push({ uts: nowS() - 60, artist: 'New', album: 'Fresh', track: 'x' });
		await drain(w.user.id);
		expect(itemByTitle(other.id, 'Fresh')).toBeDefined();
	});
});

// --- 19: "Most played" ---------------------------------------------------------------------------

describe('most played', () => {
	it('sorts a list by the viewer’s own plays', async () => {
		const w = listener();
		const plays: Play[] = [];
		const counts: Record<string, number> = { Rare: 1, Often: 7, Some: 3 };
		let t = nowS() - 100;
		for (const [album, n] of Object.entries(counts))
			for (let i = 0; i < n; i++) plays.push({ uts: (t -= 60), artist: 'A', album, track: `${album}${i}` });
		server.plays.set(w.lfm, plays);
		await connect(w);
		await drain(w.user.id);
		const { category } = categories.getCategoryById(w.user.id, w.list.id);
		const rows = items.listItems(w.user.id, w.list.id, category.statuses, { sort: 'plays' }).rows;
		expect(rows.map((r) => r.title)).toEqual(['Often', 'Some', 'Rare']);
		expect(items.getItemDetail(w.user.id, rows[0].id).listening).toEqual({
			plays: 7,
			lastPlayed: dayOf(nowS())
		});
	});
});

describe('settings export', () => {
	it('includes only the person’s own last.fm connection', async () => {
		const { GET } = await import('../../routes/(app)/settings/export/+server');
		const a = listener();
		const b = listener();
		server.plays.set(a.lfm, history(2, 1));
		server.plays.set(b.lfm, history(2, 1));
		await connect(a);
		await connect(b);
		const exported = async (w: typeof a) => {
			const res = await GET({
				locals: { user: { id: w.user.id, username: w.user.username, displayName: w.user.displayName } }
			} as never);
			return (await res.json()) as { lastfm?: { username: string; connectedAt: string } };
		};
		const mine = await exported(a);
		expect(mine.lastfm?.username).toBe(a.lfm);
		expect(Number.isNaN(Date.parse(mine.lastfm!.connectedAt))).toBe(false);
		expect(JSON.stringify(mine)).not.toContain(b.lfm);
		sync.disconnectLastfm(a.user.id);
		expect((await exported(a)).lastfm).toBeUndefined();
	});
});

// --- Review fixes ---------------------------------------------------------------------------------

describe('review fixes', () => {
	const later = (hours: number) => vi.setSystemTime(new Date(Date.now() + hours * 3_600_000));
	const sharedPair = (role: 'view' | 'edit' = 'edit') => {
		const owner = person();
		const list = categories.createCategoryFromTemplate(owner.id, 'albums');
		const importer = person();
		access.saveShares(owner.id, list.id, [{ userId: importer.id, role }]);
		return { owner, importer, list, lfm: `fm${importer.id}` };
	};
	const progressOf = (userId: number) =>
		JSON.stringify(
			rawDb().prepare('SELECT * FROM item_progress WHERE user_id = ? ORDER BY item_id').all(userId)
		);

	it('leaves no empty album behind when a stored play comes back under another album name', async () => {
		const w = listener();
		const t = nowS() - 600;
		server.plays.set(w.lfm, [
			{ uts: t, artist: 'Band', album: 'Old Name', track: 'Song' },
			{ uts: t - 600, artist: 'Band', album: 'Old Name', track: 'Other' }
		]);
		await connect(w);
		await drain(w.user.id);
		later(2);
		server.plays.set(w.lfm, [
			{ uts: t, artist: 'Band', album: 'New Name', track: 'Song' },
			{ uts: t - 600, artist: 'Band', album: 'Old Name', track: 'Other' }
		]);
		await drain(w.user.id);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(1);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ? AND plays = 0', w.user.id)).toBe(
			0
		);
		expect(itemCount(w.list.id)).toBe(1);

		// Rows left by older versions go too, and never become items
		rawDb()
			.prepare("INSERT INTO lastfm_albums (user_id, key, artist, title) VALUES (?, 'k', 'X', 'Zero')")
			.run(w.user.id);
		const other = categories.createCategoryFromTemplate(w.user.id, 'albums');
		sync.updateLastfmSettings(w.user.id, { categoryId: other.id });
		expect(albumRow(w.user.id, 'Zero')).toBeUndefined();
		expect(itemCount(other.id)).toBe(0);
	});

	it('stops writing logs and progress to a list the importer can no longer edit', async () => {
		const s = sharedPair();
		const mine = categories.createCategoryFromTemplate(s.importer.id, 'albums');
		server.plays.set(s.lfm, history(4, 2));
		await sync.connectLastfm(s.importer.id, { username: s.lfm, categoryId: s.list.id });
		await drain(s.importer.id);
		sync.updateLastfmSettings(s.importer.id, { categoryId: mine.id });
		const logs = logsOf(s.importer.id);
		const progress = progressOf(s.importer.id);
		access.saveShares(s.owner.id, s.list.id, [{ userId: s.importer.id, role: 'view' }]);

		later(2);
		server.plays.get(s.lfm)!.push({ uts: nowS() - 60, artist: 'Artist 0', album: 'Album 0', track: 'New' });
		await drain(s.importer.id);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', s.importer.id)).toBe(5);
		expect(logsOf(s.importer.id)).toEqual(logs);
		expect(progressOf(s.importer.id)).toBe(progress);
	});

	it('does not link an album to an item on a list the importer can only view', async () => {
		const s = sharedPair();
		const view = categories.createCategoryFromTemplate(s.owner.id, 'albums');
		access.saveShares(s.owner.id, view.id, [{ userId: s.importer.id, role: 'view' }]);
		const pid = lastfmAlbumId('Band', 'Rare');
		const at = Date.now();
		const theirs = rawDb()
			.prepare(
				`INSERT INTO items (user_id, category_id, title, subtitle, provider, provider_kind, provider_id, created_at, updated_at)
				 VALUES (?, ?, 'Rare', 'Band', 'lastfm', 'album', ?, ?, ?) RETURNING id`
			)
			.get(s.owner.id, view.id, pid, at, at) as { id: number };
		server.plays.set(s.lfm, [{ uts: nowS() - 600, artist: 'Band', album: 'Rare', track: 'x' }]);
		await sync.connectLastfm(s.importer.id, { username: s.lfm, categoryId: s.list.id });
		await drain(s.importer.id);
		expect(albumRow(s.importer.id, 'Rare').itemId).toBeNull();
		expect(logsOf(s.importer.id)).toHaveLength(0);
		expect(count('SELECT COUNT(*) AS n FROM item_logs WHERE item_id = ?', theirs.id)).toBe(0);

		// Once they may edit that list, the album goes there
		access.saveShares(s.owner.id, view.id, [{ userId: s.importer.id, role: 'edit' }]);
		later(2);
		await drain(s.importer.id);
		expect(albumRow(s.importer.id, 'Rare').itemId).toBe(theirs.id);
	});

	it('refuses a different last.fm username while imported listening from another exists', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(6, 2));
		server.plays.set('someoneelse', history(3, 1));
		await connect(w);
		await drain(w.user.id);
		const message = `You've imported listening from ${w.lfm}. To connect someoneelse instead, first delete the imported listening below.`;
		// Connected: refused
		await expect(
			sync.connectLastfm(w.user.id, { username: 'someoneelse', categoryId: w.list.id })
		).rejects.toThrow(message);
		// After "Stop syncing": still refused, the old name is remembered with the data
		sync.disconnectLastfm(w.user.id);
		await expect(
			sync.connectLastfm(w.user.id, { username: 'someoneelse', categoryId: w.list.id })
		).rejects.toThrow(message);
		expect(sync.hasImportedListening(w.user.id)).toBe(true);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(6);
		// The same name (any capitalization) resumes
		await sync.connectLastfm(w.user.id, { username: w.lfm.toUpperCase(), categoryId: w.list.id });
		expect(sync.getLastfmAccount(w.user.id)).not.toBeNull();
		// After deleting, a different name is fine
		sync.deleteImportedListening(w.user.id);
		expect(sync.hasImportedListening(w.user.id)).toBe(false);
		await sync.connectLastfm(w.user.id, { username: 'someoneelse', categoryId: w.list.id });
		expect(sync.getLastfmAccount(w.user.id)?.username).toBe('someoneelse');
	});

	it('keeps imported albums that were edited by hand when deleting the import', async () => {
		const w = listener();
		const titles = ['Plain', 'Enriched', 'Described', 'Renamed', 'Retitled'];
		server.plays.set(
			w.lfm,
			titles.map((t, i) => ({ uts: nowS() - 600 * (i + 1), artist: 'A', album: t, track: t }))
		);
		await connect(w);
		await drain(w.user.id);
		rawDb()
			.prepare(
				`UPDATE items SET metadata = json_set(metadata, '$.enriched', json('true'))
				 WHERE provider = 'lastfm' AND json_extract(metadata, '$.enriched') = 0 AND title != 'Enriched'`
			)
			.run();
		server.hook = (method) =>
			method === 'album.getInfo'
				? json({ album: { name: 'Enriched', artist: 'A', wiki: { summary: 'From last.fm.' } } })
				: undefined;
		expect(await sync.enrichNext()).toBe(true);
		const enriched = itemByTitle(w.list.id, 'Enriched')!;
		expect(items.getItem(w.user.id, enriched.id).description).toBe('From last.fm.');

		items.updateItem(w.user.id, itemByTitle(w.list.id, 'Described')!.id, { description: 'My own words' });
		items.updateItem(w.user.id, itemByTitle(w.list.id, 'Renamed')!.id, { title: 'Renamed (remaster)' });
		items.updateItem(w.user.id, itemByTitle(w.list.id, 'Retitled')!.id, { subtitle: 'B' });

		const result = sync.deleteImportedListening(w.user.id);
		expect(result.items).toBe(2);
		expect(itemByTitle(w.list.id, 'Plain')).toBeUndefined();
		expect(itemByTitle(w.list.id, 'Enriched')).toBeUndefined();
		expect(itemByTitle(w.list.id, 'Described')).toBeDefined();
		expect(itemByTitle(w.list.id, 'Renamed (remaster)')).toBeDefined();
		expect(itemByTitle(w.list.id, 'Retitled')).toBeDefined();
	});

	it('reads every play of one second beyond a full page', async () => {
		const w = listener();
		const second = nowS();
		const same: Play[] = Array.from({ length: 450 }, (_, i) => ({
			uts: second,
			artist: 'Burst',
			album: 'Burst Album',
			track: `Track ${i}`
		}));
		server.plays.set(w.lfm, [...same, ...history(10, 3, second - 3600)]);
		await connect(w);
		expect(await drain(w.user.id)).toBe('done');
		expect(count('SELECT COUNT(*) AS n FROM lastfm_scrobbles WHERE user_id = ?', w.user.id)).toBe(460);
		expect(pages().some((u) => u.searchParams.get('page') === '3')).toBe(true);
		expect(account(w.user.id)).toMatchObject({ job: null, plays: 460 });
	});

	it('finishes a window whose end moved below its start, without asking last.fm', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(3, 1));
		await connect(w);
		await drain(w.user.id);
		later(2);
		rawDb()
			.prepare(
				"UPDATE lastfm_accounts SET job = 'sync', job_from = 2000, job_to = 1000, job_end = 1000, next_sync_at = 0 WHERE user_id = ?"
			)
			.run(w.user.id);
		server.recent = [];
		expect(await sync.runPage(w.user.id)).toBe('done');
		expect(server.recent).toHaveLength(0);
		expect(account(w.user.id)!.job).toBeNull();
	});

	it('does not keep re-arming the scheduler without an API key', async () => {
		const w = listener();
		server.plays.set(w.lfm, history(3, 1));
		await connect(w);
		expect(sync.backfillsRunning(Date.now())).toBe(true);
		const key = env.LASTFM_API_KEY;
		env.LASTFM_API_KEY = '';
		try {
			expect(sync.backfillsRunning(Date.now())).toBe(false);
		} finally {
			env.LASTFM_API_KEY = key;
		}
	});

	it('moves on from an album whose details fail with an unexpected error', async () => {
		const w = listener();
		server.plays.set(w.lfm, [{ uts: nowS() - 60, artist: 'Odd', album: 'Broken', track: 't' }]);
		await connect(w);
		await drain(w.user.id);
		rawDb()
			.prepare(
				`UPDATE items SET metadata = json_set(metadata, '$.enriched', json('true'))
				 WHERE provider = 'lastfm' AND json_extract(metadata, '$.enriched') = 0 AND title != 'Broken'`
			)
			.run();
		const details = vi.spyOn(lastfm, 'details').mockRejectedValueOnce(new TypeError('unexpected shape'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await sync.enrichNext()).toBe(true);
			expect(warn).toHaveBeenCalled();
			expect(
				count(
					"SELECT COUNT(*) AS n FROM items WHERE title = 'Broken' AND json_extract(metadata, '$.enriched') = 1"
				)
			).toBe(1);
		} finally {
			details.mockRestore();
			warn.mockRestore();
		}
	});

	it('keeps albums whose names fold to nothing apart', async () => {
		expect(albumKey('!!!', '!!!')).not.toBe(albumKey('???', '???'));
		expect(albumKey('Daft Punk', 'Discovery')).toBe(albumKey('daft punk', 'DISCOVERY'));
		const w = listener();
		server.plays.set(w.lfm, [
			{ uts: nowS() - 60, artist: '!!!', album: '!!!', track: 'a' },
			{ uts: nowS() - 120, artist: '???', album: '???', track: 'b' }
		]);
		await connect(w);
		await drain(w.user.id);
		expect(count('SELECT COUNT(*) AS n FROM lastfm_albums WHERE user_id = ?', w.user.id)).toBe(2);
		expect(itemCount(w.list.id)).toBe(2);
	});

	it('names only the owner on a list shared with the importer', () => {
		const s = sharedPair();
		const third = person();
		access.saveShares(s.owner.id, s.list.id, [
			{ userId: s.importer.id, role: 'edit' },
			{ userId: third.id, role: 'edit' }
		]);
		const forSharee = sync.lastfmTargetLists(s.importer.id).find((l) => l.id === s.list.id)!;
		expect(forSharee.otherPeople).toEqual([s.owner.displayName]);
		const forOwner = sync.lastfmTargetLists(s.owner.id).find((l) => l.id === s.list.id)!;
		expect([...forOwner.otherPeople].sort()).toEqual([s.importer.displayName, third.displayName].sort());
	});

	it('shows imported tracks on household logs, and knows imported logs exist after disconnecting', async () => {
		const s = sharedPair();
		server.plays.set(s.lfm, history(10, 1));
		await sync.connectLastfm(s.importer.id, { username: s.lfm, categoryId: s.list.id });
		await drain(s.importer.id);
		const item = itemByTitle(s.list.id, 'Album 0')!;
		const household = items.getItemDetail(s.owner.id, item.id).household;
		expect(household[0].logs[0].external).toEqual({ lastfm: { plays: 10 } });

		expect(hasListeningLogs(s.importer.id)).toBe(true);
		sync.disconnectLastfm(s.importer.id);
		expect(hasListeningLogs(s.importer.id)).toBe(true);
		expect(hasListeningLogs(s.owner.id)).toBe(false);
	});
});
