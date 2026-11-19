import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
		// Smoke tests hit the live deployed worker. Keep them out of the default
		// test run so a WFM blip or deploy lag can't flake developer PRs. Run
		// explicitly with `npm run test:smoke`.
		exclude: ['node_modules/**', 'test/smoke.spec.ts'],
	},
});
