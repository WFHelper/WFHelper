import { createDiskCacheIpc } from "./diskCacheIpcFactory";

const { register } = createDiskCacheIpc({
  scope: "rankedHotsetIpc",
  filename: "ranked-hotset.json",
  channelPrefix: "ranked-hotset",
  noun: "ranked hotset",
});

export { register };
