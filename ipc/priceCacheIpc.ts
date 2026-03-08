import { createDiskCacheIpc } from "./diskCacheIpcFactory";


const { register } = createDiskCacheIpc({
  scope: "priceCacheIpc",
  filename: "price-cache.json",
  channelPrefix: "price-cache",
  noun: "price cache",
});

export { register };
