import { sanitizeWfmSlug } from "../config/shared/wfm";
import { withScope } from "./logger";
import { request, WfmApiError } from "./wfmClient";
import { probeProfileSlug } from "./wfmProfileSlug";

const log = withScope("wfmReviews");

export type SendRepResult = "sent" | "already-exists" | "user-not-found" | "failed";

const REVIEW_REDIRECT = /^https:\/\/api\.warframe\.market\/v1\/profile\/([^/?#]+)\/review\/?$/;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/** The review path WFM redirected a POST to, or null. The probe already covers
 *  the common case; this catches a failed or stale probe, when WFM answers the
 *  POST itself with a 301 to the lowercase slug and never re-sends the body. */
function redirectedReviewPath(err: unknown): string | null {
  if (!(err instanceof WfmApiError) || !err.status || !REDIRECT_STATUSES.has(err.status))
    return null;
  const captured = err.location ? REVIEW_REDIRECT.exec(err.location)?.[1] : null;
  if (!captured) return null;
  try {
    const slug = sanitizeWfmSlug(decodeURIComponent(captured));
    return slug ? `/profile/${encodeURIComponent(slug)}/review` : null;
  } catch {
    return null;
  }
}

export async function sendPlusRep(username: string): Promise<SendRepResult> {
  const name = String(username || "").trim();
  if (!name) return "failed";

  try {
    // No minted slug means the name is already one, or there is no such profile,
    // which the POST reports as a 404 of its own.
    const slug = (await probeProfileSlug(name)) ?? name;
    const path = `/profile/${encodeURIComponent(slug)}/review`;
    const body = { json: { review_type: 1, text: "" } };
    try {
      await request("POST", path, body);
    } catch (err) {
      const redirected = redirectedReviewPath(err);
      if (!redirected || redirected === path) throw err;
      log.info(`[Rep] WFM redirected ${path} to ${redirected}, re-sending`);
      await request("POST", redirected, body);
    }
    log.info(`[Rep] +1 rep sent to ${name}`);
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("app.review.already_exist")) {
      log.info(`[Rep] review already exists for ${name}`);
      return "already-exists";
    }
    if (err instanceof WfmApiError && err.status === 404) {
      log.info(`[Rep] no WFM profile named ${name}`);
      return "user-not-found";
    }
    log.warn(`[Rep] failed for ${name}:`, message);
    return "failed";
  }
}
