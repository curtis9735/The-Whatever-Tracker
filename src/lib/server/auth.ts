import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Cookies } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { db, schema } from './db';

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;
export const SESSION_COOKIE = 'wt_session';

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, outputLen: 32, parallelism: 1 };

export function hashPassword(password: string) {
	return hash(password, ARGON_OPTS);
}

export function verifyPassword(passwordHash: string, password: string) {
	return verify(passwordHash, password, ARGON_OPTS).catch(() => false);
}

export function generateSessionToken() {
	return crypto.randomBytes(24).toString('base64url');
}

function sessionIdFromToken(token: string) {
	return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(token: string, userId: number) {
	const session = {
		id: sessionIdFromToken(token),
		userId,
		expiresAt: new Date(Date.now() + SESSION_TTL)
	};
	db().insert(schema.sessions).values(session).run();
	return session;
}

export function validateSessionToken(token: string) {
	const sessionId = sessionIdFromToken(token);
	const row = db()
		.select({ session: schema.sessions, user: schema.users })
		.from(schema.sessions)
		.innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
		.where(eq(schema.sessions.id, sessionId))
		.get();
	if (!row) return { session: null, user: null, renewed: false };

	const { session, user } = row;
	if (Date.now() >= session.expiresAt.getTime()) {
		db().delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
		return { session: null, user: null, renewed: false };
	}
	// Sliding renewal: extend once the session is half used up
	let renewed = false;
	if (Date.now() >= session.expiresAt.getTime() - SESSION_TTL / 2) {
		renewed = true;
		session.expiresAt = new Date(Date.now() + SESSION_TTL);
		db()
			.update(schema.sessions)
			.set({ expiresAt: session.expiresAt })
			.where(eq(schema.sessions.id, sessionId))
			.run();
	}
	return {
		session,
		renewed,
		user: {
			id: user.id,
			username: user.username,
			displayName: user.displayName,
			isAdmin: user.isAdmin,
			onboarded: user.onboarded
		}
	};
}

export function invalidateSession(sessionId: string) {
	db().delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
}

export function invalidateUserSessions(userId: number) {
	db().delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
}

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date, secure: boolean) {
	cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		secure,
		expires: expiresAt
	});
}

export function clearSessionCookie(cookies: Cookies, secure: boolean) {
	cookies.delete(SESSION_COOKIE, { path: '/', secure });
}

export function userCount() {
	return db().select({ n: count() }).from(schema.users).get()?.n ?? 0;
}

export function normalizeUsername(raw: string) {
	return raw.trim().toLowerCase();
}

export function validateUsername(u: string) {
	if (!/^[a-z0-9._-]{2,32}$/.test(u)) {
		return 'Usernames are 2–32 characters: letters, numbers, dot, dash or underscore.';
	}
	return null;
}

export function validatePassword(p: string) {
	if (p.length < 8) return 'Passwords need at least 8 characters.';
	if (p.length > 256) return 'That password is too long.';
	return null;
}

// --- One-time setup code ---------------------------------------------------------------

let setupCode: string | null = null;

/** Called at server start: prints a setup code to the logs when no account exists yet. */
export function ensureSetupCode() {
	if (userCount() > 0) {
		setupCode = null;
		return;
	}
	if (!setupCode) {
		const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		setupCode = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
	}
	console.log(
		[
			'',
			'================================================================',
			'  The Whatever Tracker: no accounts yet.',
			`  Open /setup in your browser and enter this code:  ${setupCode}`,
			'================================================================',
			''
		].join('\n')
	);
}

export function checkSetupCode(code: string) {
	if (!setupCode) return false;
	const a = Buffer.from(code.trim().toUpperCase());
	const b = Buffer.from(setupCode);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearSetupCode() {
	setupCode = null;
}

// --- Login throttling -----------------------------------------------------------------

/** Client IP for throttling. adapter-node throws if ADDRESS_HEADER is set but the request skipped the proxy. */
export function clientAddress(getClientAddress: () => string) {
	try {
		return getClientAddress();
	} catch {
		return 'direct';
	}
}

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW = 15 * 60 * 1000;

export function loginAllowed(key: string) {
	const now = Date.now();
	const entry = attempts.get(key);
	if (!entry || entry.resetAt < now) return true;
	return entry.count < MAX_ATTEMPTS;
}

export function recordFailedLogin(key: string) {
	const now = Date.now();
	const entry = attempts.get(key);
	if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW });
	else entry.count++;
	if (attempts.size > 5000) {
		for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
	}
}

export function clearFailedLogins(key: string) {
	attempts.delete(key);
}
