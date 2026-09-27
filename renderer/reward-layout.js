(function () {
  const ONE_LINE_MIN_SCALE = 0.75;
  const SNAP_SCREEN_PX = 5;
  const round = (value) => Math.round(value * 100) / 100;

  window.installOverlayLayout = function installOverlayLayout(options) {
    const api = options.api || window.overlayLayoutApi;
    const root =
      typeof options.root === "string"
        ? document.querySelector(options.root)
        : options.root || document.getElementById("panel");
    if (!root || !api)
      return {
        flush: () => Promise.resolve(),
        isEditing: () => false,
        refresh: () => {},
        cancel: () => {},
      };
    const preview =
      window.parent !== window && new URLSearchParams(location.search).get("mode") === "editor";
    const coordinateScale = () => {
      const zoom =
        options.coordinateScale?.() ?? Number.parseFloat(getComputedStyle(document.body).zoom);
      return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    };
    const logicalRect = (value) => {
      const rect = value.getBoundingClientRect ? value.getBoundingClientRect() : value;
      const zoom = coordinateScale();
      return {
        left: rect.left / zoom,
        top: rect.top / zoom,
        right: rect.right / zoom,
        bottom: rect.bottom / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
    };
    const cardOf = (element) => (options.cardFor ? options.cardFor(element) : null);
    const cardKey = (card) => String(options.cardIndex(card));
    // Absolute children are placed from the card's padding box.
    const cardOrigin = (card) => {
      const rect = logicalRect(card);
      return { x: rect.left + card.clientLeft, y: rect.top + card.clientTop };
    };
    const spotOn = (card, element) => {
      const rect = logicalRect(element);
      const origin = cardOrigin(card);
      return { x: rect.left - origin.x, y: rect.top - origin.y };
    };
    const isChip = (field) => options.chipFields?.includes(field) === true;
    const editorOptions = () => api.editorOptions?.() ?? null;
    const originalBackgrounds = new WeakMap();
    const placed = new WeakSet();
    const pinned = new Set();
    let chipAnchors = new Map();
    let blockAnchors = new Map();
    let state = null;
    let frame = 0;
    let fitting = false;
    let settling = false;
    let gesture = null;
    let holding = null;
    let operations = 0;
    let nudgeGroup = null;
    let guideLayer = null;
    const heldScrollers = new Map();
    const commands = [];
    let inFlight = null;
    let sending = false;
    const drains = [];
    const pendingClamps = new Set();

    function editing() {
      return preview && Boolean(state?.sessionId);
    }

    // The card-relative spot an offset is from: a chip's is its field's spot on the first
    // card that renders it, a block's is its own spot in its own card's flow.
    function anchorOf(element) {
      const field = element.dataset.rewardField;
      return isChip(field) ? chipAnchors.get(field) : blockAnchors.get(element);
    }

    function scheduleLayout() {
      if (!frame) frame = requestAnimationFrame(applyLayout);
    }

    // A move measures against the anchors, so it starts from a layout of the page as it
    // is now, keeping the fitted text sizes; a pass the first one scheduled runs at once.
    function settleLayout() {
      settling = true;
      try {
        applyLayout();
        if (frame) applyLayout();
      } finally {
        settling = false;
      }
    }

    function selectedFields() {
      if (state?.selectedFields?.length) return state.selectedFields;
      return state?.selectedField ? [state.selectedField] : [];
    }

    function scopeFor(event) {
      return event?.altKey || editorOptions()?.scope === "card" ? "card" : "all";
    }

    function mergeStyle(style, patch) {
      const next = { ...options.defaultFieldStyle, ...style, ...patch };
      if (!next.cards || !Object.keys(next.cards).length) delete next.cards;
      return next;
    }

    function offsetFor(style, key) {
      const card = key === null ? null : style.cards?.[key];
      return card ? { x: card.x, y: card.y } : { x: style.x, y: style.y };
    }

    function contentBox(container) {
      const bounds = logicalRect(container);
      const styles = getComputedStyle(container);
      const left = bounds.left + container.clientLeft;
      const top = bounds.top + container.clientTop;
      return {
        left: left + Number.parseFloat(styles.paddingLeft),
        top: top + Number.parseFloat(styles.paddingTop),
        right: left + container.clientWidth - Number.parseFloat(styles.paddingRight),
        bottom: top + container.clientHeight - Number.parseFloat(styles.paddingBottom),
      };
    }

    function oneLineRatio(element) {
      element.style.whiteSpace = "nowrap";
      const natural = element.scrollWidth;
      const available = element.clientWidth;
      element.style.whiteSpace = "";
      if (!available || !(natural > available)) return null;
      // scrollWidth and clientWidth are whole pixels, so the fit gives back one.
      return Math.floor(((available - 1) / natural) * 1000) / 1000;
    }

    function fitOneLine(elements) {
      const fields = options.fitOneLineFields;
      if (!fields?.length || fitting || settling || gesture) return;
      fitting = true;
      try {
        for (const element of elements) {
          if (!fields.includes(element.dataset.rewardField)) continue;
          element.style.removeProperty("--reward-fit-scale");
          const compact = options.fitCompactFor?.(element);
          compact?.classList.remove("reward-fit-compact");
          let ratio = oneLineRatio(element);
          if (ratio !== null && compact) {
            compact.classList.add("reward-fit-compact");
            ratio = oneLineRatio(element);
          }
          if (ratio !== null && ratio >= ONE_LINE_MIN_SCALE && ratio < 1)
            element.style.setProperty("--reward-fit-scale", String(ratio));
        }
      } finally {
        fitting = false;
      }
    }

    function selectedOnCard(element, field, selection) {
      if (!selection.has(field)) return false;
      const card = cardOf(element);
      if (!card || editorOptions()?.scope !== "card" || state.selectedCard === undefined)
        return true;
      return cardKey(card) === String(state.selectedCard);
    }

    const hasScrollbar = (element) => {
      const styles = getComputedStyle(element);
      return (
        element.offsetWidth -
          element.clientWidth -
          Number.parseFloat(styles.borderLeftWidth) -
          Number.parseFloat(styles.borderRightWidth) >
        0
      );
    };

    // Moved fields back in the flow can make a card list overflow, and the scrollbar
    // that brings would narrow the cards the anchors are measured on.
    function scrollersOf(elements) {
      for (const [scroller, inline] of heldScrollers) scroller.style.overflowY = inline;
      heldScrollers.clear();
      const scrollers = new Map();
      if (!options.cardFor) return scrollers;
      for (const element of elements) {
        let parent = cardOf(element)?.parentElement;
        while (parent && parent !== root && !scrollers.has(parent)) {
          if (/auto|scroll/.test(getComputedStyle(parent).overflowY))
            scrollers.set(parent, { bar: false, inline: parent.style.overflowY });
          parent = parent.parentElement;
        }
      }
      return scrollers;
    }

    function applyLayout() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      options.tagFields?.();
      const elements = [...root.querySelectorAll("[data-reward-field]")];
      const isEditing = editing();
      const selection = new Set(isEditing ? selectedFields() : []);
      document.body.classList.toggle("reward-layout-editing", isEditing);
      const scrollers = scrollersOf(elements);
      // Fields are measured and drawn with each scrollbar held, first off, then as the drawn
      // page wants it. A page that wants a scrollbar only while it lacks one stays held.
      let drawn;
      for (let attempt = 0; ; attempt += 1) {
        for (const [scroller, { bar }] of scrollers)
          scroller.style.overflowY = bar ? "scroll" : "hidden";
        drawn = drawFields(elements, isEditing, selection);
        for (const [scroller, { inline }] of scrollers) scroller.style.overflowY = inline;
        let settled = true;
        for (const [scroller, entry] of scrollers) {
          entry.wants = hasScrollbar(scroller);
          if (entry.wants !== entry.bar) settled = false;
        }
        if (settled) break;
        if (attempt === 1) {
          for (const [scroller, { bar, inline }] of scrollers) {
            scroller.style.overflowY = bar ? "scroll" : "hidden";
            heldScrollers.set(scroller, inline);
          }
          break;
        }
        for (const entry of scrollers.values()) entry.bar = entry.wants;
      }
      const { positions, limits } = drawn;
      const resolved = new Set();
      const resolvedFields = new Set();
      const adjusted = new Set();
      for (const { group, offset, x, y } of positions) {
        const range = limits.get(group);
        if (!isEditing || !pendingClamps.has(range.field) || resolved.has(group)) continue;
        resolved.add(group);
        resolvedFields.add(range.field);
        const patch = { x: round(x), y: round(y) };
        if (patch.x === offset.x && patch.y === offset.y) continue;
        const style = state.layout.fields[range.field];
        state.layout.fields[range.field] =
          range.key === null
            ? { ...style, ...patch }
            : mergeStyle(style, { cards: { ...style.cards, [range.key]: patch } });
        adjusted.add(range.field);
      }
      for (const field of resolvedFields) pendingClamps.delete(field);
      for (const field of adjusted) {
        if (!holding?.has(field)) send(fieldCommand(field, undefined, true));
      }
      if (isEditing && !gesture && !holding) validateCard();
    }

    function drawFields(elements, isEditing, selection) {
      for (const card of pinned) card.style.minHeight = "";
      pinned.clear();
      for (const element of elements) {
        const field = element.dataset.rewardField;
        const style = state?.layout.fields[field];
        element.classList.toggle("reward-field-hidden", style?.hidden === true);
        element.classList.toggle(
          "reward-field-selected",
          isEditing && selectedOnCard(element, field, selection),
        );
        element.style.transform = "";
        element.style.translate = "";
        element.style.scale = "";
        if (placed.has(element)) {
          placed.delete(element);
          element.classList.remove("reward-field-moved");
          element.style.left = "";
          element.style.top = "";
          element.style.width = "";
        }
        if (options.fitWidthFields?.includes(field)) {
          element.style.width = style && style.scale !== 1 ? `${100 / style.scale}%` : "";
        }
        element.style.color = style?.color || "";
        element.style.setProperty("--overlay-field-color", style?.color || "");
        if (!originalBackgrounds.has(element))
          originalBackgrounds.set(element, element.style.backgroundColor);
        element.style.backgroundColor =
          element.dataset.layoutTint === "background" && style?.color
            ? style.color
            : originalBackgrounds.get(element);
        element.style.maskImage = "";
        element.style.maskMode = "luminance";
        if (field === "scanSpinner") element.style.borderTopColor = style?.color || "";
        const fallback = element.querySelector(".slot-set-part-fallback");
        if (fallback) fallback.style.color = style?.color || "";
        const image = element.querySelector("img");
        if (image) {
          image.style.visibility = "";
          if (style?.color) {
            element.style.backgroundColor = style.color;
            element.style.maskImage = `url("${image.src.replaceAll('"', "%22")}")`;
            image.style.visibility = "hidden";
          }
        }
      }
      fitOneLine(elements);
      // Every field is in the flow here, so the first card that renders a chip
      // gives the spot a moved copy of it takes on every card.
      chipAnchors = new Map();
      blockAnchors = new Map();
      const entries = [];
      for (const element of elements) {
        if (!element.getClientRects().length) continue;
        const field = element.dataset.rewardField;
        const card = cardOf(element);
        const chip = Boolean(card) && isChip(field);
        const style = state?.layout.fields[field];
        if (chip && !chipAnchors.has(field)) chipAnchors.set(field, spotOn(card, element));
        if (!style || style.hidden) continue;
        const key = card ? cardKey(card) : null;
        const offset = offsetFor(style, key);
        const own = key !== null && Boolean(style.cards?.[key]);
        const box = card ? logicalRect(element) : null;
        entries.push({
          element,
          field,
          style,
          card,
          key,
          offset,
          own,
          moved: own || (Boolean(card) && (offset.x !== 0 || offset.y !== 0)),
          chip,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
        });
      }
      // Bounds come from the page before a chip leaves its row.
      const frames = new Map();
      for (const { element } of entries) {
        const container = options.boundsFor?.(element);
        if (container && !frames.has(container)) frames.set(container, logicalRect(container));
      }
      const chips = entries.filter((entry) => entry.moved && entry.chip);
      const heights = new Map();
      for (const { card } of chips) {
        if (heights.has(card)) continue;
        const rect = logicalRect(card);
        heights.set(card, { height: rect.height, tail: rect.bottom - contentBox(card).bottom });
      }
      for (const entry of chips) {
        const anchor = anchorOf(entry.element);
        entry.element.classList.add("reward-field-moved");
        entry.element.style.left = `${anchor.x}px`;
        entry.element.style.top = `${anchor.y}px`;
        entry.element.style.width = `${entry.width}px`;
        placed.add(entry.element);
      }
      // A block's spot is where its card's rows put it once the moved chips are out.
      for (const entry of entries) {
        if (entry.card && !entry.chip)
          blockAnchors.set(entry.element, spotOn(entry.card, entry.element));
      }
      // A card closes up behind a chip that left its row, but never below a moved field
      // still drawn there, such as the chip that set its bottom.
      for (const [card, { height, tail }] of heights) {
        let bottom = 0;
        for (const entry of entries) {
          if (entry.card !== card || !entry.moved) continue;
          const drawn =
            anchorOf(entry.element).y + entry.offset.y + entry.height * entry.style.scale;
          bottom = Math.max(bottom, drawn);
        }
        card.style.minHeight = `${Math.min(height, card.clientTop + bottom + tail)}px`;
        pinned.add(card);
      }
      const panel = logicalRect(root);
      const positions = [];
      const limits = new Map();
      for (const entry of entries) {
        const { element, field, style } = entry;
        const flow = logicalRect(element);
        if (!flow.width || !flow.height) continue;
        // A moved block keeps its space and is drawn from its own spot.
        let shift = { x: 0, y: 0 };
        if (entry.moved && !entry.chip) {
          const anchor = anchorOf(element);
          const origin = cardOrigin(entry.card);
          shift = {
            x: round(origin.x + anchor.x - flow.left),
            y: round(origin.y + anchor.y - flow.top),
          };
        }
        const rect = { ...flow, left: flow.left + shift.x, top: flow.top + shift.y };
        const container = options.boundsFor?.(element);
        const bounds = container ? (frames.get(container) ?? logicalRect(container)) : panel;
        if (
          bounds.bottom <= panel.top ||
          bounds.top >= panel.bottom ||
          bounds.right <= panel.left ||
          bounds.left >= panel.right
        )
          continue;
        const left = bounds.left + 3;
        const top = bounds.top + 3;
        const right = bounds.right - 3;
        const bottom = bounds.bottom - 3;
        if (right <= left || bottom <= top) continue;
        const scale = Math.min(
          style.scale,
          (right - left) / rect.width,
          (bottom - top) / rect.height,
        );
        const group = entry.own ? `${field}\n${entry.key}` : field;
        const previous = limits.get(group);
        const range = {
          field,
          key: entry.own ? entry.key : null,
          minX: Math.max(left - rect.left, previous?.minX ?? -Infinity),
          maxX: Infinity,
          minY: Math.max(top - rect.top, previous?.minY ?? -Infinity),
          maxY: Infinity,
        };
        limits.set(group, range);
        positions.push({
          element,
          group,
          offset: entry.offset,
          shift,
          scale,
          width: rect.width,
          height: rect.height,
          right: right - rect.left,
          bottom: bottom - rect.top,
        });
      }
      for (const position of positions) {
        const range = limits.get(position.group);
        position.scale = Math.min(
          position.scale,
          (position.right - range.minX) / position.width,
          (position.bottom - range.minY) / position.height,
        );
        range.maxX = Math.min(range.maxX, position.right - position.width * position.scale);
        range.maxY = Math.min(range.maxY, position.bottom - position.height * position.scale);
      }
      for (const position of positions) {
        const { element, group, offset, shift, scale } = position;
        const range = limits.get(group);
        position.x = Math.max(range.minX, Math.min(range.maxX, offset.x));
        position.y = Math.max(range.minY, Math.min(range.maxY, offset.y));
        // Individual properties preserve the spinner's rotation animation.
        element.style.scale = String(Math.max(0.05, scale));
        element.style.translate = `${position.x + shift.x}px ${position.y + shift.y}px`;
      }
      return { positions, limits };
    }

    // The card that holds a field: the given one when it does, else the first shown one,
    // null outside the cards, undefined when no shown card has it.
    function homeCard(field, key) {
      let first;
      for (const element of root.querySelectorAll("[data-reward-field]")) {
        if (element.dataset.rewardField !== field) continue;
        const card = cardOf(element);
        if (!card) return null;
        if (!card.getClientRects().length) continue;
        const own = cardKey(card);
        if (own === key) return own;
        first ??= own;
      }
      return first;
    }

    // A preview change or a list pick can leave the selection on a card without the
    // field; "This card" also needs some card before the first click.
    function validateCard() {
      if (!options.cardFor || !state?.selectedField) return;
      const key = activeKey();
      if (key === null && editorOptions()?.scope !== "card") return;
      const home = homeCard(state.selectedField, key);
      if (typeof home === "string" && home !== key)
        selectField(state.selectedField, { fields: selectedFields(), card: Number(home) });
    }

    function fieldCommand(field, group, adjust) {
      const style = state.layout.fields[field];
      const patch = { x: style.x, y: style.y };
      if (options.cardFor) patch.cards = style.cards ?? null;
      const command = { type: "field", field, patch };
      if (group) command.group = group;
      if (adjust) command.adjust = true;
      return command;
    }

    // Moves pass through here so the clamp lands in the one command each field sends.
    function commit(patches, group) {
      for (const [field, patch] of patches) {
        state.layout.fields[field] = mergeStyle(state.layout.fields[field], patch);
        pendingClamps.add(field);
      }
      holding = new Set(patches.keys());
      try {
        applyLayout();
      } finally {
        holding = null;
      }
      for (const field of patches.keys()) send(fieldCommand(field, group, false));
    }

    // "This card" stays on the given card; otherwise a card without the field falls
    // back to the first card that shows it.
    function elementFor(field, key, strict) {
      let fallback = null;
      for (const element of root.querySelectorAll("[data-reward-field]")) {
        if (element.dataset.rewardField !== field || !element.getClientRects().length) continue;
        const card = cardOf(element);
        if (!card || key === null || cardKey(card) === key) return element;
        fallback ??= element;
      }
      return strict ? null : fallback;
    }

    // The offset that keeps a field exactly where it is now, on the card it sits on.
    function placementOf(field, key, strict = false) {
      const element = elementFor(field, key, strict);
      if (!element) return null;
      const card = cardOf(element);
      const rect = logicalRect(element);
      let current;
      if (card) {
        const origin = cardOrigin(card);
        const anchor = anchorOf(element) ?? { x: rect.left - origin.x, y: rect.top - origin.y };
        current = { x: rect.left - origin.x - anchor.x, y: rect.top - origin.y - anchor.y };
      } else {
        const offset = getComputedStyle(element).translate.split(" ").map(Number.parseFloat);
        current = {
          x: Number.isFinite(offset[0]) ? offset[0] : 0,
          y: Number.isFinite(offset[1]) ? offset[1] : 0,
        };
      }
      return { element, card, key: card ? cardKey(card) : null, rect, current };
    }

    function seedFor(field, key, scope) {
      const at = placementOf(field, key, scope === "card");
      if (!at) return null;
      const style = state.layout.fields[field] || options.defaultFieldStyle;
      return {
        field,
        at,
        style: structuredClone(style),
        scope: at.key === null ? "all" : scope,
      };
    }

    // "All cards" shifts the shared offset and every card of its own by the same amount.
    function movePatch(seed, dx, dy) {
      const shift = (offset) => ({ x: round(offset.x + dx), y: round(offset.y + dy) });
      const { style, at } = seed;
      if (seed.scope === "card") return { cards: { ...style.cards, [at.key]: shift(at.current) } };
      const own = at.key !== null && style.cards?.[at.key];
      const patch = shift(own ? style : at.current);
      if (style.cards)
        patch.cards = Object.fromEntries(
          Object.entries(style.cards).map(([key, offset]) => [key, shift(offset)]),
        );
      return patch;
    }

    function clearGuides() {
      guideLayer?.remove();
      guideLayer = null;
    }

    function drawGuides(guides) {
      clearGuides();
      if (!guides.length) return;
      guideLayer = document.createElement("div");
      guideLayer.className = "reward-layout-guides";
      for (const guide of guides) {
        const line = document.createElement("div");
        line.className = "reward-layout-guide";
        line.style.left = `${guide.left}px`;
        line.style.top = `${guide.top}px`;
        line.style.width = `${guide.width}px`;
        line.style.height = `${guide.height}px`;
        guideLayer.appendChild(line);
      }
      document.body.appendChild(guideLayer);
    }

    function lines(rect) {
      return {
        x: [rect.left, (rect.left + rect.right) / 2, rect.right],
        y: [rect.top, (rect.top + rect.bottom) / 2, rect.bottom],
      };
    }

    // Snaps the dragged box to the card's content edges and centre and to the
    // other visible fields on the same card, returning the adjusted move.
    function snap(dx, dy) {
      const settings = editorOptions();
      const lead = gesture.seeds[0]?.at;
      if (!settings || !lead) return { dx, dy, guides: [] };
      // A selected field shown only on another card moves along but does not snap.
      const moving = gesture.seeds.map((seed) => seed.at).filter((at) => at.card === lead.card);
      const container = lead.card || options.boundsFor?.(lead.element) || root;
      const bounds = logicalRect(container);
      const targets = [{ rect: contentBox(container), span: bounds }];
      const excluded = new Set(gesture.seeds.map((seed) => seed.at.element));
      for (const element of container.querySelectorAll("[data-reward-field]")) {
        if (excluded.has(element) || !element.getClientRects().length) continue;
        if ([...excluded].some((other) => other.contains(element) || element.contains(other)))
          continue;
        const rect = logicalRect(element);
        if (rect.width && rect.height) targets.push({ rect, span: rect });
      }
      const box = {
        left: Math.min(...moving.map((at) => at.rect.left)) + dx,
        top: Math.min(...moving.map((at) => at.rect.top)) + dy,
        right: Math.max(...moving.map((at) => at.rect.right)) + dx,
        bottom: Math.max(...moving.map((at) => at.rect.bottom)) + dy,
      };
      const screenPx = 1 / ((Number(settings.zoom) || 1) * coordinateScale());
      const threshold = SNAP_SCREEN_PX * screenPx;
      const own = lines(box);
      const best = { x: null, y: null };
      for (const target of targets) {
        const theirs = lines(target.rect);
        for (const axis of ["x", "y"]) {
          for (const mine of own[axis]) {
            for (const value of theirs[axis]) {
              const distance = value - mine;
              if (Math.abs(distance) > threshold) continue;
              if (best[axis] && Math.abs(best[axis].distance) <= Math.abs(distance)) continue;
              best[axis] = { distance, value, span: target.span };
            }
          }
        }
      }
      const guides = [];
      const snapped = { dx: dx + (best.x?.distance ?? 0), dy: dy + (best.y?.distance ?? 0) };
      const moved = {
        left: box.left + (best.x?.distance ?? 0),
        right: box.right + (best.x?.distance ?? 0),
        top: box.top + (best.y?.distance ?? 0),
        bottom: box.bottom + (best.y?.distance ?? 0),
      };
      if (best.x) {
        const top = Math.min(moved.top, best.x.span.top);
        guides.push({
          left: best.x.value,
          top,
          width: screenPx,
          height: Math.max(moved.bottom, best.x.span.bottom) - top,
        });
      }
      if (best.y) {
        const left = Math.min(moved.left, best.y.span.left);
        guides.push({
          left,
          top: best.y.value,
          width: Math.max(moved.right, best.y.span.right) - left,
          height: screenPx,
        });
      }
      return { ...snapped, guides };
    }

    function accept(next) {
      if (!next?.layout || (state && next.revision < state.revision)) return;
      next = structuredClone(next);
      const previous = state;
      if (previous?.sessionId === next.sessionId) {
        for (const command of [inFlight, ...commands]) {
          if (command?.type === "select") {
            next.selectedField = command.field;
            if (command.fields) next.selectedFields = command.fields;
            else delete next.selectedFields;
            if (command.card !== undefined) next.selectedCard = command.card;
          }
          if (command?.type === "field") {
            next.layout.fields[command.field] = mergeStyle(
              next.layout.fields[command.field],
              command.patch,
            );
          }
        }
        for (const field of gesture?.fields ?? []) {
          const style = previous.layout.fields[field];
          if (style) next.layout.fields[field] = style;
          else delete next.layout.fields[field];
        }
      }
      const samePreview =
        previous?.sessionId === next.sessionId &&
        previous.previewCount === next.previewCount &&
        previous.previewVariant === next.previewVariant;
      if (!samePreview) pendingClamps.clear();
      else {
        for (const [field, style] of Object.entries(next.layout.fields)) {
          const before = previous.layout.fields[field] || options.defaultFieldStyle;
          if (
            before &&
            (style.x !== before.x ||
              style.y !== before.y ||
              style.scale !== before.scale ||
              JSON.stringify(style.cards) !== JSON.stringify(before.cards))
          )
            pendingClamps.add(field);
        }
      }
      state = next;
      if (editing()) {
        if (
          previous?.sessionId !== next.sessionId ||
          previous.previewCount !== next.previewCount ||
          previous.previewVariant !== next.previewVariant
        ) {
          gesture = null;
          clearGuides();
          options.renderPreview?.(next);
        }
      } else if (previous?.sessionId) {
        gesture = null;
        clearGuides();
        commands.length = 0;
        options.resetPreview?.();
      }
      scheduleLayout();
    }

    async function sendPending() {
      if (sending || !commands.length || !editing()) return;
      sending = true;
      const sessionId = state.sessionId;
      const command = commands.shift();
      inFlight = command;
      let failure = null;
      try {
        const next = await api.editLayout(sessionId, command);
        inFlight = null;
        if (state?.sessionId === sessionId && !gesture) {
          accept(next);
          applyLayout();
        }
      } catch (error) {
        failure = error;
        if (state?.sessionId === sessionId) commands.unshift(command);
        console.warn("[Overlay] overlay layout edit failed", String(error));
      } finally {
        inFlight = null;
        sending = false;
        if (!failure && commands.length) void sendPending();
        else {
          for (const waiter of drains.splice(0)) {
            if (failure) waiter.reject(failure);
            else waiter.resolve();
          }
        }
      }
    }

    function send(command) {
      // A drag of several fields interleaves them, so the merge looks past the
      // other fields of the same step.
      for (let index = commands.length - 1; command.type === "field" && index >= 0; index -= 1) {
        const queued = commands[index];
        if (
          queued.type !== "field" ||
          queued.group !== command.group ||
          queued.adjust !== command.adjust
        )
          break;
        if (queued.field !== command.field) continue;
        queued.patch = { ...queued.patch, ...command.patch };
        void sendPending();
        return;
      }
      commands.push(command);
      void sendPending();
    }

    function selectField(field, choice = {}) {
      if (!editing()) return;
      const fields = choice.fields ? [...new Set(choice.fields)] : [field];
      const command = { type: "select", field };
      state = { ...state, selectedField: field };
      if (fields.length > 1) {
        state.selectedFields = fields;
        command.fields = fields;
      } else delete state.selectedFields;
      if (choice.card !== undefined) {
        state.selectedCard = choice.card;
        command.card = choice.card;
      }
      send(command);
      scheduleLayout();
    }

    function toggleField(field, card) {
      const current = selectedFields();
      const fields = current.includes(field)
        ? current.filter((entry) => entry !== field)
        : [...current, field];
      if (!fields.length) fields.push(field);
      const primary = fields.includes(field) ? field : fields[fields.length - 1];
      selectField(primary, { fields, card });
    }

    function activeKey() {
      return state?.selectedCard === undefined ? null : String(state.selectedCard);
    }

    function nudge(dx, dy, group) {
      settleLayout();
      const key = activeKey();
      const scope = scopeFor(null);
      const patches = new Map();
      for (const field of selectedFields()) {
        const seed = seedFor(field, key, scope);
        if (seed) patches.set(field, movePatch(seed, dx, dy));
      }
      if (patches.size) commit(patches, group);
    }

    function align(edge) {
      if (!editing() || gesture) return;
      settleLayout();
      const fields = selectedFields();
      const scope = scopeFor(null);
      const strict = scope === "card";
      const first = placementOf(fields[0], activeKey(), strict);
      if (!first) return;
      const key = first.key;
      const horizontal = ["left", "center", "right"].includes(edge);
      // Card-relative, so a field found on another card lines up with the same frame.
      const relative = (rect, card) => {
        const origin = card ? cardOrigin(card) : { x: 0, y: 0 };
        return {
          left: rect.left - origin.x,
          top: rect.top - origin.y,
          right: rect.right - origin.x,
          bottom: rect.bottom - origin.y,
        };
      };
      const measure = () =>
        fields
          .map((field) => ({ field, at: placementOf(field, key, strict) }))
          .filter(({ at }) => at)
          .map(({ field, at }) => ({ field, at, rect: relative(at.rect, at.card) }));
      const measured = measure();
      const frameRect =
        measured.length > 1
          ? {
              left: Math.min(...measured.map(({ rect }) => rect.left)),
              top: Math.min(...measured.map(({ rect }) => rect.top)),
              right: Math.max(...measured.map(({ rect }) => rect.right)),
              bottom: Math.max(...measured.map(({ rect }) => rect.bottom)),
            }
          : relative(
              contentBox(first.card || options.boundsFor?.(first.element) || root),
              first.card,
            );
      const target = {
        left: frameRect.left,
        center: (frameRect.left + frameRect.right) / 2,
        right: frameRect.right,
        top: frameRect.top,
        middle: (frameRect.top + frameRect.bottom) / 2,
        bottom: frameRect.bottom,
      }[edge];
      if (target === undefined) return;
      const edgeOf = (rect) =>
        ({
          left: rect.left,
          center: (rect.left + rect.right) / 2,
          right: rect.right,
          top: rect.top,
          middle: (rect.top + rect.bottom) / 2,
          bottom: rect.bottom,
        })[edge];
      const group = `align-${(operations += 1)}`;
      const changed = new Set();
      // A field leaving the flow can reflow one that stayed, so a pass repeats for it.
      for (let pass = 0; pass <= fields.length; pass += 1) {
        const patches = new Map();
        for (const { field, at, rect } of measure()) {
          const distance = target - edgeOf(rect);
          if (Math.abs(distance) < 0.01) continue;
          const seed = seedFor(field, at.key, scope);
          if (seed)
            patches.set(
              field,
              movePatch(seed, horizontal ? distance : 0, horizontal ? 0 : distance),
            );
        }
        if (!patches.size) break;
        for (const [field, patch] of patches) {
          state.layout.fields[field] = mergeStyle(state.layout.fields[field], patch);
          pendingClamps.add(field);
          changed.add(field);
        }
        holding = changed;
        try {
          applyLayout();
        } finally {
          holding = null;
        }
      }
      for (const field of changed) send(fieldCommand(field, group, false));
    }

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!editing() || event.button !== 0) return;
        const target =
          event.target instanceof Element ? event.target.closest("[data-reward-field]") : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        // Preventing the default also blocks focus entering this iframe from a host input.
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
        const field = target.dataset.rewardField;
        const card = cardOf(target);
        const key = card ? cardKey(card) : null;
        const index = card ? Number(key) : undefined;
        if (event.shiftKey) {
          toggleField(field, index);
          return;
        }
        const current = selectedFields();
        const keep = current.length > 1 && current.includes(field);
        const fields = keep ? current : [field];
        selectField(field, { fields, card: index });
        settleLayout();
        const scope = scopeFor(event);
        gesture = {
          x: event.clientX,
          y: event.clientY,
          field,
          fields: new Set(fields),
          seeds: [field, ...fields.filter((entry) => entry !== field)]
            .map((entry) => seedFor(entry, key, scope))
            .filter(Boolean),
          group: `drag-${(operations += 1)}`,
          moved: false,
          collapse: keep,
          card: index,
        };
        target.setPointerCapture(event.pointerId);
      },
      true,
    );

    document.addEventListener("pointermove", (event) => {
      if (!gesture || !editing()) return;
      if (!(event.buttons & 1)) {
        finishGesture();
        return;
      }
      if (!gesture.seeds.length) return;
      const zoom = coordinateScale();
      let dx = (event.clientX - gesture.x) / zoom;
      let dy = (event.clientY - gesture.y) / zoom;
      gesture.moved = true;
      if (!event.ctrlKey) {
        const snapped = snap(dx, dy);
        dx = snapped.dx;
        dy = snapped.dy;
        drawGuides(snapped.guides);
      } else clearGuides();
      const patches = new Map();
      for (const seed of gesture.seeds) patches.set(seed.field, movePatch(seed, dx, dy));
      commit(patches, gesture.group);
    });

    function finishGesture(event) {
      const ended = gesture;
      gesture = null;
      clearGuides();
      // A click without a drag on a field of a group selection selects that field alone.
      if (ended && !ended.moved && ended.collapse && event?.type === "pointerup")
        selectField(ended.field, { card: ended.card });
      void sendPending();
    }
    document.addEventListener("pointerup", finishGesture);
    document.addEventListener("pointercancel", finishGesture);
    document.addEventListener("lostpointercapture", finishGesture);
    window.addEventListener("blur", finishGesture);
    document.addEventListener("contextmenu", (event) => {
      if (editing()) event.preventDefault();
    });
    window.addEventListener("resize", scheduleLayout);
    document.addEventListener("scroll", scheduleLayout, true);
    void document.fonts.ready.then(scheduleLayout);
    new MutationObserver(scheduleLayout).observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    api.onLayout(accept);
    api.onEditorOptions?.(scheduleLayout);
    void api
      .getLayout()
      .then(accept)
      .catch((error) => {
        console.warn("[Overlay] overlay layout unavailable", String(error));
      });
    scheduleLayout();
    const editor = {
      flush: () => {
        gesture = null;
        clearGuides();
        applyLayout();
        if (!sending && !commands.length) return Promise.resolve();
        return new Promise((resolve, reject) => {
          drains.push({ resolve, reject });
          void sendPending();
        });
      },
      isEditing: editing,
      refresh: scheduleLayout,
      cancel: () => {
        if (editing()) {
          commands.length = 0;
          void api
            .endLayout(state.sessionId, false)
            .then(accept)
            .catch((error) => {
              console.warn("[Overlay] overlay layout cancel failed", String(error));
            });
        }
      },
    };
    if (preview) {
      const arrows = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      // A held key repeats into one undo step.
      const arrowNudge = (key, shift, repeat) => {
        const delta = arrows[key];
        const step = shift ? 10 : 1;
        if (!repeat || !nudgeGroup) nudgeGroup = `nudge-${(operations += 1)}`;
        nudge(delta[0] * step, delta[1] * step, nudgeGroup);
      };
      window.rewardEditorSelection = {
        get field() {
          return state?.selectedField;
        },
        cardFor: (field) => {
          const home = homeCard(field, activeKey());
          return typeof home === "string" ? Number(home) : home;
        },
        select: (field, additive) => {
          if (additive) toggleField(field, state?.selectedCard);
          else selectField(field);
        },
        align,
        nudge: (key, shift, repeat) => {
          if (editing() && !gesture && Object.hasOwn(arrows, key)) arrowNudge(key, shift, repeat);
        },
      };
      window.flushRewardEditor = editor.flush;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && editing()) editor.cancel();
        if (!editing() || event.altKey || event.metaKey || gesture) return;
        if (
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]")
        )
          return;
        if (event.ctrlKey) {
          if (event.key.toLowerCase() !== "z" || event.shiftKey) return;
          event.preventDefault();
          send({ type: "undo" });
          return;
        }
        if (!Object.hasOwn(arrows, event.key)) return;
        event.preventDefault();
        arrowNudge(event.key, event.shiftKey, event.repeat);
      });
    }
    return editor;
  };
})();
