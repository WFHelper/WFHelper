import { describe, expect, it } from 'vitest';
import wfmStatsShared from '../../../config/shared/wfmStats.cjs';
import { __test__ as prewarmTest } from '../src/services/prewarm';

type SharedWfmStatsModule = {
	extractMedianFromStatsPayload: (jsonPayload: unknown) => number | null;
};

const { extractMedianFromStatsPayload } = wfmStatsShared as SharedWfmStatsModule;

const canonicalStatsPayload = {
	payload: {
		statistics_closed: {
			'48hours': [
				{ datetime: '2026-02-01T10:00:00Z', order_type: 'sell', median: 30 },
				{ datetime: '2026-02-01T11:00:00Z', order_type: 'buy', median: 999 },
			],
		},
		statistics_live: {
			'48_hours': [{ datetime: '2026-02-01T12:00:00Z', order_type: 'sell', moving_avg: 33 }],
		},
	},
};

describe('prewarm stats parser parity', () => {
	it('matches the canonical stats median parser', () => {
		expect(prewarmTest.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(33);
		expect(extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(33);
	});
});
