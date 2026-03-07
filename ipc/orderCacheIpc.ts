import { createDiskCacheIpc } from "./diskCacheIpcFactory";

export {};

const { register } = createDiskCacheIpc({
  scope: "orderCacheIpc",
  filename: "order-cache.json",
  channelPrefix: "order-cache",
  noun: "order cache",
});

export { register };

module.exports = { register };
