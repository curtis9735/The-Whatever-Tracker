import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import type { Cookies } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { cfg } from './config';
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

// --- Sign-in throttling ---------------------------------------------------------------
//
// Two limits, so that neither many addresses nor many usernames buy unlimited guesses:
//  - per address: 20 failed sign-ins per 15 minutes, whatever usernames were tried
//  - per account: 10 failed sign-ins per 15 minutes, from anywhere. This one still holds if
//    the app is reached without the proxy and the client address can be faked.
// A browser that has signed in to an account before carries a trusted-device cookie and skips
// the per-account limit, so someone guessing at your username can't lock you out.

/** Client IP for throttling. adapter-node throws if ADDRESS_HEADER is set but the request skipped the proxy. */
export function clientAddress(getClientAddress: () => string) {
	try {
		return getClientAddress();
	} catch {
		return 'direct';
	}
}

const WINDOW = 15 * 60 * 1000;

export class FailureCounter {
	private entries = new Map<string, { count: number; resetAt: number }>();
	constructor(
		private max: number,
		private windowMs = WINDOW
	) {}

	allowed(key: string, now = Date.now()) {
		const entry = this.entries.get(key);
		return !entry || entry.resetAt < now || entry.count < this.max;
	}

	fail(key: string, now = Date.now()) {
		const entry = this.entries.get(key);
		if (!entry || entry.resetAt < now) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
		else entry.count++;
		if (this.entries.size > 5000) {
			for (const [k, v] of this.entries) if (v.resetAt < now) this.entries.delete(k);
		}
	}

	clear(key: string) {
		this.entries.delete(key);
	}
}

/** Failed sign-ins (and setup-code guesses) per client address */
export const addressFailures = new FailureCounter(20);
/** Failed sign-ins per username, from any address */
export const accountFailures = new FailureCounter(10);
/** Wrong "current password" when changing it, per user (a stolen session can't brute-force it) */
export const passwordCheckFailures = new FailureCounter(5);

// A wrong username must take as long as a wrong password, or response times reveal which
// usernames exist. Unknown usernames are checked against this throwaway hash.
let dummyHash: Promise<string> | null = null;

export async function verifyPasswordOrDummy(passwordHash: string | null, password: string) {
	if (passwordHash) return verifyPassword(passwordHash, password);
	dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
	await verifyPassword(await dummyHash, password);
	return false;
}

// --- Trusted devices --------------------------------------------------------------------

const DEVICE_COOKIE = 'wt_device';
let deviceSecret: Buffer | null = null;

/** A random key kept in the data folder, so trusted devices survive restarts and updates. */
function secret() {
	if (deviceSecret) return deviceSecret;
	const file = path.join(cfg().dataDir, 'device-secret');
	try {
		deviceSecret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
	} catch {
		deviceSecret = null;
	}
	if (!deviceSecret || deviceSecret.length < 32) {
		deviceSecret = crypto.randomBytes(32);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, deviceSecret.toString('hex'), { mode: 0o600 });
	}
	return deviceSecret;
}

function deviceProof(username: string) {
	return crypto.createHmac('sha256', secret()).update(`device:${username}`).digest('base64url');
}

/** This browser has signed in to `username` before. */
export function isTrustedDevice(cookies: Cookies, username: string) {
	const value = cookies.get(DEVICE_COOKIE);
	if (!value || !username) return false;
	const a = Buffer.from(value);
	const b = Buffer.from(deviceProof(username));
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function rememberDevice(cookies: Cookies, username: string, secure: boolean) {
	cookies.set(DEVICE_COOKIE, deviceProof(username), {
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		secure,
		maxAge: 365 * 24 * 60 * 60
	});
}

// --- Redirects --------------------------------------------------------------------------

/**
 * Where to go after signing in: only ever a page of this app. "//evil.com", "/\evil.com"
 * and the like resolve to another site, so anything not on this origin goes home instead.
 */
export function safeRedirectTarget(next: string | null, origin: string) {
	if (!next) return '/';
	try {
		const target = new URL(next, origin);
		if (target.origin !== origin) return '/';
		return `${target.pathname}${target.search}${target.hash}` || '/';
	} catch {
		return '/';
	}
}
