import { createDiskCacheIpc } from "./diskCacheIpcFactory";

export {};

const { register } = createDiskCacheIpc({
  scope: "priceCacheIpc",
  filename: "price-cache.json",
  channelPrefix: "price-cache",
  noun: "price cache",
});

export { register };

module.exports = { register };
