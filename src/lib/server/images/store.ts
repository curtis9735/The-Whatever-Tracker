import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { cfg, userAgent } from '../config';
import { fetchPublicImage, UnsafeUrlError } from './ssrf';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 2048;
const THUMB_EDGE = 480;

export interface StoredImage {
	path: string;
	thumbPath: string;
	width: number;
	height: number;
}

export class ImageError extends Error {}

/** Normalizes any image: EXIF-rotates, strips metadata (incl. GPS), resizes, saves WebP + thumbnail. */
export async function storeImageBuffer(userId: number, input: Buffer): Promise<StoredImage> {
	const id = crypto.randomUUID();
	const rel = `u${userId}/${id}.webp`;
	const relThumb = `u${userId}/t/${id}.webp`;
	const root = cfg().uploadsDir;
	await fs.mkdir(path.join(root, `u${userId}`, 't'), { recursive: true });

	let base: Sharp;
	try {
		base = sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate();
		await base.metadata();
	} catch {
		throw new ImageError('That file is not an image we can read (JPEG, PNG, WebP, GIF, AVIF or TIFF).');
	}
	try {
		const main = await base
			.clone()
			.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 82 })
			.toFile(path.join(root, rel));
		await base
			.clone()
			.resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: 74 })
			.toFile(path.join(root, relThumb));
		return { path: rel, thumbPath: relThumb, width: main.width, height: main.height };
	} catch {
		await deleteStoredFiles({ path: rel, thumbPath: relThumb });
		throw new ImageError('That image could not be processed. HEIC photos must be converted to JPEG first.');
	}
}

export async function storeUploadedFile(userId: number, file: File): Promise<StoredImage> {
	if (file.size === 0) throw new ImageError('The uploaded file is empty.');
	if (file.size > MAX_UPLOAD_BYTES) throw new ImageError('Images must be 20 MB or smaller.');
	return storeImageBuffer(userId, Buffer.from(await file.arrayBuffer()));
}

export async function storeImageFromUrl(userId: number, url: string): Promise<StoredImage> {
	let buf: Buffer;
	try {
		buf = await fetchPublicImage(url, { userAgent: userAgent() });
	} catch (e) {
		if (e instanceof UnsafeUrlError) throw new ImageError(e.message);
		throw new ImageError('Could not download that image.');
	}
	return storeImageBuffer(userId, buf);
}

export async function deleteStoredFiles(img: { path: string | null; thumbPath: string | null }) {
	const root = cfg().uploadsDir;
	for (const rel of [img.path, img.thumbPath]) {
		if (!rel || !isSafeRelativePath(rel)) continue;
		await fs.rm(path.join(root, rel), { force: true }).catch(() => {});
	}
}

/** Uploaded files are always `u<id>/<uuid>.webp` or `u<id>/t/<uuid>.webp`. */
export function isSafeRelativePath(rel: string) {
	return /^u\d+\/(t\/)?[0-9a-f-]{36}\.webp$/.test(rel);
}

export function absoluteUploadPath(rel: string) {
	return path.join(cfg().uploadsDir, rel);
}
