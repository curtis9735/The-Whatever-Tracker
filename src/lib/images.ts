export interface ImageRef {
	kind: 'upload' | 'url_copy' | 'url_link';
	path: string | null;
	thumbPath: string | null;
	sourceUrl: string | null;
}

/** Browser URL for an image row. Thumbnails are used in lists and grids. */
export function imageSrc(img: ImageRef | null | undefined, size: 'thumb' | 'full' = 'thumb'): string | null {
	if (!img) return null;
	if (img.kind === 'url_link') return img.sourceUrl;
	const rel = size === 'thumb' ? img.thumbPath || img.path : img.path;
	return rel ? `/media/${rel}` : null;
}
