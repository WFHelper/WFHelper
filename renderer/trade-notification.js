/* Trade Notification Overlay - renderer logic */
(function () {
  "use strict";

  const WFM_ASSET_BASE = "https://warframe.market/static/assets/";
  // Fallback values used only if the main process sends a legacy payload
  // without a `timing` field. The real values come from the payload.
  const FALLBACK_VISIBLE_MS = 5000;
  const FALLBACK_FADE_MS = 400;

  const notification = document.getElementById("notification");
  const itemThumb = document.getElementById("item-thumb");
  const tradeBadge = document.getElementById("trade-badge");
  const itemName = document.getElementById("item-name");
  const platAmount = document.getElementById("plat-amount");
  const partnerName = document.getElementById("partner-name");

  let dismissTimer = null;

  function showNotification(payload) {
    if (!payload) return;
    // Accept both the new { match, timing } shape and the legacy bare match.
    const match = payload.match || payload;
    const timing = payload.timing || {};
    const visibleMs = typeof timing.visibleMs === "number" ? timing.visibleMs : FALLBACK_VISIBLE_MS;
    const fadeMs = typeof timing.fadeMs === "number" ? timing.fadeMs : FALLBACK_FADE_MS;
    if (!match) return;

    // Set thumbnail
    if (match.itemThumb) {
      const src = match.itemThumb.startsWith("http")
        ? match.itemThumb
        : WFM_ASSET_BASE + match.itemThumb;
      itemThumb.src = src;
      itemThumb.style.display = "block";
    } else {
      itemThumb.src = "";
      itemThumb.style.display = "none";
    }

    // Badge
    const isSale = match.type === "sale";
    tradeBadge.textContent = isSale ? "Sale" : "Purchase";
    tradeBadge.className = isSale ? "sale" : "purchase";

    // Item name + quantity
    const qty = match.quantity > 1 ? match.quantity + "× " : "";
    itemName.textContent = qty + (match.itemName || "Unknown Item");

    // Plat
    const sign = isSale ? "+" : "−";
    platAmount.textContent = sign + match.platinum + "p";
    platAmount.className = isSale ? "positive" : "negative";

    // Partner
    partnerName.textContent = match.partner || "";

    // Show with animation
    notification.classList.remove("hidden", "fade-out");

    // Reset auto-dismiss timer
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(function () {
      notification.classList.add("fade-out");
      setTimeout(function () {
        notification.classList.add("hidden");
        // Notify main process we're done
        if (window.tradeNotificationApi && window.tradeNotificationApi.dismiss) {
          window.tradeNotificationApi.dismiss();
        }
      }, fadeMs);
    }, visibleMs);
  }

  // Listen for IPC events from main
  if (window.tradeNotificationApi) {
    window.tradeNotificationApi.onShow(function (payload) {
      showNotification(payload);
    });
  }
})();
