import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		// Smoke tests hit the live deployed worker. Keep them out of the default
		// test run so a WFM blip or deploy lag can't flake developer PRs. Run
		// explicitly with `npm run test:smoke`.
		exclude: ['node_modules/**', 'test/smoke.spec.ts'],
	},
});
