import type { StatusDef } from './types';

/**
 * Statuses in the "done" group (Completed, Tasted, Seen, Played…) mean it already happened,
 * so adding something with one of them also records *when* as its first log.
 */
export function isFinished(statuses: StatusDef[], key: string | null | undefined) {
	return statuses.find((s) => s.key === key)?.group === 'done';
}
