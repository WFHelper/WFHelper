// Warframe Market prices relics per refinement through an order `subtype`
// field. Relics carry no rank, so the subtype path is a separate cache family.
import { parseWfmOrderSubtype, type WfmOrderSubtype } from '../../../../config/shared/wfmOrders';

export type OrderSubtype = WfmOrderSubtype;

export const normalizeOrderSubtype = parseWfmOrderSubtype;

export function isRelicSlug(slug: string): boolean {
	return slug.endsWith('_relic');
}

// Mirrors the ranked `orders-summary:{slug}:r{rank}` convention so subtype
// entries can never collide with ranked ones.
export function workerOrderSummarySubtypeCacheKey(slug: string, subtype: OrderSubtype): string {
	return `orders-summary:${slug}:s${subtype}`;
}

export function workerMissOrderSummarySubtypeKey(prefix: string, slug: string, subtype: OrderSubtype): string {
	return `${prefix}${slug}:s${subtype}`;
}
