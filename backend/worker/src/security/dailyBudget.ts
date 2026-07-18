import { getWorkerConfig } from '../config';
import type { Env } from '../types';
import { jsonResponse } from './cors';

interface BudgetCounterRequest {
	increment: number;
	maxRequests: number;
	expiresAt: number;
}

interface BudgetCounterResult {
	count: number;
	exceeded: boolean;
}

function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(nowMs = Date.now()): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function shouldSample(sampleRate: number): boolean {
	if (sampleRate <= 1) return true;
	const bytes = new Uint32Array(1);
	crypto.getRandomValues(bytes);
	return bytes[0] % sampleRate === 0;
}

function budgetStub(env: Env, now: number): DurableObjectStub {
	return env.DAILY_BUDGET.getByName(utcDay(new Date(now)));
}

async function readBudget(
	env: Env,
	now: number,
	increment: number,
	maxRequests: number,
): Promise<BudgetCounterResult> {
	const response = await budgetStub(env, now).fetch('https://daily-budget.internal/check', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ increment, maxRequests, expiresAt: nextUtcMidnight(now) } satisfies BudgetCounterRequest),
	});
	if (!response.ok) throw new Error('daily budget counter unavailable');
	return response.json<BudgetCounterResult>();
}

export class DailyBudgetCounter {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST') return new Response(null, { status: 405 });

		let body: BudgetCounterRequest;
		try {
			body = await request.json<BudgetCounterRequest>();
		} catch {
			return Response.json({ error: 'invalid_request' }, { status: 400 });
		}

		const increment = Number.isInteger(body.increment) && body.increment >= 0 ? body.increment : -1;
		const maxRequests = Number.isInteger(body.maxRequests) && body.maxRequests > 0 ? body.maxRequests : -1;
		const expiresAt = Number.isFinite(body.expiresAt) ? body.expiresAt : 0;
		if (increment < 0 || maxRequests < 1 || expiresAt <= Date.now()) {
			return Response.json({ error: 'invalid_request' }, { status: 400 });
		}


		const count = await this.state.storage.transaction(async (transaction) => {
			const storedExpiresAt = (await transaction.get<number>('expiresAt')) ?? 0;
			let nextCount = storedExpiresAt > Date.now() ? ((await transaction.get<number>('count')) ?? 0) : 0;
			if (increment > 0 && nextCount < maxRequests) {
				nextCount += increment;
				await transaction.put({ count: nextCount, expiresAt });
			}
			return nextCount;
		});
		if (increment > 0) await this.state.storage.setAlarm(expiresAt);

		return Response.json({ count, exceeded: count >= maxRequests } satisfies BudgetCounterResult);
	}

	async alarm(): Promise<void> {
		await this.state.storage.deleteAll();
	}
}

export async function isDailyBudgetExceeded(env: Env, now = Date.now()): Promise<boolean> {
	const config = getWorkerConfig(env);
	if (!config.dailyBudgetEnabled) return false;
	return (await readBudget(env, now, 0, config.dailyBudgetMaxRequests)).exceeded;
}

function budgetExceededResponse(req: Request, env: Env, blockUntil: number): Response {
	return jsonResponse({ ok: false, error: 'daily_budget_exceeded' }, req, env, 503, {
		'retry-after': String(Math.max(1, Math.ceil((blockUntil - Date.now()) / 1000))),
	});
}

export async function checkDailyBudget(req: Request, env: Env): Promise<Response | null> {
	const config = getWorkerConfig(env);
	if (!config.dailyBudgetEnabled) return null;

	const now = Date.now();
	const increment = shouldSample(config.dailyBudgetSampleRate) ? config.dailyBudgetSampleRate : 0;
	if (increment === 0) return null;

	const result = await readBudget(env, now, increment, config.dailyBudgetMaxRequests);
	return result.exceeded ? budgetExceededResponse(req, env, nextUtcMidnight(now)) : null;
}
