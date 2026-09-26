/** Which relic data the relic database was built from, for Settings > About. */
export interface RelicDataInfo {
  version: string | null;
  source: "bundled" | "downloaded";
  publishedAt: string | null;
}
