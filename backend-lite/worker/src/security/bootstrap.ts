import type { Env } from '../types';
import { clamp, parsePositiveInt } from '../utils';

const BOOTSTRAP_HEADER = 'x-wfhelper-bootstrap';

function textEncoder(): TextEncoder {
	return new TextEncoder();
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array | null {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	try {
		const binary = atob(`${normalized}${padding}`);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

async function sha256Text(input: string): Promise<string> {
	const bytes = textEncoder().encode(input);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return toBase64Url(new Uint8Array(digest));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', textEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signPayload(payloadBase64: string, secret: string): Promise<string> {
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, textEncoder().encode(payloadBase64));
	return toBase64Url(new Uint8Array(signature));
}

function clientIp(req: Request): string {
	const cfIp = req.headers.get('cf-connecting-ip');
	if (cfIp) return cfIp;

	const xff = req.headers.get('x-forwarded-for');
	if (!xff) return 'unknown';
	return xff.split(',')[0].trim() || 'unknown';
}

function userAgent(req: Request): string {
	return (req.headers.get('user-agent') || '').trim().slice(0, 240);
}

function bootstrapSecret(env: Env): string {
	return (env.BOOTSTRAP_TOKEN_SECRET || '').trim();
}

export function bootstrapHeaderName(): string {
	return BOOTSTRAP_HEADER;
}

export function bootstrapRequired(env: Env): boolean {
	return (env.PUBLIC_BOOTSTRAP_REQUIRED || '').trim() === '1';
}

export function bootstrapEnabled(env: Env): boolean {
	return bootstrapSecret(env).length > 0;
}

function bootstrapTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.BOOTSTRAP_TOKEN_TTL_SEC, 900), 60, 3600);
}

export async function issueBootstrapToken(req: Request, env: Env): Promise<{ token: string; expiresAt: number } | null> {
	const secret = bootstrapSecret(env);
	if (!secret) return null;

	const now = Date.now();
	const expiresAt = now + bootstrapTtlSec(env) * 1000;
	const payload = {
		v: 1,
		ip: clientIp(req),
		ua: await sha256Text(userAgent(req)),
		iat: now,
		exp: expiresAt,
	};

	const payloadBase64 = toBase64Url(textEncoder().encode(JSON.stringify(payload)));
	const signature = await signPayload(payloadBase64, secret);
	return {
		token: `${payloadBase64}.${signature}`,
		expiresAt,
	};
}

export async function verifyBootstrapToken(req: Request, env: Env): Promise<boolean> {
	const secret = bootstrapSecret(env);
	if (!secret) return false;

	const token = (req.headers.get(BOOTSTRAP_HEADER) || '').trim();
	if (!token) return false;

	const [payloadBase64, signature] = token.split('.');
	if (!payloadBase64 || !signature) return false;

	const expectedSignature = await signPayload(payloadBase64, secret);
	if (signature !== expectedSignature) return false;

	const payloadBytes = fromBase64Url(payloadBase64);
	if (!payloadBytes) return false;

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
	} catch {
		return false;
	}

	if (payload.v !== 1) return false;
	if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return false;
	if (payload.ip !== clientIp(req)) return false;
	if (payload.ua !== (await sha256Text(userAgent(req)))) return false;

	return true;
}
