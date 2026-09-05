import { sanitizeWfmSlug } from '../../../config/shared/textNormalize';

// The custom domain always supplies cf-connecting-ip. Do not trust the
// caller-controlled x-forwarded-for fallback.
export function clientIp(req: Request): string {
	return req.headers.get('cf-connecting-ip') || 'unknown';
}

export function parsePositiveInt(input: string | undefined, fallbackValue: number): number {
	const value = Number(input || '');
	if (!Number.isFinite(value) || value <= 0) return fallbackValue;
	return Math.floor(value);
}

export function clamp(value: number, minValue: number, maxValue: number): number {
	return Math.max(minValue, Math.min(maxValue, value));
}

export async function getJsonFromKv(namespace: KVNamespace, key: string): Promise<Record<string, unknown> | null> {
	const raw = await namespace.get(key);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function getSlug(pathname: string, prefix: string): string | null {
	if (!pathname.startsWith(prefix)) return null;
	const raw = pathname.slice(prefix.length);
	if (!raw) return null;
	// Workers hand the pathname over still percent-encoded, so an accented slug
	// arrives escaped. Decode before the allowlist, and fail closed on a
	// malformed escape rather than passing the raw bytes through.
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	return sanitizeWfmSlug(decoded);
}

export function parseJsonBody(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** UTC day id (YYYY-MM-DD) of an instant. */
export function utcDate(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}
