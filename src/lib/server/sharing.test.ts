import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the app at a throwaway data directory before anything opens the database
vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sharing-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), TMDB_API_KEY: 'test-key' } };
});

const { db, rawDb, schema } = await import('./db');
const categories = await import('./services/categories');
const items = await import('./services/items');
const access = await import('./services/access');
const episodes = await import('./services/episodes');
const releases = await import('./services/releases');
const { journal } = await import('./services/journal');
const { addFromProvider } = await import('./services/provider-items');
const { searchLocal } = await import('./search/local');
const yam = await import('./import/yamtrack');
const { listContext } = await import('./import/sheet');

const {
	createCategoryFromTemplate,
	deleteCategory,
	editableCategories,
	findCategoryForKind,
	getCategoryById,
	getCategoryBySlug,
	listCategories,
	updateCategory
} = categories;
const { canSeeUpload, leaveList, listAccess, saveShares, setMyListSettings } = access;

const today = '2026-10-16';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** TMDB: every show is running, with season 1 out and season 2 half-way through */
const SHOW = {
	status: 'Returning Series',
	first_air_date: '2024-01-01',
	last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2026-10-14' },
	next_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2026-10-21' },
	seasons: [
		{ season_number: 1, episode_count: 3, air_date: '2024-01-01' },
		{ season_number: 2, episode_count: 4, air_date: '2026-10-07' }
	]
};
const SEASONS: Record<string, unknown> = {
	1: {
		season_number: 1,
		episodes: [1, 2, 3].map((n) => ({ episode_number: n, air_date: `2024-01-0${n}`, name: `Pilot ${n}` }))
	},
	2: {
		season_number: 2,
		episodes: [
			{ episode_number: 1, air_date: '2026-10-07', name: 'Back' },
			{ episode_number: 2, air_date: '2026-10-14', name: 'Again' },
			{ episode_number: 3, air_date: '2026-10-21', name: 'Soon' },
			{ episode_number: 4, air_date: null, name: 'TBA' }
		]
	}
};

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL) => {
			const path = new URL(String(input)).pathname.replace('/3', '');
			const m = path.match(/^\/tv\/(\d+)(?:\/season\/(\d+))?$/);
			const body = m && (m[2] === undefined ? SHOW : SEASONS[m[2]]);
			return body ? json(body) : new Response('{}', { status: 404 });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
function person(name: string) {
	return db()
		.insert(schema.users)
		.values({ username: `${name.toLowerCase()}${++n}`, displayName: name, passwordHash: 'x' })
		.returning()
		.get();
}

/**
 * Daniel's whiskey list, shared with Erin (can edit) and Vic (can view). Otto has an account but
 * the list isn't shared with him.
 */
function household() {
	const owner = person('Daniel');
	const editor = person('Erin');
	const viewer = person('Vic');
	const outsider = person('Otto');
	const whiskey = createCategoryFromTemplate(owner.id, 'whiskey');
	saveShares(owner.id, whiskey.id, [
		{ userId: editor.id, role: 'edit' },
		{ userId: viewer.id, role: 'view' }
	]);
	const item = items.createItem(
		owner.id,
		{ categoryId: whiskey.id, title: 'Lagavulin 16', status: 'wishlist' },
		['peated']
	);
	return { owner, editor, viewer, outsider, whiskey, statuses: whiskey.statuses, item };
}

/** Daniel's TV list, shared with Erin to edit */
function tvHousehold() {
	const owner = person('Daniel');
	const member = person('Erin');
	const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
	saveShares(owner.id, tv.id, [{ userId: member.id, role: 'edit' }]);
	return { owner, member, tv };
}

const tmdbShow = (id: string) => ({ provider: 'tmdb', providerKind: 'tv', providerId: id });

async function expectStatus(fn: () => unknown, status: number) {
	try {
		await fn();
	} catch (e) {
		expect((e as { status?: number }).status).toBe(status);
		return;
	}
	throw new Error(`expected a ${status} error`);
}

const progressRows = (itemId: number) =>
	rawDb()
		.prepare('SELECT user_id AS userId, status, rating FROM item_progress WHERE item_id = ? ORDER BY user_id')
		.all(itemId) as { userId: number; status: string | null; rating: number | null }[];

describe('access', () => {
	it('an outsider gets a 404 for the list, its items, logs and photos', async () => {
		const h = household();
		const log = items.addLog(h.owner.id, h.item.id, { date: '2026-10-01' }, h.statuses);
		const img = await items.addImage(
			h.owner.id,
			{ itemId: h.item.id },
			{ type: 'url', url: 'https://example.com/bottle.jpg', linkOnly: true }
		);
		const o = h.outsider.id;
		expect(listAccess(o, h.whiskey.id)).toBeNull();
		await expectStatus(() => getCategoryById(o, h.whiskey.id), 404);
		await expectStatus(() => items.getItem(o, h.item.id), 404);
		await expectStatus(() => items.getItemDetail(o, h.item.id), 404);
		await expectStatus(() => items.updateItem(o, h.item.id, { status: 'open' }), 404);
		await expectStatus(() => items.addLog(o, h.item.id, { date: '2026-10-02' }, h.statuses), 404);
		await expectStatus(() => items.getOwnedLog(o, log.id), 404);
		await expectStatus(() => items.getEditableImage(o, img.id), 404);
		await expectStatus(() => items.deleteImage(o, img.id), 404);
		await expectStatus(() => items.createItem(o, { categoryId: h.whiskey.id, title: 'Sneaky' }), 404);
		expect(items.listItems(o, h.whiskey.id, h.statuses, {}).rows).toEqual([]);
		expect(items.statusCounts(o, h.whiskey.id)).toEqual({});
		expect(searchLocal(o, 'lagavulin')).toEqual([]);
		expect(listCategories(o)).toEqual([]);
	});

	it('a viewer keeps their own progress but gets a 403 for changing the item or the list', async () => {
		const h = household();
		const v = h.viewer.id;
		expect(listAccess(v, h.whiskey.id)).toBe('view');
		expect(items.getItem(v, h.item.id).access).toBe('view');
		await expectStatus(() => items.getItem(v, h.item.id, 'edit'), 403);
		await expectStatus(() => items.updateItem(v, h.item.id, { title: 'Renamed' }), 403);
		await expectStatus(() => items.updateItem(v, h.item.id, { status: 'open' }, ['mine']), 403);
		await expectStatus(
			() =>
				items.addImage(
					v,
					{ itemId: h.item.id },
					{ type: 'url', url: 'https://example.com/x.jpg', linkOnly: true }
				),
			403
		);
		await expectStatus(() => items.createItem(v, { categoryId: h.whiskey.id, title: 'Mine' }), 403);
		await expectStatus(() => items.deleteItem(v, h.item.id), 403);
		await expectStatus(() => getCategoryById(v, h.whiskey.id, 'edit'), 403);
		await expectStatus(() => updateCategory(v, h.whiskey.id, { ...h.whiskey, name: 'Mine now' }), 403);
		await expectStatus(() => saveShares(v, h.whiskey.id, [{ userId: h.outsider.id, role: 'edit' }]), 403);

		// Their own progress is fine, and so is a photo on their own log
		items.updateItem(v, h.item.id, { status: 'open', rating: 70, favorite: true, notes: 'Smoky' });
		expect(items.getItem(v, h.item.id)).toMatchObject({ status: 'open', rating: 70, favorite: true });
		const log = items.addLog(v, h.item.id, { date: '2026-10-03' }, h.statuses);
		const img = await items.addImage(
			v,
			{ logId: log.id },
			{ type: 'url', url: 'https://example.com/glass.jpg', linkOnly: true }
		);
		expect(img.userId).toBe(v);
		expect(items.getItem(h.owner.id, h.item.id).title).toBe('Lagavulin 16');
	});

	it('an editor can add and change items, but not the list settings', async () => {
		const h = household();
		const e = h.editor.id;
		const added = items.createItem(e, { categoryId: h.whiskey.id, title: 'Talisker 10' });
		items.updateItem(e, h.item.id, { title: 'Lagavulin 16 Year Old', custom: { distillery: 'Lagavulin' } });
		expect(items.getItem(h.owner.id, h.item.id)).toMatchObject({
			title: 'Lagavulin 16 Year Old',
			custom: { distillery: 'Lagavulin' }
		});
		expect(items.getItem(h.owner.id, added.id).userId).toBe(h.owner.id);
		await items.addImage(
			e,
			{ itemId: h.item.id },
			{ type: 'url', url: 'https://example.com/b.jpg', linkOnly: true }
		);
		await expectStatus(() => updateCategory(e, h.whiskey.id, { ...h.whiskey, name: 'Ours' }), 403);
		await expectStatus(() => getCategoryBySlug(e, `whiskey@${h.owner.username}`, 'owner'), 403);
		await expectStatus(() => saveShares(e, h.whiskey.id, [{ userId: h.outsider.id, role: 'view' }]), 403);
	});

	it('finds a shared list by slug@owner', async () => {
		const h = household();
		const slug = `whiskey@${h.owner.username}`;
		const { category } = getCategoryBySlug(h.editor.id, slug);
		expect(category).toMatchObject({
			id: h.whiskey.id,
			slug,
			access: 'edit',
			ownerName: 'Daniel',
			sharedWith: 2,
			userId: h.owner.id
		});
		expect(getCategoryBySlug(h.owner.id, 'whiskey').category).toMatchObject({
			access: 'owner',
			ownerName: null
		});
		// The plain slug is the viewer's own list
		await expectStatus(() => getCategoryBySlug(h.editor.id, 'whiskey'), 404);
		await expectStatus(() => getCategoryBySlug(h.outsider.id, slug), 404);
		await expectStatus(() => getCategoryBySlug(h.editor.id, `whiskey@nobody`), 404);
	});

	it('lists own lists first (in order), then shared ones by name, with access and owner', () => {
		const h = household();
		const albums = createCategoryFromTemplate(h.editor.id, 'albums');
		const movies = createCategoryFromTemplate(h.editor.id, 'movies');
		const cheese = createCategoryFromTemplate(h.owner.id, 'cheese');
		saveShares(h.owner.id, cheese.id, [{ userId: h.editor.id, role: 'view' }]);

		const mine = listCategories(h.editor.id);
		expect(mine.map((c) => [c.name, c.slug, c.access, c.ownerName, c.sharedWith])).toEqual([
			['Albums', albums.slug, 'owner', null, 0],
			['Movies', movies.slug, 'owner', null, 0],
			['Cheese', `cheese@${h.owner.username}`, 'view', 'Daniel', 1],
			['Whiskey', `whiskey@${h.owner.username}`, 'edit', 'Daniel', 2]
		]);
		expect(mine.find((c) => c.name === 'Whiskey')?.itemCount).toBe(1);
		expect(editableCategories(h.editor.id).map((c) => c.name)).toEqual(['Albums', 'Movies', 'Whiskey']);
		expect(listCategories(h.owner.id).map((c) => [c.name, c.access, c.sharedWith])).toEqual([
			['Whiskey', 'owner', 2],
			['Cheese', 'owner', 1]
		]);
	});

	it('a provider result goes into the viewer’s own list before a shared one, never a view-only one', () => {
		const h = household();
		const theirs = createCategoryFromTemplate(h.owner.id, 'movies');
		saveShares(h.owner.id, theirs.id, [
			{ userId: h.editor.id, role: 'edit' },
			{ userId: h.viewer.id, role: 'view' }
		]);
		expect(findCategoryForKind(h.editor.id, 'tmdb:movie')?.id).toBe(theirs.id);
		const own = createCategoryFromTemplate(h.editor.id, 'movies');
		expect(findCategoryForKind(h.editor.id, 'tmdb:movie')?.id).toBe(own.id);
		expect(findCategoryForKind(h.viewer.id, 'tmdb:movie')).toBeNull();
	});

	it('tag suggestions for a member leave out tags used only on the owner’s other lists', () => {
		const h = household();
		const cellar = createCategoryFromTemplate(h.owner.id, 'wine');
		saveShares(h.owner.id, cellar.id, [{ userId: h.editor.id, role: 'view' }]);
		items.createItem(h.owner.id, { categoryId: cellar.id, title: 'Barolo' }, ['gift']);
		const hidden = createCategoryFromTemplate(h.owner.id, 'cheese');
		items.createItem(h.owner.id, { categoryId: hidden.id, title: 'Brie' }, ['surprise-party', 'peated']);
		// The editor's own tags are for their own lists, not the owner's
		const own = createCategoryFromTemplate(h.editor.id, 'whiskey');
		items.createItem(h.editor.id, { categoryId: own.id, title: 'Mine' }, ['erins']);

		expect(items.tagSuggestions(h.owner.id, h.owner.id)).toEqual(['gift', 'peated', 'surprise-party']);
		// Tags on the shared whiskey list, and on another list shared with them (even to view)
		expect(items.tagSuggestions(h.editor.id, h.owner.id)).toEqual(['gift', 'peated']);
		expect(items.tagSuggestions(h.viewer.id, h.owner.id)).toEqual(['peated']);
		expect(items.tagSuggestions(h.outsider.id, h.owner.id)).toEqual([]);
	});
});

describe('personal progress', () => {
	it('keeps the owner’s and a member’s status, rating, favorite and notes apart', () => {
		const h = household();
		items.updateItem(h.editor.id, h.item.id, {
			status: 'open',
			rating: 80,
			favorite: true,
			notes: 'Bonfire smoke'
		});
		items.updateItem(h.owner.id, h.item.id, { rating: 60, notes: 'Too much' });

		expect(items.getItem(h.owner.id, h.item.id)).toMatchObject({
			status: 'wishlist',
			rating: 60,
			favorite: false,
			notes: 'Too much'
		});
		expect(items.getItem(h.editor.id, h.item.id)).toMatchObject({
			status: 'open',
			rating: 80,
			favorite: true,
			notes: 'Bonfire smoke'
		});
		expect(items.getItem(h.viewer.id, h.item.id)).toMatchObject({
			status: null,
			rating: null,
			favorite: false,
			notes: null
		});

		const row = (userId: number) => items.listItems(userId, h.whiskey.id, h.statuses, {}).rows[0];
		expect(row(h.owner.id)).toMatchObject({ status: 'wishlist', rating: 60, favorite: false });
		expect(row(h.editor.id)).toMatchObject({ status: 'open', rating: 80, favorite: true });
		expect(items.listItems(h.editor.id, h.whiskey.id, h.statuses, { status: 'wishlist' }).rows).toEqual([]);
		expect(items.listItems(h.editor.id, h.whiskey.id, h.statuses, { favorite: true }).total).toBe(1);
		expect(items.listItems(h.owner.id, h.whiskey.id, h.statuses, { favorite: true }).total).toBe(0);

		expect(items.statusCounts(h.owner.id, h.whiskey.id)).toEqual({ wishlist: 1 });
		expect(items.statusCounts(h.editor.id, h.whiskey.id)).toEqual({ open: 1 });
		expect(items.statusCounts(h.viewer.id, h.whiskey.id)).toEqual({ '': 1 });

		// Search: everyone with the list finds it, with their own status, and by their own notes
		const hit = (userId: number, q: string) => searchLocal(userId, q).find((x) => x.id === h.item.id);
		expect(hit(h.owner.id, 'lagavulin')).toMatchObject({
			status: 'Wishlist',
			rating: 60,
			categorySlug: 'whiskey'
		});
		expect(hit(h.editor.id, 'lagavulin')).toMatchObject({
			status: 'Open',
			rating: 80,
			categorySlug: `whiskey@${h.owner.username}`
		});
		expect(hit(h.editor.id, 'bonfire')).toBeTruthy();
	});

	it('Up next and favorites are each person’s own, with their own Up next choice', () => {
		const h = household();
		const talisker = items.createItem(h.editor.id, {
			categoryId: h.whiskey.id,
			title: 'Talisker 10',
			status: 'wishlist'
		});
		items.updateItem(h.editor.id, h.item.id, { favorite: true });
		const titles = (userId: number, kind: 'planned' | 'favorites') =>
			items.itemStrip(userId, kind).map((r) => r.title);

		expect(titles(h.owner.id, 'planned')).toEqual(['Lagavulin 16']);
		expect(titles(h.editor.id, 'planned')).toEqual(['Talisker 10']);
		expect(titles(h.viewer.id, 'planned')).toEqual([]);
		expect(titles(h.editor.id, 'favorites')).toEqual(['Lagavulin 16']);
		expect(titles(h.owner.id, 'favorites')).toEqual([]);

		setMyListSettings(h.editor.id, h.whiskey.id, { showUpNext: false });
		expect(titles(h.editor.id, 'planned')).toEqual([]);
		expect(titles(h.owner.id, 'planned')).toEqual(['Lagavulin 16']);
		expect(getCategoryById(h.owner.id, h.whiskey.id).category.showUpNext).toBe(true);
		expect(getCategoryById(h.editor.id, h.whiskey.id).category.showUpNext).toBe(false);
		expect(talisker.status).toBe('wishlist');
	});

	it('an item a member adds belongs to the list owner, with the member’s status kept as theirs', () => {
		const h = household();
		const added = items.createItem(
			h.editor.id,
			{ categoryId: h.whiskey.id, title: 'Ardbeg 10', status: 'sealed', rating: 90, notes: 'Gift' },
			['islay']
		);
		expect(added).toMatchObject({ userId: h.owner.id, status: 'sealed', rating: 90, access: 'edit' });
		const raw = db()
			.select()
			.from(schema.items)
			.all()
			.find((i) => i.id === added.id)!;
		expect(raw).toMatchObject({ userId: h.owner.id, status: null, rating: null, notes: null });
		expect(progressRows(added.id)).toEqual([{ userId: h.editor.id, status: 'sealed', rating: 90 }]);
		// Tags are the owner's
		expect(items.listUserTags(h.owner.id)).toContain('islay');
		expect(items.listUserTags(h.editor.id)).toEqual([]);
	});

	it('updateItem saves personal fields for the viewer and shared ones for everyone', () => {
		const h = household();
		items.updateItem(h.editor.id, h.item.id, { title: 'Lagavulin 16 Year Old', status: 'open' }, ['smoky']);
		const owner = items.getItem(h.owner.id, h.item.id);
		expect(owner).toMatchObject({ title: 'Lagavulin 16 Year Old', status: 'wishlist' });
		expect(items.getItem(h.viewer.id, h.item.id).title).toBe('Lagavulin 16 Year Old');
		expect(items.getItem(h.editor.id, h.item.id).status).toBe('open');
		expect(items.getItemTags(h.item.id)).toEqual(['smoky']);
		// The owner's tag list follows: "peated" is gone, "smoky" is theirs
		expect(items.listUserTags(h.owner.id)).toEqual(['smoky']);
	});

	it('moves an item only between lists of the same owner', async () => {
		const h = household();
		const second = createCategoryFromTemplate(h.owner.id, 'whiskey');
		const own = createCategoryFromTemplate(h.editor.id, 'whiskey');
		// Into their own list: everyone's progress would go with it
		await expectStatus(() => items.updateItem(h.editor.id, h.item.id, { categoryId: own.id }), 400);
		// Into the owner's list that isn't shared with them
		await expectStatus(() => items.updateItem(h.editor.id, h.item.id, { categoryId: second.id }), 404);
		saveShares(h.owner.id, second.id, [{ userId: h.editor.id, role: 'view' }]);
		await expectStatus(() => items.updateItem(h.editor.id, h.item.id, { categoryId: second.id }), 403);
		saveShares(h.owner.id, second.id, [{ userId: h.editor.id, role: 'edit' }]);
		// The owner has tracked it (it's on their wishlist), so only the owner moves it
		await expectStatus(() => items.updateItem(h.editor.id, h.item.id, { categoryId: second.id }), 403);
		items.updateItem(h.owner.id, h.item.id, { categoryId: second.id });
		expect(items.getItem(h.owner.id, h.item.id).categoryId).toBe(second.id);
		await expectStatus(() => items.updateItem(h.owner.id, h.item.id, { categoryId: own.id }), 404);
		// Something nobody else has tracked, the editor can move
		const fresh = items.createItem(h.editor.id, { categoryId: h.whiskey.id, title: 'Ardbeg 10' });
		items.updateItem(h.editor.id, fresh.id, { categoryId: second.id });
		expect(items.getItem(h.owner.id, fresh.id).categoryId).toBe(second.id);
	});

	it('an editor can’t move an item another member has tracked', async () => {
		const h = household();
		const second = createCategoryFromTemplate(h.owner.id, 'whiskey');
		saveShares(h.owner.id, second.id, [{ userId: h.editor.id, role: 'edit' }]);
		// The editor added it, so the owner hasn't tracked it, and the editor's own status doesn't count
		const logged = items.createItem(h.editor.id, {
			categoryId: h.whiskey.id,
			title: 'Ardbeg 10',
			status: 'sealed'
		});
		items.addLog(h.viewer.id, logged.id, { date: '2026-10-02' }, h.statuses);
		await expectStatus(
			() => items.updateItem(h.editor.id, logged.id, { categoryId: second.id, title: 'Ardbeg Ten' }),
			403
		);
		// Nothing in the refused change was saved
		expect(items.getItem(h.owner.id, logged.id)).toMatchObject({
			categoryId: h.whiskey.id,
			title: 'Ardbeg 10'
		});

		// A favorite is enough
		const liked = items.createItem(h.editor.id, { categoryId: h.whiskey.id, title: 'Laphroaig 10' });
		items.updateItem(h.viewer.id, liked.id, { favorite: true });
		await expectStatus(() => items.updateItem(h.editor.id, liked.id, { categoryId: second.id }), 403);
		expect(items.getItem(h.owner.id, liked.id).categoryId).toBe(h.whiskey.id);

		// The owner can move both
		items.updateItem(h.owner.id, logged.id, { categoryId: second.id });
		expect(items.getItem(h.owner.id, logged.id).categoryId).toBe(second.id);
	});

	it('moving an item to a list with other statuses gives everyone a status that list has', () => {
		const owner = person('Daniel');
		const [erin, vic, otto] = ['Erin', 'Vic', 'Otto'].map(person);
		const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
		const games = createCategoryFromTemplate(owner.id, 'video-games');
		const concerts = createCategoryFromTemplate(owner.id, 'concerts');
		saveShares(owner.id, tv.id, [
			{ userId: erin.id, role: 'edit' },
			{ userId: vic.id, role: 'view' },
			{ userId: otto.id, role: 'view' }
		]);
		const item = items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'The Last of Us',
			status: 'watching'
		});
		items.updateItem(erin.id, item.id, { status: 'watching' });
		items.updateItem(vic.id, item.id, { status: 'paused' });
		items.updateItem(otto.id, item.id, { status: 'completed' });
		// The owner's, then Erin's, Vic's and Otto's
		const statuses = () => [
			items.getItem(owner.id, item.id).status,
			...progressRows(item.id).map((r) => r.status)
		];

		// The owner picks their own status for the new list. Watching (active) becomes Playing, the
		// first active status there; Paused is kept (the new list has it); Completed becomes Beaten.
		items.updateItem(owner.id, item.id, { categoryId: games.id, status: 'beaten' });
		expect(statuses()).toEqual(['beaten', 'playing', 'paused', 'beaten']);

		// Without a status of their own, the owner's moves like everyone's; Concerts has no active
		// status, so those become its first status
		items.updateItem(owner.id, item.id, { categoryId: concerts.id });
		expect(statuses()).toEqual(['seen', 'want', 'want', 'seen']);
	});

	it('the owner’s changes don’t reorder a member’s Recently updated or favorites', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const at = (day: number) => vi.setSystemTime(new Date(`2026-10-0${day}T10:00:00Z`));
			at(1);
			const h = household();
			at(2);
			const talisker = items.createItem(h.owner.id, { categoryId: h.whiskey.id, title: 'Talisker 10' });
			at(3);
			items.updateItem(h.editor.id, talisker.id, { favorite: true });
			at(4);
			items.updateItem(h.editor.id, h.item.id, { favorite: true });
			const recent = (userId: number) =>
				items.listItems(userId, h.whiskey.id, h.statuses, { sort: 'recent' }).rows.map((r) => r.title);
			const favorites = (userId: number) => items.itemStrip(userId, 'favorites').map((r) => r.title);
			expect(recent(h.editor.id)).toEqual(['Lagavulin 16', 'Talisker 10']);
			expect(favorites(h.editor.id)).toEqual(['Lagavulin 16', 'Talisker 10']);
			// Vic hasn't tracked either: newest added first
			expect(recent(h.viewer.id)).toEqual(['Talisker 10', 'Lagavulin 16']);

			// The owner rates and favorites Talisker: it moves up for them only
			at(5);
			items.updateItem(h.owner.id, talisker.id, { rating: 80, favorite: true });
			expect(recent(h.owner.id)).toEqual(['Talisker 10', 'Lagavulin 16']);
			expect(favorites(h.owner.id)).toEqual(['Talisker 10']);
			expect(recent(h.editor.id)).toEqual(['Lagavulin 16', 'Talisker 10']);
			expect(favorites(h.editor.id)).toEqual(['Lagavulin 16', 'Talisker 10']);

			// …and rating Lagavulin doesn't move it up for Vic
			at(6);
			items.updateItem(h.owner.id, h.item.id, { rating: 60 });
			expect(recent(h.owner.id)).toEqual(['Lagavulin 16', 'Talisker 10']);
			expect(recent(h.viewer.id)).toEqual(['Talisker 10', 'Lagavulin 16']);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('logs', () => {
	it('a member’s log moves only their own status and last logged date', () => {
		const h = household();
		items.addLog(h.editor.id, h.item.id, { date: '2026-10-05', rating: 90, notes: 'Lovely' }, h.statuses);
		expect(items.getItem(h.editor.id, h.item.id)).toMatchObject({
			status: 'finished',
			lastLoggedAt: '2026-10-05'
		});
		expect(items.getItem(h.owner.id, h.item.id)).toMatchObject({ status: 'wishlist', lastLoggedAt: null });

		items.addLog(h.owner.id, h.item.id, { date: '2026-10-01' }, h.statuses);
		expect(items.getItem(h.owner.id, h.item.id)).toMatchObject({
			status: 'finished',
			lastLoggedAt: '2026-10-01'
		});
		expect(items.getItem(h.editor.id, h.item.id).lastLoggedAt).toBe('2026-10-05');
	});

	it('the item page shows the viewer’s own logs and everyone else’s progress', () => {
		const h = household();
		items.addLog(h.editor.id, h.item.id, { date: '2026-10-05', rating: 90, notes: 'Lovely' }, h.statuses);
		items.updateItem(h.editor.id, h.item.id, { rating: 90 });
		items.addLog(h.owner.id, h.item.id, { date: '2026-10-01', notes: 'Mine' }, h.statuses);

		const forEditor = items.getItemDetail(h.editor.id, h.item.id);
		expect(forEditor.logs.map((l) => l.notes)).toEqual(['Lovely']);
		expect(forEditor.household).toHaveLength(1);
		expect(forEditor.household[0]).toMatchObject({
			userId: h.owner.id,
			name: 'Daniel',
			owner: true,
			status: 'finished',
			logCount: 1
		});
		expect(forEditor.household[0].logs.map((l) => l.notes)).toEqual(['Mine']);

		const forOwner = items.getItemDetail(h.owner.id, h.item.id);
		expect(forOwner.logs.map((l) => l.notes)).toEqual(['Mine']);
		// The viewer hasn't tracked it, so they aren't listed
		expect(forOwner.household.map((p) => [p.name, p.owner, p.status, p.rating, p.logCount])).toEqual([
			['Erin', false, 'finished', 90, 1]
		]);
		expect(forOwner.household[0].logs[0]).toMatchObject({ date: '2026-10-05', rating: 90, notes: 'Lovely' });

		// The viewer sees both
		expect(
			items
				.getItemDetail(h.viewer.id, h.item.id)
				.household.map((p) => p.name)
				.sort()
		).toEqual(['Daniel', 'Erin']);
	});

	it('the journal and recent activity show only the viewer’s logs, on lists still shared with them', () => {
		const h = household();
		items.addLog(h.editor.id, h.item.id, { date: '2026-10-05' }, h.statuses);
		items.addLog(h.owner.id, h.item.id, { date: '2026-10-06' }, h.statuses);
		const range = { key: 'custom' as const, from: '2026-10-01', to: '2026-10-31' };
		const dates = (userId: number) => journal(userId, range, today, null, 50).entries.map((e) => e.date);
		const recent = (userId: number) => items.recentActivity(userId).map((r) => r.date);

		expect(dates(h.editor.id)).toEqual(['2026-10-05']);
		expect(dates(h.owner.id)).toEqual(['2026-10-06']);
		expect(recent(h.editor.id)).toEqual(['2026-10-05']);
		expect(journal(h.editor.id, range, today, h.whiskey.id, 50).entries).toHaveLength(1);

		leaveList(h.editor.id, h.whiskey.id);
		expect(dates(h.editor.id)).toEqual([]);
		expect(recent(h.editor.id)).toEqual([]);
		expect(listAccess(h.editor.id, h.whiskey.id)).toBeNull();

		// Shared again: their logs and progress come back
		saveShares(h.owner.id, h.whiskey.id, [{ userId: h.editor.id, role: 'view' }]);
		expect(dates(h.editor.id)).toEqual(['2026-10-05']);
		expect(items.getItem(h.editor.id, h.item.id)).toMatchObject({ status: 'finished', access: 'view' });
	});
});

describe('episodes', () => {
	it('two people checking in the same show each have their own episodes and next episode', async () => {
		const owner = person('Daniel');
		const member = person('Erin');
		const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
		saveShares(owner.id, tv.id, [{ userId: member.id, role: 'view' }]);
		const show = items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'The Show',
			status: 'planning',
			provider: 'tmdb',
			providerKind: 'tv',
			providerId: '600'
		});

		await episodes.watchEpisode(owner.id, show.id, { season: 1, episode: 1 }, null, today);
		await episodes.markSeason(member.id, show.id, 1, null, today);
		await episodes.watchEpisode(member.id, show.id, { season: 2, episode: 1 }, { date: today }, today);

		const watched = (userId: number) =>
			episodes
				.watchedEpisodes(show.id, userId)
				.map((w) => `S${w.season}E${w.episode}`)
				.sort();
		expect(watched(owner.id)).toEqual(['S1E1']);
		expect(watched(member.id)).toEqual(['S1E1', 'S1E2', 'S1E3', 'S2E1']);
		expect([...episodes.seasonPlays(show.id, owner.id, 1).keys()]).toEqual([1]);

		const next = async (userId: number) => {
			const t = await episodes.loadTracker(userId, episodes.trackedShow(userId, show.id), today);
			return t.ok ? t.next && [t.next.season, t.next.episode] : null;
		};
		expect(await next(owner.id)).toEqual([1, 2]);
		expect(await next(member.id)).toEqual([2, 2]);

		// Each one's status followed their own check-ins
		expect(items.getItem(owner.id, show.id).status).toBe('watching');
		expect(items.getItem(member.id, show.id).status).toBe('watching');
		expect(items.getItem(owner.id, show.id).lastLoggedAt).toBeNull();
		expect(items.getItem(member.id, show.id).lastLoggedAt).toBe(today);

		// The owner's page lists the member's progress
		const [them] = items.getItemDetail(owner.id, show.id).household;
		expect(them).toMatchObject({ name: 'Erin', episodesWatched: 4, furthest: { season: 2, episode: 1 } });
	});

	it('a member’s current season/episode never becomes the owner’s watched episodes', async () => {
		const { owner, member, tv } = tvHousehold();
		const show = items.createItem(member.id, {
			categoryId: tv.id,
			title: 'Their Show',
			...tmdbShow('800'),
			custom: { current_season: 2, current_episode: 2 }
		});
		const watched = (userId: number) =>
			episodes
				.watchedEpisodes(show.id, userId)
				.map((w) => `S${w.season}E${w.episode}`)
				.sort();
		const tracker = (userId: number) =>
			episodes.loadTracker(userId, episodes.trackedShow(userId, show.id), today);

		// Adding it: the values are dropped, so opening the show gives the owner no plays
		expect(items.getItem(owner.id, show.id).custom).toEqual({});
		expect(await tracker(owner.id)).toMatchObject({ ok: true, watched: 0 });
		expect(watched(owner.id)).toEqual([]);

		// Editing it: the same
		items.updateItem(member.id, show.id, { custom: { current_season: 1, current_episode: 3 } });
		expect(items.getItem(owner.id, show.id).custom).toEqual({});
		expect(await episodes.applySavedProgressNow(owner.id, show.id, today)).toBe('none');
		expect(watched(owner.id)).toEqual([]);

		// The owner's own saved values survive a member's edit, with or without the fields
		items.updateItem(owner.id, show.id, { custom: { current_season: 1, current_episode: 2 } });
		items.updateItem(member.id, show.id, { title: 'Their Show (US)', custom: {} });
		items.updateItem(member.id, show.id, { custom: { current_season: 2, current_episode: 1 } });
		expect(items.getItem(owner.id, show.id)).toMatchObject({
			title: 'Their Show (US)',
			custom: { current_season: 1, current_episode: 2 }
		});
		await tracker(owner.id);
		expect(watched(owner.id)).toEqual(['S1E1', 'S1E2']);
		await tracker(member.id);
		expect(watched(member.id)).toEqual([]);
	});

	it('a member’s card shows their own episode progress, never the owner’s saved season and episode', async () => {
		const { owner, member, tv } = tvHousehold();
		const show = items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'Linked',
			...tmdbShow('900'),
			custom: { current_season: 2, current_episode: 1 }
		});
		items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'Typed in',
			custom: { current_season: 3, current_episode: 4 }
		});
		const card = (userId: number, title: string) =>
			items.listItems(userId, tv.id, tv.statuses, {}).rows.find((r) => r.title === title)!.custom;

		expect(card(owner.id, 'Linked')).toEqual({ current_season: 2, current_episode: 1 });
		expect(card(owner.id, 'Typed in')).toEqual({ current_season: 3, current_episode: 4 });
		expect(card(member.id, 'Linked')).toEqual({});
		expect(card(member.id, 'Typed in')).toEqual({});

		// The member's own check-ins are their progress
		await episodes.watchEpisode(member.id, show.id, { season: 1, episode: 2 }, null, today);
		expect(card(member.id, 'Linked')).toEqual({ current_season: 1, current_episode: 2 });
		expect(card(owner.id, 'Linked')).toEqual({ current_season: 2, current_episode: 1 });
	});
});

