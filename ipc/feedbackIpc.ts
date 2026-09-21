import fs from "node:fs";
import os from "node:os";

import { app } from "electron";

import { backendClientHeader, BACKEND_URL } from "../config/shared/backendConfig";
import { FEEDBACK_LIMITS, normalizeFeedback, type FeedbackResult } from "../config/shared/feedback";
import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { FEEDBACK_CONTEXT, FEEDBACK_SUBMIT } from "../config/shared/ipcChannels";
import { getLogFilePath } from "../services/logger";
import { redactLogPaths } from "../services/logPrivacy";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";

function feedbackContext() {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    diagnostics: { osVersion: os.release(), arch: process.arch },
  };
}

// The newest lines of main.log, cut to the limit on a line boundary.
function readLogTail(): string | undefined {
  const filePath = getLogFilePath();
  if (!filePath) return undefined;
  try {
    const handle = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(handle).size;
      const length = Math.min(size, FEEDBACK_LIMITS.logChars);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      let text = buffer.toString("utf8");
      if (length < size) text = text.slice(text.indexOf("\n") + 1);
      return text.trim().length > 0 ? redactLogPaths(text) : undefined;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

export function register(): void {
  let sending = false;
  let nextSubmission = 0;
  handleAuthorized(FEEDBACK_CONTEXT, assertMainRendererSender, feedbackContext);
  handleAuthorized(
    FEEDBACK_SUBMIT,
    assertMainRendererSender,
    async (_event, raw: unknown): Promise<FeedbackResult> => {
      const report = normalizeFeedback(raw);
      if (!report) return { ok: false, error: "invalid" };
      if (sending || Date.now() < nextSubmission) return { ok: false, error: "rate_limited" };
      const context = feedbackContext();
      report.appVersion = context.appVersion;
      report.platform = context.platform;
      if (report.diagnostics) {
        Object.assign(report.diagnostics, context.diagnostics);
        const log = readLogTail();
        if (log) report.diagnostics.log = log;
        else delete report.diagnostics.log;
      }
      sending = true;
      try {
        return await withAbortTimeout(35_000, async (signal): Promise<FeedbackResult> => {
          const base = (process.env.VITE_WFM_BACKEND_URL || BACKEND_URL).replace(/\/+$/, "");
          const response = await fetch(`${base}/v1/feedback`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...backendClientHeader(context.appVersion),
            },
            body: JSON.stringify(report),
            redirect: "error",
            signal,
          });
          if (response.status === 429) return { ok: false, error: "rate_limited" };
          if (response.status === 404 || response.status === 503)
            return { ok: false, error: "unavailable" };
          if (response.status === 400 || response.status === 413)
            return { ok: false, error: "invalid" };
          if (!response.ok) return { ok: false, error: "failed" };
          const result: unknown = await response.json();
          if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
            return { ok: false, error: "failed" };
          nextSubmission = Date.now() + 30_000;
          return { ok: true };
        });
      } catch {
        return { ok: false, error: "failed" };
      } finally {
        sending = false;
      }
    },
  );
}
