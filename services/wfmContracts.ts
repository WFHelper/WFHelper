"use strict";

import { withScope } from "./logger";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

import { request, requestV2 } from "./wfmClient";
import { getInGameName } from "./wfmSession";
const { toFiniteNumber } = require("../config/shared/numeric.cjs") as {
  toFiniteNumber: (v: any) => number | null;
};
const { WFM_ASSET_BASE: WFM_THUMB_BASE } = require("../config/shared/wfm.cjs") as {
  WFM_ASSET_BASE: string;
};

const log = withScope("wfmContracts");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 40;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

const SKIPPABLE_HTTP_STATUSES = new Set([400, 404, 405]);

let _resolvedEndpointName: string | null = null;

// ── Interfaces ────────────────────────────────────────────────────────────────

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
  rows: any[];
}

interface EndpointCandidate {
  name: string;
  api: "v1" | "v2";
  path: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNonEmptyString(value: any): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAssetUrl(value: any): string | null {
  const p = toNonEmptyString(value);
  if (!p) return null;
  return p.startsWith("http") ? p : `${WFM_THUMB_BASE}${p}`;
}

function titleFromSlug(slug: string): string {
  return String(slug)
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function normalizeAttribute(rawAttribute: any): NormalisedAttribute | null {
  if (!rawAttribute || typeof rawAttribute !== "object") return null;

  const urlName =
    toNonEmptyString(rawAttribute.url_name) ||
    toNonEmptyString(rawAttribute.urlName) ||
    toNonEmptyString(rawAttribute.name) ||
    "unknown";

  const label =
    toNonEmptyString(rawAttribute.display_name) ||
    toNonEmptyString(rawAttribute.displayName) ||
    titleFromSlug(urlName);

  const numericValue = toFiniteNumber(rawAttribute.value);
  const value: number | string | null =
    numericValue != null ? numericValue : toNonEmptyString(rawAttribute.value);

  const positive: boolean | null =
    typeof rawAttribute.positive === "boolean"
      ? rawAttribute.positive
      : typeof rawAttribute.is_positive === "boolean"
        ? rawAttribute.is_positive
        : null;

  return {
    urlName,
    label,
    value,
    positive,
  };
}

function toIsoTimestamp(value: any): string | null {
  const s = toNonEmptyString(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeContract(raw: any): NormalisedContract | null {
  if (!raw || typeof raw !== "object") return null;

  const item = raw.item && typeof raw.item === "object" ? raw.item : {};
  const itemSlug = toNonEmptyString(item.url_name) || toNonEmptyString(raw.item_url_name);
  const weaponSlug =
    toNonEmptyString(item.weapon_url_name) ||
    toNonEmptyString(item.weaponUrlName) ||
    toNonEmptyString(raw.weapon_url_name) ||
    toNonEmptyString(raw.weaponUrlName);

  const itemName =
    toNonEmptyString(item?.i18n?.en?.item_name) ||
    toNonEmptyString(item?.i18n?.en?.itemName) ||
    toNonEmptyString(item.item_name) ||
    toNonEmptyString(item.itemName) ||
    toNonEmptyString(item.weapon_name) ||
    toNonEmptyString(item.weaponName) ||
    toNonEmptyString(raw.item_name) ||
    toNonEmptyString(raw.itemName) ||
    (weaponSlug ? `${titleFromSlug(weaponSlug)} Riven` : "Riven Contract");

  const itemThumb = normalizeAssetUrl(
    item.thumb || item.icon || item.image || raw.thumb || raw.icon || null,
  );

  const buyoutPlatinum = toFiniteNumber(raw.buyout_price ?? raw.buyoutPrice);
  const startingPlatinum = toFiniteNumber(raw.starting_price ?? raw.startingPrice);
  const listedPrice =
    toFiniteNumber(raw.platinum) ??
    toFiniteNumber(raw.price) ??
    buyoutPlatinum ??
    startingPlatinum ??
    0;

  const attributesRaw = Array.isArray(item.attributes)
    ? item.attributes
    : Array.isArray(raw.attributes)
      ? raw.attributes
      : [];

  const id =
    toNonEmptyString(raw.id) ||
    toNonEmptyString(raw._id) ||
    toNonEmptyString(raw.contract_id) ||
    toNonEmptyString(raw.contractId);

  if (!id) return null;

  const directSell =
    raw.is_direct_sell === true ||
    raw.isDirectSell === true ||
    (buyoutPlatinum != null &&
      buyoutPlatinum > 0 &&
      (startingPlatinum == null || startingPlatinum <= 0));

  return {
    id,
    itemName: itemName || "Riven Contract",
    itemId: toNonEmptyString(item.id) || toNonEmptyString(raw.itemId) || null,
    itemUrlName: itemSlug || weaponSlug || null,
    weaponUrlName: weaponSlug || null,
    itemThumb,
    platinum: Math.max(0, Math.round(Math.abs(listedPrice))),
    buyoutPlatinum:
      buyoutPlatinum != null ? Math.max(0, Math.round(Math.abs(buyoutPlatinum))) : null,
    startingPlatinum:
      startingPlatinum != null ? Math.max(0, Math.round(Math.abs(startingPlatinum))) : null,
    quantity: Math.max(1, Math.round(Math.abs(toFiniteNumber(raw.quantity) ?? 1))),
    visible: raw.visible !== false,
    modRank: toFiniteNumber(item.mod_rank ?? item.rank ?? raw.mod_rank ?? raw.rank),
    rerolls: toFiniteNumber(item.re_rolls ?? item.reRolls ?? raw.re_rolls ?? raw.reRolls),
    masteryLevel: toFiniteNumber(
      item.mastery_level ?? item.masteryLevel ?? raw.mastery_level ?? raw.masteryLevel,
    ),
    polarity:
      toNonEmptyString(item.polarity) ||
      toNonEmptyString(raw.polarity) ||
      toNonEmptyString(item.mod_polarity) ||
      null,
    isDirectSell: directSell,
    listedAt: toIsoTimestamp(raw.created_at ?? raw.createdAt),
    updatedAt: toIsoTimestamp(raw.updated_at ?? raw.updatedAt),
    note: toNonEmptyString(raw.note) || null,
    stats: (attributesRaw.map(normalizeAttribute).filter(Boolean) as NormalisedAttribute[]),
    listingUrl: `https://warframe.market/auctions/${encodeURIComponent(id)}`,
    sourceType:
      toNonEmptyString(raw.type) ||
      toNonEmptyString(raw.contract_type) ||
      toNonEmptyString(raw.contractType) ||
      null,
  };
}

function parsePageInfo(container: any): PageInfo {
  if (!container || typeof container !== "object") {
    return { page: DEFAULT_PAGE, totalPages: null, hasMore: false };
  }

  const page =
    toFiniteNumber(container.page) ||
    toFiniteNumber(container.current_page) ||
    toFiniteNumber(container.currentPage) ||
    DEFAULT_PAGE;

  const totalPages =
    toFiniteNumber(container.total_pages) ||
    toFiniteNumber(container.totalPages) ||
    toFiniteNumber(container.last_page) ||
    toFiniteNumber(container.lastPage) ||
    null;

  const hasMore =
    typeof container.has_more === "boolean"
      ? container.has_more
      : typeof container.hasMore === "boolean"
        ? container.hasMore
        : totalPages != null
          ? (page ?? DEFAULT_PAGE) < (totalPages ?? 0)
          : false;

  return { page: page ?? DEFAULT_PAGE, totalPages, hasMore };
}

function extractContracts(data: any): ExtractedContracts {
  const root = data?.data ?? data?.payload ?? data;
  const candidates = [root, root?.data, root?.payload].filter(Boolean);

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { rows: candidate, ...parsePageInfo(root) };
    }

    if (!candidate || typeof candidate !== "object") continue;

    if (Array.isArray(candidate.contracts)) {
      return { rows: candidate.contracts, ...parsePageInfo(candidate) };
    }
    if (Array.isArray(candidate.auctions)) {
      return { rows: candidate.auctions, ...parsePageInfo(candidate) };
    }
    if (Array.isArray(candidate.items)) {
      return { rows: candidate.items, ...parsePageInfo(candidate) };
    }
    if (Array.isArray(candidate.results)) {
      return { rows: candidate.results, ...parsePageInfo(candidate) };
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
  const encodedUser = encodeURIComponent(userName || "");

  const candidates: EndpointCandidate[] = [
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
  ];

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
      {
        name: "v1_profile_auctions",
        api: "v1",
        path: `/profile/${encodedUser}/auctions${query}`,
      },
    );
  }

  return candidates;
}

async function invokeCandidate(candidate: EndpointCandidate): Promise<any> {
  if (candidate.api === "v2") {
    return requestV2("GET", candidate.path);
  }
  return request("GET", candidate.path);
}

function isSkippableError(err: any): boolean {
  if (!err || typeof err !== "object") return false;
  const status = Number(err.status);
  return SKIPPABLE_HTTP_STATUSES.has(status);
}

// ── Public API ────────────────────────────────────────────────────────────────

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

  let lastError: any = null;

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
    } catch (err: any) {
      if (err && typeof err === "object" && err.code === "WFM_UNAUTHORIZED") {
        throw err;
      }

      if (isSkippableError(err)) {
        log.log(
          `[WFMContracts] ${candidate.api.toUpperCase()} ${candidate.path} unavailable (${err.status})`,
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
