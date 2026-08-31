import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { withScope } from "../services/logger";
import * as tradeWorkbench from "../services/tradeWorkbench";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  parseWorkbenchOverrideAck,
  parseWorkbenchPlan,
  parseWorkbenchResolveReview,
  parseWorkbenchSafetySnapshot,
  validateWorkbenchPlan,
  WORKBENCH_ACK_OVERRIDE,
  WORKBENCH_CANCEL_RUN,
  WORKBENCH_EXECUTE_PLAN,
  WORKBENCH_GET_STATE,
  WORKBENCH_PREVIEW_PLAN,
  WORKBENCH_RECONCILE,
  WORKBENCH_RESOLVE_REVIEW,
  WORKBENCH_STATE_EVENT,
  type WorkbenchState,
} from "../config/shared/tradeWorkbenchTypes";

const log = withScope("tradeWorkbenchIpc");

function pushState(state: WorkbenchState): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(WORKBENCH_STATE_EVENT, state);
}

function register(): void {
  tradeWorkbench.configureTradeWorkbench({ onState: pushState });
  tradeWorkbench.initTradeWorkbench();

  handleAuthorized(WORKBENCH_GET_STATE, assertMainRendererSender, () =>
    tradeWorkbench.getWorkbenchState(),
  );

  handleAuthorized(WORKBENCH_PREVIEW_PLAN, assertMainRendererSender, (_event, plan, safety) => {
    const parsedPlan = parseWorkbenchPlan(plan);
    const parsedSafety = parseWorkbenchSafetySnapshot(safety);
    if (!parsedPlan || !parsedSafety) {
      log.warn("[Security] workbench:preview-plan blocked due to invalid payload");
      return { error: "Invalid workbench plan payload." };
    }
    return validateWorkbenchPlan(parsedPlan, parsedSafety);
  });

  handleAuthorized(WORKBENCH_EXECUTE_PLAN, assertMainRendererSender, (_event, plan, safety) => {
    const parsedPlan = parseWorkbenchPlan(plan);
    const parsedSafety = parseWorkbenchSafetySnapshot(safety);
    if (!parsedPlan || !parsedSafety) {
      log.warn("[Security] workbench:execute-plan blocked due to invalid payload");
      return {
        started: false,
        error: "Invalid workbench plan payload.",
        state: tradeWorkbench.getWorkbenchState(),
      };
    }
    return tradeWorkbench.executeWorkbenchPlan(parsedPlan, parsedSafety);
  });

  handleAuthorized(WORKBENCH_CANCEL_RUN, assertMainRendererSender, () =>
    tradeWorkbench.cancelWorkbenchRun(),
  );

  handleAuthorized(WORKBENCH_ACK_OVERRIDE, assertMainRendererSender, (_event, payload) => {
    const ack = parseWorkbenchOverrideAck(payload);
    if (!ack) {
      log.warn("[Security] workbench:ack-override blocked due to invalid payload");
      return { error: "Invalid override acknowledgement payload." };
    }
    return tradeWorkbench.acknowledgeWorkbenchOverride(ack);
  });

  handleAuthorized(WORKBENCH_RECONCILE, assertMainRendererSender, async () => {
    try {
      return await tradeWorkbench.reconcileWorkbench();
    } catch (err) {
      const message = normalizeErrorMessage(err, "Reconciliation failed.");
      log.error("[Workbench IPC] reconcile:", message);
      return { error: message };
    }
  });

  handleAuthorized(WORKBENCH_RESOLVE_REVIEW, assertMainRendererSender, (_event, payload) => {
    const parsed = parseWorkbenchResolveReview(payload);
    if (!parsed) {
      log.warn("[Security] workbench:resolve-review blocked due to invalid payload");
      return { error: "Invalid review resolution payload." };
    }
    return tradeWorkbench.resolveWorkbenchReview(parsed);
  });
}

export { register };
