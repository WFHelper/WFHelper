import { defineConfig } from 'vitest/config';

// Smoke tests hit the real deployed Worker over HTTPS. They use the default
// Node pool - NOT @cloudflare/vitest-pool-workers - because Miniflare would
// intercept fetch() and defeat the purpose of a live health check.
//
// Run with:  WORKER_URL=https://... npm run test:smoke
//
// Do NOT run in PR CI. Schedule via GitHub Actions cron (e.g. every 6h) so a
// warframe.market blip or a 5-minute deploy lag can't red-ball developer PRs.
export default defineConfig({
	test: {
		include: ['test/smoke.spec.ts'],
		// Live network - slow and flaky by nature. Retry once for transient blips.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		retry: 1,
		// Default Node pool.
	},
});
