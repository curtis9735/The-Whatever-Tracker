import fs from 'node:fs';
import path from 'node:path';
import { error, json, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { cfg } from '$lib/server/config';
import { db } from '$lib/server/db';
import {
	SESSION_COOKIE,
	ensureSetupCode,
	setSessionCookie,
	userCount,
	validateSessionToken
} from '$lib/server/auth';
import { startBackupScheduler } from '$lib/server/backup';

export const init: ServerInit = async () => {
	const c = cfg();
	for (const dir of [c.dataDir, c.uploadsDir, c.backupsDir, c.tmpDir]) fs.mkdirSync(dir, { recursive: true });
	db(); // opens the database and applies migrations
	// Leftover import uploads older than a day
	for (const f of fs.readdirSync(c.tmpDir)) {
		const p = path.join(c.tmpDir, f);
		if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { force: true });
	}
	ensureSetupCode();
	startBackupScheduler();
	console.log(`[startup] data directory: ${c.dataDir}`);
};

const PUBLIC_PATHS = ['/login', '/setup', '/api/health'];

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE) ?? null;
	event.locals.user = null;
	event.locals.sessionId = null;
	if (token) {
		const { session, user, renewed } = validateSessionToken(token);
		if (session && user) {
			event.locals.user = user;
			event.locals.sessionId = session.id;
			if (renewed) setSessionCookie(event.cookies, token, session.expiresAt, event.url.protocol === 'https:');
		} else {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		}
	}

	const p = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((x) => p === x || p.startsWith(`${x}/`)) || p.startsWith('/_app/');
	if (!isPublic && !event.locals.user) {
		if (p.startsWith('/api/') || p.startsWith('/media/')) {
			if (p.startsWith('/api/')) return json({ message: 'Not signed in' }, { status: 401 });
			error(401, 'Not signed in');
		}
		const target = userCount() === 0 ? '/setup' : `/login?next=${encodeURIComponent(p + event.url.search)}`;
		redirect(303, target);
	}

	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
	// Served over HTTPS (ORIGIN is https://…): browsers should never fall back to plain HTTP
	if (event.url.protocol === 'https:') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000');
	}
	return response;
};
