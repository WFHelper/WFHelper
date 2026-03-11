import { SLUG_RE } from './constants';

/**
 * Returns the real client IP address.
 *
 * With `workers_dev = false` every request goes through Cloudflare's edge,
 * which always injects `cf-connecting-ip`.  We intentionally do NOT fall back
 * to `x-forwarded-for`: that header can be forged by callers, and with a
 * custom domain it is never needed for legitimate traffic.
 */
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
	const slug = pathname.slice(prefix.length);
	if (!slug || !SLUG_RE.test(slug)) return null;
	return slug;
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
