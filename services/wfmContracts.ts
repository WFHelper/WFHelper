import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

import { request, requestV2 } from "./wfmClient";
import { getInGameName } from "./wfmSession";
import { toNonEmptyWfmString } from "./wfmTypes";
import { toFiniteNumber } from "../config/shared/numeric";
import { formatWfmAssetUrl, titleFromSlug } from "../config/shared/wfm";

const log = withScope("wfmContracts");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 40;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

const SKIPPABLE_HTTP_STATUSES = new Set([301, 302, 303, 400, 404, 405]);

let _resolvedEndpointName: string | null = null;


interface NormalisedAttribute {
  urlName: string;
  label: string;
  value: number | string | null;
  positive: boolean | null;
}

interface NormalisedContract {
  id: string;
  itemName: string;
  itemId: string | null;
  itemUrlName: string | null;
  weaponUrlName: string | null;
  itemThumb: string | null;
  platinum: number;
  buyoutPlatinum: number | null;
  startingPlatinum: number | null;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  rerolls: number | null;
  masteryLevel: number | null;
  polarity: string | null;
  isDirectSell: boolean;
  listedAt: string | null;
  updatedAt: string | null;
  note: string | null;
  stats: NormalisedAttribute[];
  listingUrl: string;
  sourceType: string | null;
}

interface PageInfo {
  page: number;
  totalPages: number | null;
  hasMore: boolean;
}

interface ExtractedContracts extends PageInfo {
  rows: Record<string, unknown>[];
}

interface EndpointCandidate {
  name: string;
  api: "v1" | "v2";
  path: string;
}


function normalizeAssetUrl(value: unknown): string | null {
  const p = toNonEmptyWfmString(value);
  return formatWfmAssetUrl(p);
}

function normalizeAttribute(rawAttribute: unknown): NormalisedAttribute | null {
  if (!rawAttribute || typeof rawAttribute !== "object") return null;
  const attr = rawAttribute as Record<string, unknown>;

  const urlName =
    toNonEmptyWfmString(attr.url_name) ||
    toNonEmptyWfmString(attr.urlName) ||
    toNonEmptyWfmString(attr.name) ||
    "unknown";

  const label =
    toNonEmptyWfmString(attr.display_name) ||
    toNonEmptyWfmString(attr.displayName) ||
    titleFromSlug(urlName);

  const numericValue = toFiniteNumber(attr.value);
  const value: number | string | null =
    numericValue != null ? numericValue : toNonEmptyWfmString(attr.value);

  const positive: boolean | null =
    typeof attr.positive === "boolean"
      ? attr.positive
      : typeof attr.is_positive === "boolean"
        ? attr.is_positive
        : null;

  return {
    urlName,
    label,
    value,
    positive,
  };
}

