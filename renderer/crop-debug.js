(function () {
  const MIN_HEIGHT = 0.08;

  const state = {
    imageDataUrl: "",
    selectionTop: 0.38,
    selectionHeight: 0.36,
    baseTop: 0.38,
    baseHeight: 0.36,
    dragging: false,
    dragStartY: 0,
  };

  const statusEl = document.getElementById("status");
  const viewerEl = document.getElementById("viewer");
  const imageEl = document.getElementById("frameImage");
  const bandEl = document.getElementById("band");

  const topRatioEl = document.getElementById("topRatio");
  const heightRatioEl = document.getElementById("heightRatio");
  const bottomRatioEl = document.getElementById("bottomRatio");
  const sourceInfoEl = document.getElementById("sourceInfo");

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = "status" + (type ? " " + type : "");
  }

  function updateStats() {
    const top = state.selectionTop;
    const height = state.selectionHeight;
    const bottom = top + height;

    topRatioEl.textContent = top.toFixed(4);
    heightRatioEl.textContent = height.toFixed(4);
    bottomRatioEl.textContent = bottom.toFixed(4);
  }

  function renderBand() {
    bandEl.setAttribute("y", state.selectionTop.toFixed(4));
    bandEl.setAttribute("height", state.selectionHeight.toFixed(4));
    updateStats();
  }

  function setSelectionFromPixels(y1, y2) {
    const rect = viewerEl.getBoundingClientRect();
    if (rect.height <= 0) return;

    const n1 = clamp((y1 - rect.top) / rect.height, 0, 1);
    const n2 = clamp((y2 - rect.top) / rect.height, 0, 1);
    let top = Math.min(n1, n2);
    let bottom = Math.max(n1, n2);

    if (bottom - top < MIN_HEIGHT) {
      bottom = Math.min(1, top + MIN_HEIGHT);
      top = Math.max(0, bottom - MIN_HEIGHT);
    }

    state.selectionTop = top;
    state.selectionHeight = bottom - top;
    renderBand();
  }

  async function applySelection() {
    const payload = {
      cropTopRatio: Number(state.selectionTop.toFixed(4)),
      cropHeightRatio: Number(state.selectionHeight.toFixed(4)),
    };

    try {
      const result = await window.cropDebug.applySelection(payload);
      if (!result || result.ok !== true) {
        setStatus(result?.error || "Failed to apply crop selection.", "err");
        return;
      }

      state.baseTop = payload.cropTopRatio;
      state.baseHeight = payload.cropHeightRatio;
      setStatus("Crop selection applied. Preset switched to custom.", "ok");
    } catch (err) {
      setStatus(`Apply failed: ${err?.message || err}`, "err");
    }
  }

  function resetSelection() {
    state.selectionTop = state.baseTop;
    state.selectionHeight = state.baseHeight;
    renderBand();
    setStatus("Selection reset to current saved crop.", "warn");
  }

  function initFromPayload(payload) {
    if (!payload || typeof payload !== "object") {
      setStatus("No capture payload received.", "err");
      return;
    }

    state.imageDataUrl = String(payload.imageDataUrl || "");
    state.baseTop = clamp(Number(payload.cropTopRatio ?? 0.38), 0, 0.92);
    state.baseHeight = clamp(Number(payload.cropHeightRatio ?? 0.36), MIN_HEIGHT, 0.95);

    if (state.baseTop + state.baseHeight > 1) {
      state.baseHeight = 1 - state.baseTop;
      if (state.baseHeight < MIN_HEIGHT) {
        state.baseHeight = MIN_HEIGHT;
        state.baseTop = 1 - MIN_HEIGHT;
      }
    }

    state.selectionTop = state.baseTop;
    state.selectionHeight = state.baseHeight;

    imageEl.src = state.imageDataUrl;
    if (sourceInfoEl) {
      sourceInfoEl.textContent = String(payload.sourceLabel || "unknown");
    }
    renderBand();
    setStatus("Capture loaded. Drag on image to refine OCR crop.", "ok");
  }

  function onPointerDown(event) {
    state.dragging = true;
    state.dragStartY = event.clientY;
    setSelectionFromPixels(event.clientY, event.clientY);
  }

  function onPointerMove(event) {
    if (!state.dragging) return;
    setSelectionFromPixels(state.dragStartY, event.clientY);
  }

  function onPointerUp(event) {
    if (!state.dragging) return;
    state.dragging = false;
    setSelectionFromPixels(state.dragStartY, event.clientY);
    setStatus("Selection updated. Click Apply to save.", "warn");
  }

  function bindEvents() {
    document.getElementById("closeBtn").addEventListener("click", () => window.cropDebug.close());
    document.getElementById("resetBtn").addEventListener("click", resetSelection);
    document.getElementById("applyBtn").addEventListener("click", applySelection);

    viewerEl.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        window.cropDebug.close();
      } else if (event.key === "Enter") {
        void applySelection();
      }
    });

    window.addEventListener("resize", renderBand);

    window.cropDebug.onInit(initFromPayload);
    window.cropDebug.onApplied((payload) => {
      if (!payload || typeof payload !== "object") return;
      state.baseTop = clamp(Number(payload.cropTopRatio ?? state.baseTop), 0, 0.92);
      state.baseHeight = clamp(
        Number(payload.cropHeightRatio ?? state.baseHeight),
        MIN_HEIGHT,
        0.95,
      );
      state.selectionTop = state.baseTop;
      state.selectionHeight = state.baseHeight;
      renderBand();
      setStatus("Saved crop reloaded.", "ok");
    });
  }

  bindEvents();
})();
