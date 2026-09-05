import { registerRunTrackerIpc } from "./runTrackerIpc";
import * as ptTracker from "../services/profitTakerTracker";
import { importProfitTakerLog } from "../services/profitTakerLogImporter";
import type { PtImportResult, PtRunsPayload } from "../config/shared/profitTakerTypes";
import {
  PT_GET_RUNS,
  PT_REFRESH_RUNS,
  PT_SET_TAGS,
  PT_SET_NOTES,
  PT_DELETE_RUN,
  PT_DELETE_LOG,
  PT_EXPORT_LOG,
  PT_IMPORT_LOG,
  PT_SHOW_LOG_IN_FOLDER,
} from "../config/shared/ipcChannels";
import { withScope } from "../services/logger";

function register(): void {
  registerRunTrackerIpc<PtRunsPayload, PtImportResult>({
    log: withScope("profitTakerIpc"),
    label: "[PT]",
    channels: {
      getRuns: PT_GET_RUNS,
      refreshRuns: PT_REFRESH_RUNS,
      setTags: PT_SET_TAGS,
      setNotes: PT_SET_NOTES,
      deleteRun: PT_DELETE_RUN,
      deleteLog: PT_DELETE_LOG,
      exportLog: PT_EXPORT_LOG,
      importLog: PT_IMPORT_LOG,
      showLogInFolder: PT_SHOW_LOG_IN_FOLDER,
    },
    tracker: {
      getRuns: ptTracker.getPtRuns,
      getDiskUsageBytes: ptTracker.getPtDiskUsageBytes,
      awaitPendingSaves: ptTracker.awaitPendingPtSaves,
      setRunTags: ptTracker.setPtRunTags,
      setRunNotes: ptTracker.setPtRunNotes,
      deleteRun: ptTracker.deletePtRun,
      deleteRunLog: ptTracker.deletePtRunLog,
      getRunLogPath: ptTracker.getPtRunLogPath,
    },
    importLog: importProfitTakerLog,
    exportBaseName: (id) => `profit-taker_${id}`,
  });
}

export { register };