describe('deleting', () => {
	it('an editor can delete an item only while nobody else has tracked it', async () => {
		const h = household();
		const fresh = items.createItem(h.editor.id, {
			categoryId: h.whiskey.id,
			title: 'Typo',
			status: 'wishlist'
		});
		expect(items.canDeleteItem(h.editor.id, items.getItem(h.editor.id, fresh.id))).toBe(true);
		await items.deleteItem(h.editor.id, fresh.id);
		await expectStatus(() => items.getItem(h.owner.id, fresh.id), 404);

		// The owner has a status on this one
		expect(items.canDeleteItem(h.editor.id, items.getItem(h.editor.id, h.item.id))).toBe(false);
		await expectStatus(() => items.deleteItem(h.editor.id, h.item.id), 403);

		// Another member logged this one
		const logged = items.createItem(h.editor.id, { categoryId: h.whiskey.id, title: 'Logged' });
		items.addLog(h.viewer.id, logged.id, { date: '2026-10-02' }, h.statuses);
		await expectStatus(() => items.deleteItem(h.editor.id, logged.id), 403);
		expect(items.getItemDetail(h.editor.id, logged.id).canDelete).toBe(false);

		// The owner always can
		expect(items.getItemDetail(h.owner.id, logged.id).canDelete).toBe(true);
		await items.deleteItem(h.owner.id, logged.id);
		await items.deleteItem(h.owner.id, h.item.id);
		expect(items.listItems(h.owner.id, h.whiskey.id, h.statuses, {}).total).toBe(0);
	});

	it('deleting the list removes its shares and everyone’s progress', () => {
		const h = household();
		items.updateItem(h.editor.id, h.item.id, { status: 'open' });
		expect(progressRows(h.item.id)).toHaveLength(1);
		deleteCategory(h.owner.id, h.whiskey.id);
		expect(listCategories(h.editor.id)).toEqual([]);
		expect(
			rawDb().prepare('SELECT COUNT(*) AS n FROM list_shares WHERE category_id = ?').get(h.whiskey.id)
		).toEqual({
			n: 0
		});
		expect(progressRows(h.item.id)).toEqual([]);
	});
});

