import { createDiskCacheIpc } from "./diskCacheIpcFactory";

const { register } = createDiskCacheIpc({
  scope: "snapshotCacheIpc",
  filename: "snapshot-cache.json",
  channelPrefix: "snapshot-cache",
  noun: "snapshot cache",
});

export { register };
