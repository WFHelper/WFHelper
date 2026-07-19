import { loadItemPrice } from "./priceLoader.js";

interface PriceState {
  text: string;
  slug: string | null;
}

export function createPriceLoader(assign: (state: PriceState) => void): {
  clear: () => void;
  load: (
    name: string,
    lookup: Record<string, { url_name: string }>,
    isTradable: boolean,
    options?: { fallbackName?: string; fallbackTradable?: boolean },
  ) => Promise<void>;
} {
  let token = 0;

  return {
    clear(): void {
      token++;
      assign({ text: "", slug: null });
    },
    async load(
      name: string,
      lookup: Record<string, { url_name: string }>,
      isTradable: boolean,
      options: { fallbackName?: string; fallbackTradable?: boolean } = {},
    ): Promise<void> {
      const currentToken = ++token;
      assign({ text: "Loading price...", slug: null });

      let result = await loadItemPrice(name, lookup, isTradable);
      if (!result.slug && options.fallbackName) {
        result = await loadItemPrice(
          options.fallbackName,
          lookup,
          options.fallbackTradable ?? isTradable,
        );
      }
      if (currentToken !== token) return;
      assign({ text: result.text, slug: result.slug });
    },
  };
}
