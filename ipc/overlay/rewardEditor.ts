import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type context from "../context";
import {
  DEFAULT_OVERLAY_FIELD_STYLE,
  getOverlayDescriptor,
  isOverlayField,
  normalizeOverlayFieldStyle,
  normalizeOverlayLayout,
  type OverlayEditState,
  type OverlayLayout,
  type OverlayLayoutKind,
} from "../../config/shared/overlayLayout";
import { OVERLAY_EDIT_STATE } from "../../config/shared/ipcChannels";
import { asRecord } from "../../config/shared/objectValidation";
import type { RewardPresentation } from "../../config/shared/rewardPresentation";

const UNDO_LIMIT = 100;

function validCardOffsets(kind: OverlayLayoutKind, value: unknown): boolean {
  if (value === null) return true;
  const cards = asRecord(value);
  const count = getOverlayDescriptor(kind).cardCount ?? 0;
  return (
    Boolean(cards) &&
    count > 0 &&
    Object.entries(cards ?? {}).every(([key, offset]) => {
      const entry = asRecord(offset);
      return (
        /^\d$/.test(key) &&
        Number(key) < count &&
        entry !== null &&
        Object.keys(entry).every((axis) => axis === "x" || axis === "y") &&
        [entry.x, entry.y].every((n) => typeof n === "number" && Number.isFinite(n))
      );
    })
  );
}

