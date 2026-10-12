import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-link-'));
	return { env: { DATA_DIR: dir, MIGRATIONS_DIR: path.resolve('drizzle'), TMDB_API_KEY: 'test-key' } };
});

const { db, schema } = await import('./db');
const { createCategoryFromTemplate } = await import('./services/categories');
const items = await import('./services/items');
const { linkToProvider, MatchError, parseMatch } = await import('./services/provider-items');

afterEach(() => vi.unstubAllGlobals());

// Trimmed TMDB /movie/259316?append_to_response=credits
const fantasticBeasts = {
	id: 259316,
	title: 'Fantastic Beasts and Where to Find Them',
	release_date: '2016-11-16',
	runtime: 133,
	overview: 'In 1926, Newt Scamander arrives at the Magical Congress of the United States of America…',
	poster_path: '/h6NYfVUyM6CDURtZSnBpz647Ldd.jpg',
	genres: [{ name: 'Fantasy' }, { name: 'Adventure' }],
	credits: { crew: [{ name: 'David Yates', job: 'Director' }], cast: [{ name: 'Eddie Redmayne' }] }
};

function form(entries: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(entries)) fd.set(k, v);
	return fd;
}

describe('parseMatch', () => {
	it('accepts a known source and kind', () => {
		expect(parseMatch(form({ match_provider: 'tmdb', match_kind: 'movie', match_id: '259316' }))).toEqual({
			provider: 'tmdb',
			kind: 'movie',
			id: '259316'
		});
	});

	it('ignores missing or made-up matches', () => {
		expect(parseMatch(form({}))).toBeNull();
		expect(parseMatch(form({ match_provider: 'evil', match_kind: 'movie', match_id: '1' }))).toBeNull();
		expect(parseMatch(form({ match_provider: 'tmdb', match_kind: 'album', match_id: '1' }))).toBeNull();
		expect(parseMatch(form({ match_provider: 'tmdb', match_kind: 'movie', match_id: '../x' }))).toBeNull();
	});
});

describe('linkToProvider', () => {
	const user = db()
		.insert(schema.users)
		.values({ username: 'u', displayName: 'u', passwordHash: 'x' })
		.returning()
		.get();
	const movies = createCategoryFromTemplate(user.id, 'movies');

	it('fills in poster and details for an item added by hand, keeping its title', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(fantasticBeasts), { status: 200 }))
		);
		const item = items.createItem(user.id, { categoryId: movies.id, title: 'fantastic beasts' });
		await linkToProvider(user.id, item.id, { provider: 'tmdb', kind: 'movie', id: '259316' });

		const d = items.getItemDetail(user.id, item.id);
		expect(d.item).toMatchObject({
			title: 'fantastic beasts',
			subtitle: '2016 · David Yates',
			provider: 'tmdb',
			providerKind: 'movie',
			providerId: '259316',
			externalUrl: 'https://www.themoviedb.org/movie/259316'
		});
		expect(d.item.description).toMatch(/Newt Scamander/);
		expect(d.cover?.sourceUrl).toBe('https://image.tmdb.org/t/p/w780/h6NYfVUyM6CDURtZSnBpz647Ldd.jpg');
		expect((d.item.metadata as { genres: string[] }).genres).toEqual(['Fantasy', 'Adventure']);
	});

	it('refuses to create a second copy of something already linked', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(fantasticBeasts), { status: 200 }))
		);
		const dup = items.createItem(user.id, { categoryId: movies.id, title: 'Fantastic Beasts again' });
		await expect(
			linkToProvider(user.id, dup.id, { provider: 'tmdb', kind: 'movie', id: '259316' })
		).rejects.toBeInstanceOf(MatchError);
	});
});
