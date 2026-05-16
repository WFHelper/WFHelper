import { getWorkerConfig } from '../config';
import type { Env } from '../types';
import { jsonResponse } from './cors';

interface BudgetState {
	day: string;
	blockUntil: number;
	nextSyncAt: number;
}

const DAILY_BUDGET_PREFIX = 'budget:requests:v1:';

let budgetState: BudgetState | null = null;

function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(nowMs = Date.now()): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function secondsUntilNextUtcMidnight(nowMs = Date.now()): number {
	return Math.max(60, Math.ceil((nextUtcMidnight(nowMs) - nowMs) / 1000) + 60);
}

function budgetKey(day: string): string {
	return `${DAILY_BUDGET_PREFIX}${day}`;
}

function parseBudgetCount(value: string | null): number {
	const parsed = Number(value || '0');
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function shouldSample(sampleRate: number): boolean {
	if (sampleRate <= 1) return true;
	const bytes = new Uint32Array(1);
	crypto.getRandomValues(bytes);
	return bytes[0] % sampleRate === 0;
}

function currentState(day: string): BudgetState {
	if (!budgetState || budgetState.day !== day) {
		budgetState = {
			day,
			blockUntil: 0,
			nextSyncAt: 0,
		};
	}
	return budgetState;
}

export async function isDailyBudgetExceeded(env: Env, now = Date.now()): Promise<boolean> {
	const config = getWorkerConfig(env);
	if (!config.dailyBudgetEnabled) return false;

	const day = utcDay(new Date(now));
	const state = currentState(day);
	if (state.blockUntil > now) return true;

	const storedCount = parseBudgetCount(await env.PRICE_CACHE.get(budgetKey(day)));
	if (storedCount < config.dailyBudgetMaxRequests) return false;

	state.blockUntil = nextUtcMidnight(now);
	state.nextSyncAt = now + config.dailyBudgetSyncIntervalSec * 1000;
	return true;
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
	const day = utcDay(new Date(now));
	const state = currentState(day);
	if (state.blockUntil > now) {
		return budgetExceededResponse(req, env, state.blockUntil);
	}

	const sampled = shouldSample(config.dailyBudgetSampleRate);
	const shouldSync = now >= state.nextSyncAt;
	if (!sampled && !shouldSync) return null;

	const key = budgetKey(day);
	const storedCount = parseBudgetCount(await env.PRICE_CACHE.get(key));
	state.nextSyncAt = now + config.dailyBudgetSyncIntervalSec * 1000;

	if (storedCount >= config.dailyBudgetMaxRequests) {
		state.blockUntil = nextUtcMidnight(now);
		return budgetExceededResponse(req, env, state.blockUntil);
	}

	if (!sampled) return null;

	const nextCount = storedCount + config.dailyBudgetSampleRate;
	await env.PRICE_CACHE.put(key, String(nextCount), {
		expirationTtl: secondsUntilNextUtcMidnight(now),
	});

	if (nextCount >= config.dailyBudgetMaxRequests) {
		state.blockUntil = nextUtcMidnight(now);
		return budgetExceededResponse(req, env, state.blockUntil);
	}

	return null;
}