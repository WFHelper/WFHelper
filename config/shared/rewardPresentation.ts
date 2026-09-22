import { asRecord } from "./objectValidation";
import { isWfmSlug } from "./wfm";

interface RewardPresentationPart {
  name: string;
  imageUrl: string | null;
  ownedCount: number;
  requiredCount: number;
  isReward: boolean;
  building: boolean;
}

interface RewardPresentationItem {
  name: string;
  rarity: string;
  ducats: number;
  partOwnedCount: number;
  partRequiredCount: number;
  mastered?: boolean;
  vaulted?: boolean;
  building: boolean;
  setOwnedCount: number;
  setRequiredCount: number;
  setUrlName: string | null;
  setParts: RewardPresentationPart[];
}

export interface RewardPresentation {
  count: 1 | 2 | 3 | 4;
  slots: ({ item: RewardPresentationItem; price: number | null; setPrice: number | null } | null)[];
}

function boundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    [...value].every((char) => char.charCodeAt(0) >= 32)
  );
}

function normalizePart(raw: unknown): RewardPresentationPart | null {
  const part = asRecord(raw);
  if (
    !part ||
    !boundedText(part.name, 200) ||
    !boundedNumber(part.ownedCount) ||
    !boundedNumber(part.requiredCount) ||
    typeof part.isReward !== "boolean" ||
    typeof part.building !== "boolean"
  )
    return null;
  let imageUrl: string | null = null;
  if (part.imageUrl != null) {
    if (!boundedText(part.imageUrl, 1024)) return null;
    try {
      const url = new URL(part.imageUrl);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      imageUrl = part.imageUrl;
    } catch {
      return null;
    }
  }
  return {
    name: part.name,
    imageUrl,
    ownedCount: part.ownedCount,
    requiredCount: part.requiredCount,
    isReward: part.isReward,
    building: part.building,
  };
}

/** Copy only rendered reward fields across IPC; unrelated scan/account data never enters previews. */
export function normalizeRewardPresentation(raw: unknown): RewardPresentation | null {
  const input = asRecord(raw);
  if (
    !input ||
    !Number.isInteger(input.count) ||
    typeof input.count !== "number" ||
    input.count < 1 ||
    input.count > 4 ||
    !Array.isArray(input.slots) ||
    input.slots.length !== 4
  )
    return null;
  const slots: RewardPresentation["slots"] = [];
  for (const rawSlot of input.slots) {
    if (rawSlot === null) {
      slots.push(null);
      continue;
    }
    const slot = asRecord(rawSlot);
    const item = asRecord(slot?.item);
    if (
      !slot ||
      !item ||
      !boundedText(item.name, 200) ||
      !item.name.trim() ||
      !boundedText(item.rarity, 32) ||
      !boundedNumber(item.ducats) ||
      !boundedNumber(item.partOwnedCount) ||
      !boundedNumber(item.partRequiredCount) ||
      !boundedNumber(item.setOwnedCount) ||
      !boundedNumber(item.setRequiredCount) ||
      (item.mastered !== undefined && typeof item.mastered !== "boolean") ||
      (item.vaulted !== undefined && typeof item.vaulted !== "boolean") ||
      typeof item.building !== "boolean" ||
      (item.setUrlName !== null &&
        (!boundedText(item.setUrlName, 128) || !isWfmSlug(item.setUrlName))) ||
      (slot.price !== null && !boundedNumber(slot.price)) ||
      (slot.setPrice !== null && !boundedNumber(slot.setPrice)) ||
      !Array.isArray(item.setParts) ||
      item.setParts.length > 6
    )
      return null;
    const parts: RewardPresentationPart[] = [];
    for (const rawPart of item.setParts) {
      const part = normalizePart(rawPart);
      if (!part) return null;
      parts.push(part);
    }
    slots.push({
      item: {
        name: item.name,
        rarity: item.rarity,
        ducats: item.ducats,
        partOwnedCount: item.partOwnedCount,
        partRequiredCount: item.partRequiredCount,
        ...(item.mastered === undefined ? {} : { mastered: item.mastered }),
        ...(item.vaulted === undefined ? {} : { vaulted: item.vaulted }),
        building: item.building,
        setOwnedCount: item.setOwnedCount,
        setRequiredCount: item.setRequiredCount,
        setUrlName: item.setUrlName,
        setParts: parts,
      },
      price: slot.price,
      setPrice: slot.setPrice,
    });
  }
  if (slots.filter(Boolean).length !== input.count) return null;
  return { count: input.count as RewardPresentation["count"], slots };
}
