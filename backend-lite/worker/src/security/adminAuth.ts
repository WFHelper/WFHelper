import type { Env } from '../types';

export function isAdminAuthorized(req: Request, env: Env): boolean {
	const auth = req.headers.get('authorization') || '';
	return Boolean(env.ADMIN_API_KEY) && auth === `Bearer ${env.ADMIN_API_KEY}`;
}