function toIsoTimestamp(value: unknown): string | null {
  const s = toNonEmptyWfmString(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeContract(raw: unknown): NormalisedContract | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const item = (r.item && typeof r.item === "object" ? r.item : {}) as Record<string, unknown>;
  const i18nEn = ((item.i18n as Record<string, unknown> | undefined)?.en ?? {}) as Record<
    string,
    unknown
  >;
    const itemSlug = toNonEmptyWfmString(item.url_name) || toNonEmptyWfmString(r.item_url_name);
  const weaponSlug =
    toNonEmptyWfmString(item.weapon_url_name) ||
    toNonEmptyWfmString(item.weaponUrlName) ||
    toNonEmptyWfmString(r.weapon_url_name) ||
    toNonEmptyWfmString(r.weaponUrlName);

  const itemName =
    toNonEmptyWfmString(i18nEn.item_name) ||
    toNonEmptyWfmString(i18nEn.itemName) ||
    toNonEmptyWfmString(item.item_name) ||
    toNonEmptyWfmString(item.itemName) ||
    toNonEmptyWfmString(item.weapon_name) ||
    toNonEmptyWfmString(item.weaponName) ||
    toNonEmptyWfmString(r.item_name) ||
    toNonEmptyWfmString(r.itemName) ||
    (weaponSlug ? `${titleFromSlug(weaponSlug)} Riven` : "Riven Contract");

  const itemThumb = normalizeAssetUrl(
    item.thumb || item.icon || item.image || r.thumb || r.icon || null,
  );

  const buyoutPlatinum = toFiniteNumber(r.buyout_price ?? r.buyoutPrice);
  const startingPlatinum = toFiniteNumber(r.starting_price ?? r.startingPrice);
  const listedPrice =
    toFiniteNumber(r.platinum) ??
    toFiniteNumber(r.price) ??
    buyoutPlatinum ??
    startingPlatinum ??
    0;

  const attributesRaw = Array.isArray(item.attributes)
    ? item.attributes
    : Array.isArray(r.attributes)
      ? r.attributes
      : [];

  const id =
    toNonEmptyWfmString(r.id) ||
    toNonEmptyWfmString(r._id) ||
    toNonEmptyWfmString(r.contract_id) ||
    toNonEmptyWfmString(r.contractId);

  if (!id) return null;

  const directSell =
    r.is_direct_sell === true ||
    r.isDirectSell === true ||
    (buyoutPlatinum != null &&
      buyoutPlatinum > 0 &&
      (startingPlatinum == null || startingPlatinum <= 0));

  return {
    id,
    itemName: itemName || "Riven Contract",
    itemId: toNonEmptyWfmString(item.id) || toNonEmptyWfmString(r.itemId) || null,
    itemUrlName: itemSlug || weaponSlug || null,
    weaponUrlName: weaponSlug || null,
    itemThumb,
    platinum: Math.max(0, Math.round(Math.abs(listedPrice))),
    buyoutPlatinum:
      buyoutPlatinum != null ? Math.max(0, Math.round(Math.abs(buyoutPlatinum))) : null,
    startingPlatinum:
      startingPlatinum != null ? Math.max(0, Math.round(Math.abs(startingPlatinum))) : null,
    quantity: Math.max(1, Math.round(Math.abs(toFiniteNumber(r.quantity) ?? 1))),
    visible: r.visible !== false,
    modRank: toFiniteNumber(item.mod_rank ?? item.rank ?? r.mod_rank ?? r.rank),
    rerolls: toFiniteNumber(item.re_rolls ?? item.reRolls ?? r.re_rolls ?? r.reRolls),
    masteryLevel: toFiniteNumber(
      item.mastery_level ?? item.masteryLevel ?? r.mastery_level ?? r.masteryLevel,
    ),
    polarity:
      toNonEmptyWfmString(item.polarity) ||
      toNonEmptyWfmString(r.polarity) ||
      toNonEmptyWfmString(item.mod_polarity) ||
      null,
    isDirectSell: directSell,
    listedAt: toIsoTimestamp(r.created_at ?? r.createdAt),
    updatedAt: toIsoTimestamp(r.updated_at ?? r.updatedAt),
    note: toNonEmptyWfmString(r.note) || null,
    stats: (attributesRaw.map(normalizeAttribute).filter(Boolean) as NormalisedAttribute[]),
    listingUrl: `https://warframe.market/auction/${encodeURIComponent(id)}`,
    sourceType:
      toNonEmptyWfmString(r.type) ||
      toNonEmptyWfmString(r.contract_type) ||
      toNonEmptyWfmString(r.contractType) ||
      null,
  };
}

function parsePageInfo(container: unknown): PageInfo {
  if (!container || typeof container !== "object") {
    return { page: DEFAULT_PAGE, totalPages: null, hasMore: false };
  }
  const c = container as Record<string, unknown>;

  const page =
    toFiniteNumber(c.page) ||
    toFiniteNumber(c.current_page) ||
    toFiniteNumber(c.currentPage) ||
    DEFAULT_PAGE;

  const totalPages =
    toFiniteNumber(c.total_pages) ||
    toFiniteNumber(c.totalPages) ||
    toFiniteNumber(c.last_page) ||
    toFiniteNumber(c.lastPage) ||
    null;

  const hasMore =
    typeof c.has_more === "boolean"
      ? c.has_more
      : typeof c.hasMore === "boolean"
        ? c.hasMore
        : totalPages != null
          ? (page ?? DEFAULT_PAGE) < (totalPages ?? 0)
          : false;

  return { page: page ?? DEFAULT_PAGE, totalPages, hasMore };
}

function extractContracts(data: unknown): ExtractedContracts {
  const d = data as Record<string, unknown> | null;
  const root = (d?.data ?? d?.payload ?? d) as Record<string, unknown> | null;
  const candidates = [root, root?.data, root?.payload].filter(Boolean);

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { rows: candidate as Record<string, unknown>[], ...parsePageInfo(root) };
    }

    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;

    if (Array.isArray(c.contracts)) {
      return { rows: c.contracts as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.auctions)) {
      return { rows: c.auctions as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.items)) {
      return { rows: c.items as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.results)) {
      return { rows: c.results as Record<string, unknown>[], ...parsePageInfo(c) };
    }
  }

  return {
    rows: [],
    page: DEFAULT_PAGE,
    totalPages: null,
    hasMore: false,
  };
}

