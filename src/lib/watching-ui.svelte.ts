// Watching now, in the browser: the clock the countdowns run on, and the buttons' form handling.
// The app layout starts the clock once (watchClock); everything else reads `clockNow()`.

import { untrack } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import type { SubmitFunction } from '@sveltejs/kit';
import type { WatchingState } from './watching';

/** If the server still says it's running when the time is up (clocks a little apart), ask again this often */
const RETRY_MS = 5_000;
const MAX_TRIES = 4;

const clock = $state({
	/** The server's time, as best we know it (ms) */
	now: 0,
	/** False until the layout's clock runs (on the server, and while the page hydrates) */
	ready: false,
	/** Components showing someone else's countdown (the Household card) */
	extra: 0
});

/** The device's clock is this far behind the server's */
let offset = 0;

/** Now, on the server's clock. Before the clock runs, the time the page was loaded (so it hydrates as rendered). */
export function clockNow(serverNow: number) {
	return clock.ready ? clock.now : serverNow;
}

/**
 * Whether the browser's clock runs (after hydration). Clock times ("8:02 PM") wait for it: on the
 * server they'd be in the server's time zone.
 */
export function clockReady() {
	return clock.ready;
}

/** Keeps the clock ticking while `active()` (for countdowns that aren't the viewer's own) */
export function keepTicking(active: () => boolean) {
	$effect(() => {
		if (!active()) return;
		// untrack: counting must not make this effect depend on the count
		untrack(() => clock.extra++);
		return () => untrack(() => clock.extra--);
	});
}

/**
 * Runs the clock: called once, by the app layout. Ticks every second while the page is visible and
 * a countdown is showing, reloads once when the viewer's own countdown runs out (so the server can
 * mark it watched), and reloads when the page comes back into view (a phone that was locked)
 */
export function watchClock(state: () => WatchingState) {
	// Each load brings the server's time
	$effect(() => {
		const s = state();
		offset = s.now - Date.now();
		clock.now = s.now;
		clock.ready = true;
	});

	$effect(() => {
		const live = state().live;
		const running = (!!live && live.pausedAt === null) || clock.extra > 0;
		if (!running) return;
		let timer: ReturnType<typeof setInterval> | undefined;
		const tick = () => (clock.now = Date.now() + offset);
		const sync = () => {
			clearInterval(timer);
			timer = undefined;
			if (document.visibilityState !== 'visible') return;
			tick();
			timer = setInterval(tick, 1000);
		};
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', sync);
		};
	});

	// Coming back to the page: what happened meanwhile (finished on its own, or changed on another device)
	$effect(() => {
		if (!state().live) return;
		const onVisible = () => {
			if (document.visibilityState === 'visible') invalidateAll();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	// Time's up: reload once, then a few more times a little later if the server hasn't caught up yet
	let dueKey = '';
	let tries = 0;
	$effect(() => {
		const live = state().live;
		if (!live || live.pausedAt !== null) return;
		const key = `${live.id}:${live.endsAt}`;
		if (key !== dueKey) {
			dueKey = key;
			tries = 0;
		}
		if (tries >= MAX_TRIES) return;
		const wait = tries ? RETRY_MS : Math.max(0, live.endsAt - (Date.now() + offset));
		// setTimeout can't wait longer than about 24 days; a check-in never runs that long
		const timer = setTimeout(
			() => {
				tries++;
				invalidateAll();
			},
			Math.min(wait, 2 ** 31 - 1)
		);
		return () => clearTimeout(timer);
	});
}

/** The running check-in that's in the way of a new one (see the /watching start action) */
export interface WatchConflictInfo {
	title: string;
	label: string | null;
	itemId: number;
}

/**
 * Form handling for the Watching now buttons, which post to /watching from any page: one change at a
 * time (taps while one is being saved are ignored), then the whole page is reloaded so the bar, the
 * status, the episode tracker and the history all show it
 */
export function watchForms(onchanged?: () => void) {
	const ui = $state({
		busy: false,
		problem: null as string | null,
		conflict: null as WatchConflictInfo | null
	});
	let pending = false;

	function submit(
		opts: { confirm?: string; onsuccess?: (data: Record<string, unknown>) => void } = {}
	): SubmitFunction {
		return ({ cancel }) => {
			if (pending || (opts.confirm && !confirm(opts.confirm))) {
				cancel();
				return;
			}
			pending = ui.busy = true;
			ui.problem = null;
			return async ({ result }) => {
				try {
					if (result.type === 'success') {
						ui.conflict = null;
						opts.onsuccess?.(result.data ?? {});
					} else if (result.type === 'failure') {
						const d = result.data ?? {};
						if (d.conflict) ui.conflict = d.conflict as WatchConflictInfo;
						else ui.problem = (d.watchError as string | undefined) ?? 'That didn’t work. Try again.';
					} else if (result.type === 'error') {
						ui.problem = result.error?.message ?? 'That didn’t work. Try again.';
					} else if (result.type === 'redirect') {
						await goto(result.location);
						return;
					}
					// Taps stay blocked until the page shows the change
					await invalidateAll();
				} finally {
					pending = ui.busy = false;
					onchanged?.();
				}
			};
		};
	}

	return { ui, submit };
}

/** "8:02 PM" */
export function clockTime(ms: number) {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