describe('sharing settings', () => {
	it('saveShares is for the owner, and skips unknown people and the owner', async () => {
		const h = household();
		await expectStatus(() => saveShares(h.outsider.id, h.whiskey.id, []), 404);
		saveShares(h.owner.id, h.whiskey.id, [
			{ userId: 999_999, role: 'edit' },
			{ userId: h.owner.id, role: 'view' },
			{ userId: h.viewer.id, role: 'edit' },
			{ userId: h.editor.id, role: null }
		]);
		expect(access.listSharesOf(h.whiskey.id).map((s) => [s.id, s.role])).toEqual([[h.viewer.id, 'edit']]);
		expect(listAccess(h.owner.id, h.whiskey.id)).toBe('owner');
		expect(listAccess(h.editor.id, h.whiskey.id)).toBeNull();
		expect(access.householdMembers(h.owner.id).map((p) => p.id)).not.toContain(h.owner.id);
	});

	it('leaveList and setMyListSettings', async () => {
		const h = household();
		setMyListSettings(h.owner.id, h.whiskey.id, { showInCalendar: false });
		setMyListSettings(h.viewer.id, h.whiskey.id, { showUpNext: false });
		expect(getCategoryById(h.owner.id, h.whiskey.id).category).toMatchObject({
			showUpNext: true,
			showInCalendar: false
		});
		expect(getCategoryById(h.viewer.id, h.whiskey.id).category).toMatchObject({
			showUpNext: false,
			showInCalendar: true
		});
		await expectStatus(() => setMyListSettings(h.outsider.id, h.whiskey.id, { showUpNext: false }), 404);

		leaveList(h.viewer.id, h.whiskey.id);
		expect(listCategories(h.viewer.id)).toEqual([]);
		await expectStatus(() => items.getItem(h.viewer.id, h.item.id), 404);
		expect(getCategoryById(h.owner.id, h.whiskey.id).category.sharedWith).toBe(1);
	});

	it('canSeeUpload: your own folder, photos on items you can see, nothing else', () => {
		const h = household();
		const secret = createCategoryFromTemplate(h.owner.id, 'cheese');
		const hidden = items.createItem(h.owner.id, { categoryId: secret.id, title: 'Secret' });
		const photo = (itemId: number, path: string) =>
			db()
				.insert(schema.images)
				.values({ userId: h.owner.id, itemId, kind: 'upload', path, thumbPath: `${path}.thumb.webp` })
				.run();
		photo(h.item.id, `u${h.owner.id}/shared.webp`);
		photo(hidden.id, `u${h.owner.id}/hidden.webp`);

		expect(canSeeUpload(h.editor.id, `u${h.editor.id}/anything.webp`)).toBe(true);
		expect(canSeeUpload(h.viewer.id, `u${h.owner.id}/shared.webp`)).toBe(true);
		expect(canSeeUpload(h.viewer.id, `u${h.owner.id}/shared.webp.thumb.webp`)).toBe(true);
		expect(canSeeUpload(h.outsider.id, `u${h.owner.id}/shared.webp`)).toBe(false);
		expect(canSeeUpload(h.editor.id, `u${h.owner.id}/hidden.webp`)).toBe(false);
		expect(canSeeUpload(h.editor.id, `u${h.owner.id}/unknown.webp`)).toBe(false);
	});
});

