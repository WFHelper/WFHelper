import { withScope } from "./logger";
import { createProfitTakerParser } from "./profitTakerParser";
import type { PtParsedRun } from "./profitTakerParser";
import { addImportedPtRunFromFile } from "./profitTakerTracker";
import { importEeLogSegments } from "./eeLogSegmentImporter";
import type { SegmentImportOptions } from "./eeLogSegmentImporter";
import type {
  PtImportResult,
  PtRunEndReason,
  PtRunRecord,
} from "../config/shared/profitTakerTypes";

const log = withScope("profitTakerLogImporter");

export async function importProfitTakerLog(
  filePath: string,
  options: SegmentImportOptions = {},
): Promise<PtImportResult> {
  return importEeLogSegments<PtParsedRun, PtRunEndReason, PtRunRecord>(
    filePath,
    {
      log,
      label: "[PT]",
      tempPrefix: "wfhelper-pt-import-",
      defaultReason: "imported",
      createParser: createProfitTakerParser,
      runStartSec: (parsed) => parsed.runStartSec,
      addRun: addImportedPtRunFromFile,
    },
    options,
  );
}
