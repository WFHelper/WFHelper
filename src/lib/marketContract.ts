import type { WfmContractAttribute } from "../types/market.js";

export function attributeKeyword(attribute: WfmContractAttribute): string {
  if (typeof attribute.label === "string" && attribute.label.trim()) return attribute.label;
  if (typeof attribute.urlName === "string" && attribute.urlName.trim()) {
    return attribute.urlName.replace(/_/g, " ");
  }
  return "";
}
