(function () {
  window.installOverlayRightButtonDrag = function installOverlayRightButtonDrag(options) {
    let dragging = false;
    let lastScreenX = 0;
    let lastScreenY = 0;

    function isInteractive() {
      return !!options.isInteractive();
    }

    function stopDragging() {
      dragging = false;
      document.documentElement.classList.remove("is-overlay-dragging");
    }

    document.addEventListener("contextmenu", (event) => {
      if (isInteractive()) event.preventDefault();
    });

    document.addEventListener("mousedown", (event) => {
      if (!isInteractive() || event.button !== 2) return;
      event.preventDefault();
      dragging = true;
      lastScreenX = event.screenX;
      lastScreenY = event.screenY;
      document.documentElement.classList.add("is-overlay-dragging");
    });

    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      if (!isInteractive() || (event.buttons & 2) === 0) {
        stopDragging();
        return;
      }

      const dx = event.screenX - lastScreenX;
      const dy = event.screenY - lastScreenY;
      lastScreenX = event.screenX;
      lastScreenY = event.screenY;
      if (dx !== 0 || dy !== 0) {
        options.moveBy(dx, dy);
      }
    });

    document.addEventListener("mouseup", (event) => {
      if (event.button === 2) stopDragging();
    });

    window.addEventListener("blur", stopDragging);
  };
})();
