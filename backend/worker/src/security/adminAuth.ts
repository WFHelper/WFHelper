import type { Env } from '../types';
import { timingSafeEqual } from './constantTime';

export async function isAdminAuthorized(req: Request, env: Env): Promise<boolean> {
	if (!env.ADMIN_API_KEY) return false;
	const provided = req.headers.get('authorization') || '';
	const expected = `Bearer ${env.ADMIN_API_KEY}`;
	return await timingSafeEqual(provided, expected);
}
