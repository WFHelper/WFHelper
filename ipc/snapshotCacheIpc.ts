import { createDiskCacheIpc } from "./diskCacheIpcFactory";
import { isValidSnapshotBlob } from "../config/shared/wfmSnapshotValidation";

const { register } = createDiskCacheIpc({
  scope: "snapshotCacheIpc",
  filename: "snapshot-cache.json",
  channelPrefix: "snapshot-cache",
  noun: "snapshot cache",
  validateData: isValidSnapshotBlob,
});

export { register };