describe('releases', () => {
	it('a member’s Calendar shows a shared show, with their own toggle and dropped status', async () => {
		const owner = person('Daniel');
		const member = person('Erin');
		const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
		saveShares(owner.id, tv.id, [{ userId: member.id, role: 'view' }]);
		const show = items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'The Show',
			status: 'watching',
			provider: 'tmdb',
			providerKind: 'tv',
			providerId: '700'
		});
		const titles = (userId: number) =>
			releases.releasesBetween(userId, '2026-10-01', '2026-10-31').map((e) => `${e.title} ${e.label}`);

		const result = await releases.refreshReleases(member.id);
		expect(result).toMatchObject({ items: 1, releases: 3, failed: 0 });
		const rows = db()
			.select()
			.from(schema.releases)
			.all()
			.filter((r) => r.itemId === show.id);
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([owner.id]));
		expect(titles(member.id)).toEqual(['The Show S2 E1', 'The Show S2 E2', 'The Show S2 E3']);
		expect(titles(owner.id)).toHaveLength(3);
		expect(releases.calendarLists(member.id)).toEqual([
			expect.objectContaining({
				id: tv.id,
				ownerName: 'Daniel',
				shown: true,
				slug: `tv-shows@${owner.username}`
			})
		]);

		// The member's own Calendar choice
		releases.setListInCalendar(member.id, tv.id, false);
		expect(titles(member.id)).toEqual([]);
		expect(titles(owner.id)).toHaveLength(3);
		releases.setListInCalendar(member.id, tv.id, true);

		// The member drops it: gone from their Calendar, still in the owner's, and a look-up keeps it
		items.updateItem(member.id, show.id, { status: 'dropped' });
		expect(titles(member.id)).toEqual([]);
		await releases.refreshReleases(member.id);
		expect(titles(owner.id)).toHaveLength(3);

		// Once the owner drops it too, the next look-up forgets the dates
		items.updateItem(owner.id, show.id, { status: 'dropped' });
		await releases.refreshReleases(owner.id);
		expect(
			db()
				.select()
				.from(schema.releases)
				.all()
				.filter((r) => r.itemId === show.id)
		).toEqual([]);
	});
});