function buildQuery(page: number, limit: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function endpointCandidates(
  userName: string | null,
  page: number,
  limit: number,
): EndpointCandidate[] {
  const query = buildQuery(page, limit);
  const encodedUser = encodeURIComponent((userName || "").toLowerCase());

  const candidates: EndpointCandidate[] = [];

  candidates.push({
    name: "v1_my_profile_auctions",
    api: "v1",
    path: `/profile/auctions${query}`,
  });

  if (encodedUser) {
    candidates.push({
      name: "v1_profile_auctions",
      api: "v1",
      path: `/profile/${encodedUser}/auctions${query}`,
    });
  }

  candidates.push(
    {
      name: "v2_contracts_my",
      api: "v2",
      path: `/contracts/my${query}`,
    },
    {
      name: "v2_auctions_my",
      api: "v2",
      path: `/auctions/my${query}`,
    },
  );

  if (encodedUser) {
    candidates.push(
      {
        name: "v2_profile_contracts",
        api: "v2",
        path: `/profile/${encodedUser}/contracts${query}`,
      },
      {
        name: "v2_profile_auctions",
        api: "v2",
        path: `/profile/${encodedUser}/auctions${query}`,
      },
      {
        name: "v1_profile_contracts",
        api: "v1",
        path: `/profile/${encodedUser}/contracts${query}`,
      },
    );
  }

  return candidates;
}

async function invokeCandidate(candidate: EndpointCandidate): Promise<unknown> {
  if (candidate.api === "v2") {
    return requestV2("GET", candidate.path);
  }
  return request("GET", candidate.path);
}

function isSkippableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = Number((err as Record<string, unknown>).status);
  return SKIPPABLE_HTTP_STATUSES.has(status);
}


export async function getMyContracts({
  page = DEFAULT_PAGE,
  limit = DEFAULT_LIMIT,
}: { page?: number; limit?: number } = {}): Promise<{
  contracts: NormalisedContract[];
  page: number;
  totalPages: number | null;
  hasMore: boolean;
}> {
  if (!getInGameName()) {
    throw new Error("Not logged in to Warframe.market.");
  }

  const safePage = Math.max(1, Math.round(toFiniteNumber(page) || DEFAULT_PAGE));
  const safeLimit = Math.max(
    MIN_LIMIT,
    Math.min(MAX_LIMIT, Math.round(toFiniteNumber(limit) || DEFAULT_LIMIT)),
  );

  const candidates = endpointCandidates(getInGameName(), safePage, safeLimit);
  if (_resolvedEndpointName) {
    candidates.sort((a, b) => {
      if (a.name === _resolvedEndpointName) return -1;
      if (b.name === _resolvedEndpointName) return 1;
      return 0;
    });
  }

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const data = await invokeCandidate(candidate);
      const extracted = extractContracts(data);
      const contracts = extracted.rows.map(normalizeContract).filter((row): row is NormalisedContract => Boolean(row));

      _resolvedEndpointName = candidate.name;
      return {
        contracts,
        page: extracted.page,
        totalPages: extracted.totalPages,
        hasMore: extracted.hasMore,
      };
    } catch (err: unknown) {
      if (err && typeof err === "object" && (err as Record<string, unknown>).code === "WFM_UNAUTHORIZED") {
        throw err;
      }

      if (isSkippableError(err)) {
        log.log(
          `[WFMContracts] ${candidate.api.toUpperCase()} ${candidate.path} unavailable (${(err as Record<string, unknown>).status})`,
        );
        if (_resolvedEndpointName === candidate.name) {
          _resolvedEndpointName = null;
        }
        continue;
      }

      lastError = err;
      log.warn(
        `[WFMContracts] ${candidate.api.toUpperCase()} ${candidate.path} failed:`,
        normalizeErrorMessage(err),
      );
    }
  }

  if (lastError) throw lastError;

  throw new Error(
    "Unable to load riven contracts. Endpoint path may have changed; verify Warframe.market API route and shape.",
  );
}

export const __test__ = {
  normalizeAttribute,
  normalizeContract,
  parsePageInfo,
  extractContracts,
  buildQuery,
  endpointCandidates,
};
