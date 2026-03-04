import { SLUG_RE } from './constants';

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
