import type { Env } from '../types';

/**
 * Constant-time string comparison to prevent timing-based side-channel attacks.
 * Returns true only when both strings are identical AND the same length.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export function isAdminAuthorized(req: Request, env: Env): boolean {
	if (!env.ADMIN_API_KEY) return false;
	const provided = req.headers.get('authorization') || '';
	const expected = `Bearer ${env.ADMIN_API_KEY}`;
	return timingSafeEqual(provided, expected);
}