describe('imports', () => {
	it('a Yamtrack import never touches someone else’s list, even when a shared list matches', () => {
		const owner = person('Daniel');
		const member = person('Erin');
		const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
		saveShares(owner.id, tv.id, [{ userId: member.id, role: 'edit' }]);
		const theirs = items.createItem(owner.id, {
			categoryId: tv.id,
			title: 'Game of Thrones',
			status: 'planning',
			provider: 'tmdb',
			providerKind: 'tv',
			providerId: '1399'
		});

		const csv = [
			'media_id,source,media_type,title,image,season_number,episode_number,score,progress,status,start_date,end_date,notes',
			'1399,tmdb,season,Game of Thrones,,1,,9,10,Completed,2019-01-01,2019-01-20,',
			'1399,tmdb,episode,Game of Thrones,,1,10,,,,,2019-01-20,'
		].join('\n');
		const plan = yam.planYamtrackImport(csv);
		expect(yam.resolveTargets(member.id, ['tv']).tv.categoryId).toBeNull();
		const r = yam.applyYamtrackImport(member.id, plan);
		expect(r).toMatchObject({ created: 1, updated: 0, createdCategories: ['TV Shows'] });

		// The owner's show is as it was
		expect(items.getItem(owner.id, theirs.id)).toMatchObject({
			status: 'planning',
			rating: null,
			userId: owner.id
		});
		expect(items.getItem(member.id, theirs.id).status).toBeNull();
		expect(episodes.watchedEpisodes(theirs.id, member.id)).toEqual([]);
		expect(progressRows(theirs.id)).toEqual([]);
		// The import went into the member's own new list
		const own = listCategories(member.id).find((c) => c.access === 'owner')!;
		const { rows } = items.listItems(member.id, own.id, own.statuses, {});
		expect(rows.map((x) => [x.title, x.status])).toEqual([['Game of Thrones', 'completed']]);
		expect(items.getItem(member.id, rows[0].id).userId).toBe(member.id);
	});

	it('a spreadsheet import is for the list’s owner only', async () => {
		const h = household();
		expect(listContext(h.owner.id, h.whiskey.id).name).toBe('Whiskey');
		await expectStatus(() => listContext(h.editor.id, h.whiskey.id), 403);
		await expectStatus(() => listContext(h.viewer.id, h.whiskey.id), 403);
		await expectStatus(() => listContext(h.outsider.id, h.whiskey.id), 404);
	});

	it('adding a source entry to a shared list the owner already has privately gives a clear error', async () => {
		const owner = person('Daniel');
		const member = person('Erin');
		const shared = createCategoryFromTemplate(owner.id, 'movies');
		const hidden = createCategoryFromTemplate(owner.id, 'movies');
		saveShares(owner.id, shared.id, [{ userId: member.id, role: 'edit' }]);
		const ref = { provider: 'tmdb', kind: 'movie', id: '438631' };
		items.createItem(owner.id, {
			categoryId: hidden.id,
			title: 'Dune',
			provider: ref.provider,
			providerKind: ref.kind,
			providerId: ref.id
		});
		const input = { ...ref, categoryId: shared.id, status: null, rating: null, logDate: null };

		const caught = await addFromProvider(member.id, input).then(
			() => null,
			(e: { status?: number; body?: { message?: string } }) => e
		);
		expect(caught?.status).toBe(409);
		expect(caught?.body?.message).toBe("Daniel already has this in a list that isn't shared with you.");

		// On a list the member can see, it's the existing item instead
		const visible = items.createItem(owner.id, {
			categoryId: shared.id,
			title: 'Arrival',
			provider: 'tmdb',
			providerKind: 'movie',
			providerId: '329865'
		});
		expect(await addFromProvider(member.id, { ...input, id: '329865' })).toEqual({
			id: visible.id,
			created: false
		});
	});
});

