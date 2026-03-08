import { createDiskCacheIpc } from "./diskCacheIpcFactory";


const { register } = createDiskCacheIpc({
  scope: "orderCacheIpc",
  filename: "order-cache.json",
  channelPrefix: "order-cache",
  noun: "order cache",
});

export { register };
