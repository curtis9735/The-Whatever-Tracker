import type { SetlistEvent } from './types';

type Song = SetlistEvent['songs'][number] & { n: number };

/** Splits a setlist into its sets (main set, "Set 2", "Encore"…), numbering songs straight through. */
export function setlistSections(songs: SetlistEvent['songs']) {
	const sections: { label?: string; songs: Song[] }[] = [];
	songs.forEach((s, i) => {
		const last = sections.at(-1);
		const song = { ...s, n: i + 1 };
		if (last && last.label === s.set) last.songs.push(song);
		else sections.push({ label: s.set, songs: [song] });
	});
	return sections;
}
