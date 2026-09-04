import { withScope } from "./logger";
import { createArbiParser } from "./arbiRunParser";
import type { ArbiParsedRun } from "./arbiRunParser";
import { addImportedRunFromFile } from "./arbiRunTracker";
import { importEeLogSegments } from "./eeLogSegmentImporter";
import type { SegmentImportOptions } from "./eeLogSegmentImporter";
import type { ArbiImportResult, ArbiRunEndReason, ArbiRunRecord } from "../config/shared/arbiTypes";

const log = withScope("arbiLogImporter");

export async function importEeLog(
  filePath: string,
  options: SegmentImportOptions = {},
): Promise<ArbiImportResult> {
  return importEeLogSegments<ArbiParsedRun, ArbiRunEndReason, ArbiRunRecord>(
    filePath,
    {
      log,
      label: "[Arbi]",
      tempPrefix: "wfhelper-arbi-import-",
      defaultReason: "imported",
      createParser: createArbiParser,
      runStartSec: (parsed) => parsed.runStartSec,
      addRun: addImportedRunFromFile,
    },
    options,
  );
}
