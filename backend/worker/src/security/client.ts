import { BACKEND_CLIENT_HEADER } from '../../../../config/shared/backendConfig';
import { getWorkerConfig } from '../config';
import { jsonResponse } from './cors';
import type { Env } from '../types';

const MAX_HEADER_LENGTH = 96;
const PRODUCT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,23}$/;

export interface ClientIdentity {
	product: string;
	version: string;
}

/** Reads `<product>/<version>`. Anything longer or otherwise malformed counts as no
 *  identity at all, so junk cannot enter the logs or the allow list comparison. */
export function parseClientHeader(req: Request): ClientIdentity | null {
	const raw = req.headers.get(BACKEND_CLIENT_HEADER);
	if (!raw) return null;

	const value = raw.trim();
	if (!value || value.length > MAX_HEADER_LENGTH) return null;

	const separator = value.indexOf('/');
	if (separator < 0) return null;

	const product = value.slice(0, separator).trim();
	const version = value.slice(separator + 1).trim();
	if (!PRODUCT_PATTERN.test(product) || !VERSION_PATTERN.test(version)) return null;

	return { product, version };
}

/** The gate covers public data routes and non-browser callers only. `/healthz` stays
 *  reachable for liveness checks, admin routes carry their own key, and handleFetch has
 *  already refused any browser origin outside the CORS allow list. */
function clientGateApplies(req: Request, url: URL): boolean {
	if (req.method === 'OPTIONS') return false;
	if (url.pathname === '/healthz') return false;
	if (url.pathname.startsWith('/admin/')) return false;
	if (req.headers.get('origin')) return false;
	return true;
}

/** 403 when the policy refuses this client, null when the request may continue.
 *  The deny list applies under either policy; the allow list only under "enforce". */
export function clientPolicyRejection(req: Request, url: URL, env: Env, client: ClientIdentity | null): Response | null {
	if (!clientGateApplies(req, url)) return null;

	const config = getWorkerConfig(env);
	const product = client ? client.product.toLowerCase() : '';

	if (product && config.clientDeny.includes(product)) {
		return jsonResponse({ ok: false, error: 'forbidden_client' }, req, env, 403);
	}
	if (config.clientPolicy !== 'enforce') return null;
	if (!product || !config.clientAllow.includes(product)) {
		return jsonResponse({ ok: false, error: 'forbidden_client' }, req, env, 403);
	}
	return null;
}