describe('editing a shared item', () => {
	it('moving with a status the new list lacks (a blank status menu) gives the mover its closest one', () => {
		const owner = person('Daniel');
		const tv = createCategoryFromTemplate(owner.id, 'tv-shows');
		const games = createCategoryFromTemplate(owner.id, 'video-games');
		const show = items.createItem(owner.id, { categoryId: tv.id, title: 'Severance', status: 'watching' });
		const playing = items.statusInList('watching', tv.statuses, games.statuses);
		expect(games.statuses.find((s) => s.key === playing)?.group).toBe('active');
		items.updateItem(owner.id, show.id, { categoryId: games.id, status: null });
		expect(items.getItem(owner.id, show.id).status).toBe(playing);
	});

	it('a “Current episode” field on a list that isn’t for shows is shared like any other field', () => {
		const h = household();
		categories.addFieldDefinition(h.whiskey.id, {
			label: 'Current episode',
			type: 'number',
			scope: 'item',
			showOnCard: true
		});
		const pod = items.createItem(h.editor.id, {
			categoryId: h.whiskey.id,
			title: 'Cask strength podcast',
			custom: { current_episode: 12 }
		});
		items.updateItem(h.editor.id, pod.id, { custom: { current_episode: 41 } });
		expect(items.getItem(h.owner.id, pod.id).custom).toEqual({ current_episode: 41 });
		const row = items.listItems(h.viewer.id, h.whiskey.id, h.statuses, {}).rows.find((r) => r.id === pod.id);
		expect(row?.custom).toEqual({ current_episode: 41 });
	});

	it('an editor saving the whole form with only their own rating changed doesn’t count as an edit', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
			const h = household();
			const updatedAt = () =>
				(rawDb().prepare('SELECT updated_at AS t FROM items WHERE id = ?').get(h.item.id) as { t: number }).t;
			const before = updatedAt();
			vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
			// What the edit form sends: every field, unchanged, plus the editor's own rating
			items.updateItem(
				h.editor.id,
				h.item.id,
				{
					categoryId: h.whiskey.id,
					title: 'Lagavulin 16',
					subtitle: '',
					description: null,
					barcode: '',
					custom: {},
					rating: 70
				},
				['peated']
			);
			expect(updatedAt()).toBe(before);
			expect(items.getItem(h.editor.id, h.item.id).rating).toBe(70);
			expect(items.getItem(h.owner.id, h.item.id).rating).toBeNull();
			// A real change is an edit
			items.updateItem(h.editor.id, h.item.id, { title: 'Lagavulin 16 Year Old' });
			expect(updatedAt()).toBeGreaterThan(before);
		} finally {
			vi.useRealTimers();
		}
	});
});
