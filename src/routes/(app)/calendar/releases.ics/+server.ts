import { addDays } from '$lib/journal';
import { todayIso } from '$lib/server/forms';
import { icsCalendar } from '$lib/server/ics';
import { releasesBetween } from '$lib/server/services/releases';
import type { RequestHandler } from './$types';

/** The coming year of releases from the lists shown in the Calendar, for Apple/Google/Outlook calendars. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const today = todayIso();
	const events = releasesBetween(locals.user!.id, today, addDays(today, 365), 5000);
	const host = url.hostname || 'whatever-tracker';
	const body = icsCalendar(
		'Whatever Tracker releases',
		events.map((e) => ({
			uid: `release-${e.id}@${host}`,
			date: e.date,
			summary: e.kind === 'episode' ? `${e.title} ${e.label}` : `${e.title} (${e.label.toLowerCase()})`,
			description: [e.episodeTitle, `${e.categoryIcon} ${e.categoryName}`, `${url.origin}/items/${e.itemId}`]
				.filter(Boolean)
				.join('\n')
		}))
	);
	return new Response(body, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'attachment; filename="whatever-tracker-releases.ics"',
			'Cache-Control': 'private, no-store'
		}
	});
};