export function createOverlayEditor(options: {
  ctx: typeof context;
  persist: () => boolean;
  applySaved: (state: OverlayEditState) => void;
  getLastReward?: () => RewardPresentation | null;
}) {
  const { ctx } = options;
  let session: {
    owner: WebContents;
    state: OverlayEditState;
    reward: RewardPresentation | null;
    history: OverlayLayout[];
    group: string | null;
  } | null = null;
  let revision = 0;
  let selectedKind: OverlayLayoutKind = "reward";
  function savedState(kind: OverlayLayoutKind = selectedKind): OverlayEditState {
    const descriptor = getOverlayDescriptor(kind);
    return {
      kind,
      sessionId: null,
      revision,
      layout: normalizeOverlayLayout(
        kind,
        kind === "reward"
          ? ctx.overlaySettings.rewardLayout
          : ctx.overlaySettings.overlayLayouts?.[kind],
      ),
      selectedField: descriptor.defaultSelectedField,
      previewCount: kind === "reward" ? 4 : descriptor.previewCounts[0],
      previewVariant: descriptor.variants[0].value,
      scale:
        kind === "tradeNotification"
          ? 1
          : (ctx.overlaySettings.overlayWindowScales?.[kind] ??
            ctx.overlaySettings.overlayScale ??
            1),
    };
  }
  function state(): OverlayEditState {
    return session?.state ?? savedState();
  }
  function publish(): OverlayEditState {
    revision += 1;
    if (session) session.state.revision = revision;
    const next = state();
    if (session && !session.owner.isDestroyed()) session.owner.send(OVERLAY_EDIT_STATE, next);
    return next;
  }
  function finish(save: boolean): void {
    if (!session) return;
    const current = session;
    if (save) {
      const previous = ctx.overlaySettings;
      const kind = current.state.kind;
      const layout = normalizeOverlayLayout(kind, current.state.layout);
      ctx.overlaySettings = {
        ...previous,
        ...(kind === "reward"
          ? { rewardLayout: layout }
          : { overlayLayouts: { ...previous.overlayLayouts, [kind]: layout } }),
        ...(kind === "tradeNotification"
          ? {}
          : {
              overlayWindowScales: { ...previous.overlayWindowScales, [kind]: current.state.scale },
            }),
      };
      if (!options.persist()) {
        ctx.overlaySettings = previous;
        throw new Error("Could not save overlay layout");
      }
    }
    current.owner.removeListener("destroyed", cancel);
    current.owner.removeListener("render-process-gone", cancel);
    current.owner.removeListener("did-start-navigation", navigation);
    session = null;
    const next = publish();
    if (save) options.applySaved(next);
    if (!current.owner.isDestroyed()) current.owner.send(OVERLAY_EDIT_STATE, next);
  }
  function cancel(): void {
    finish(false);
  }
  function navigation(_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void {
    if (mainFrame && !inPlace) cancel();
  }
  function requireSession(token: unknown, owner?: WebContents) {
    if (!session || token !== session.state.sessionId || (owner && owner !== session.owner)) {
      throw new Error("Overlay editor session is no longer active");
    }
    return session;
  }
  function begin(owner: WebContents, kind: OverlayLayoutKind = "reward"): OverlayEditState {
    if (session) {
      if (session.owner === owner && session.state.kind === kind) return state();
      throw new Error("Overlay editor is already open");
    }
    selectedKind = kind;
    const initial = savedState(kind);
    session = {
      owner,
      state: { ...initial, sessionId: randomUUID() },
      reward: kind === "reward" ? structuredClone(options.getLastReward?.() ?? null) : null,
      history: [],
      group: null,
    };
    owner.on("destroyed", cancel);
    owner.on("render-process-gone", cancel);
    owner.on("did-start-navigation", navigation);
    return publish();
  }
  function update(token: unknown, raw: unknown, owner?: WebContents): OverlayEditState {
    const current = requireSession(token, owner);
    const command = asRecord(raw);
    if (!command) throw new Error("Invalid overlay editor command");
    const draft = current.state;
    const field = command.field;
    const before = JSON.stringify(draft.layout);
    const previous = structuredClone(draft.layout);
    let group: string | null = null;
    switch (command.type) {
      case "field": {
        const patch = asRecord(command.patch);
        if (
          !isOverlayField(draft.kind, field) ||
          !patch ||
          Object.keys(patch).some(
            (key) => !["x", "y", "scale", "color", "hidden", "cards"].includes(key),
          )
        )
          throw new Error("Invalid overlay field");
        for (const key of ["x", "y", "scale"]) {
          if (key in patch && (typeof patch[key] !== "number" || !Number.isFinite(patch[key])))
            throw new Error("Invalid overlay field number");
        }
        if ("hidden" in patch && typeof patch.hidden !== "boolean")
          throw new Error("Invalid visibility");
        if (
          "color" in patch &&
          patch.color !== null &&
          (typeof patch.color !== "string" || !/^#[\da-f]{6}$/i.test(patch.color))
        )
          throw new Error("Invalid field color");
        if ("cards" in patch && !validCardOffsets(draft.kind, patch.cards))
          throw new Error("Invalid card offsets");
        if (
          (command.group !== undefined &&
            (typeof command.group !== "string" || !command.group || command.group.length > 64)) ||
          (command.adjust !== undefined && typeof command.adjust !== "boolean")
        )
          throw new Error("Invalid overlay edit group");
        const style = { ...(draft.layout.fields[field] ?? DEFAULT_OVERLAY_FIELD_STYLE), ...patch };
        if (patch.cards === null) delete style.cards;
        draft.layout.fields[field] = normalizeOverlayFieldStyle(draft.kind, style);
        group = typeof command.group === "string" ? command.group : null;
        break;
      }
      case "select": {
        const fields: unknown = command.fields === undefined ? [field] : command.fields;
        const card = command.card;
        const descriptor = getOverlayDescriptor(draft.kind);
        if (
          !isOverlayField(draft.kind, field) ||
          !Array.isArray(fields) ||
          fields.length > descriptor.fields.length ||
          !fields.every((entry) => isOverlayField(draft.kind, entry)) ||
          (card !== undefined &&
            (typeof card !== "number" ||
              !Number.isInteger(card) ||
              card < 0 ||
              card >= (descriptor.cardCount ?? 0)))
        )
          throw new Error("Invalid overlay field");
        const selection = [...new Set<string>([...fields, field])];
        draft.selectedField = field;
        if (selection.length > 1) draft.selectedFields = selection;
        else delete draft.selectedFields;
        if (card !== undefined) draft.selectedCard = card;
        break;
      }
      case "reset":
        if (field === undefined) draft.layout = normalizeOverlayLayout(draft.kind, undefined);
        else if (isOverlayField(draft.kind, field)) {
          delete draft.layout.fields[field];
          draft.layout = normalizeOverlayLayout(draft.kind, draft.layout);
        } else throw new Error("Invalid overlay field");
        break;
      case "undo": {
        const restored = current.history.pop();
        if (restored) draft.layout = restored;
        current.group = null;
        break;
      }
      case "preview":
        if (
          !getOverlayDescriptor(draft.kind).previewCounts.includes(
            Number(command.count) as 1 | 2 | 3 | 4,
          ) ||
          typeof command.count !== "number" ||
          typeof command.variant !== "string" ||
          (!(command.variant === "last" && current.reward) &&
            !getOverlayDescriptor(draft.kind).variants.some(
              (variant) => variant.value === command.variant,
            ))
        )
          throw new Error("Invalid preview");
        draft.previewCount =
          command.variant === "last" && current.reward
            ? current.reward.count
            : (command.count as OverlayEditState["previewCount"]);
        draft.previewVariant = command.variant as OverlayEditState["previewVariant"];
        if (draft.selectedCard !== undefined && draft.selectedCard >= draft.previewCount)
          delete draft.selectedCard;
        break;
      case "scale":
        if (draft.kind === "tradeNotification")
          throw new Error("Trade notification uses a fixed window scale");
        if (typeof command.scale !== "number" || !Number.isFinite(command.scale))
          throw new Error("Invalid overlay scale");
        draft.scale = Math.min(1.5, Math.max(0.75, command.scale));
        break;
      default:
        throw new Error("Unknown overlay editor command");
    }
    if (
      command.type !== "undo" &&
      command.adjust !== true &&
      JSON.stringify(draft.layout) !== before
    ) {
      if (!group || group !== current.group) {
        current.history.push(previous);
        if (current.history.length > UNDO_LIMIT) current.history.shift();
      }
      current.group = group;
    }
    if (current.history.length) draft.undoDepth = current.history.length;
    else delete draft.undoDepth;
    return publish();
  }
  return {
    begin,
    update,
    state,
    savedState,
    previewReward: () =>
      structuredClone(session?.reward ?? (session ? null : (options.getLastReward?.() ?? null))),
    end: (token: unknown, save: unknown, owner?: WebContents) => {
      requireSession(token, owner);
      if (typeof save !== "boolean") throw new Error("Invalid save flag");
      finish(save);
      return { ok: true as const };
    },
  };
}
