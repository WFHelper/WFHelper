const SLOTS = 4;

const slotState = Array.from({ length: SLOTS }, () => ({ item: null, price: null }));

function rarityClass(rarity) {
  const low = String(rarity || "").toLowerCase();
  if (low === "rare") return "r-rare";
  if (low === "uncommon") return "r-uncommon";
  return "r-common";
}

async function fetchPrice(urlName) {
  if (!urlName) return null;

  try {
    const raw = await window.overlay.getPrice(urlName);
    const median = Math.round(Math.abs(Number(raw)));
    if (Number.isFinite(median) && median > 0) {
      return median;
    }
  } catch {
    // ignore IPC/network failure and show N/A in UI
  }

  return null;
}

function slotElement(index) {
  return document.querySelector(`.reward-slot[data-slot="${index}"]`);
}

function renderSlot(index) {
  const slotEl = slotElement(index);
  const nameEl = slotEl.querySelector(".slot-name");
  const priceEl = slotEl.querySelector(".slot-price");
  const rarityEl = slotEl.querySelector(".slot-rarity");
  const { item, price } = slotState[index];

  slotEl.classList.remove("has-item", "best-slot", "empty-slot");

  if (!item) {
    slotEl.classList.add("empty-slot");
    nameEl.textContent = "-";
    nameEl.className = "slot-name empty";
    priceEl.textContent = "-";
    priceEl.className = "slot-price muted";
    rarityEl.textContent = "";
    rarityEl.className = "slot-rarity";
    return;
  }

  slotEl.classList.add("has-item");
  nameEl.textContent = item.name;
  nameEl.className = "slot-name";
  rarityEl.textContent = String(item.rarity || "C")
    .charAt(0)
    .toUpperCase();
  rarityEl.className = `slot-rarity ${rarityClass(item.rarity)}`;

  if (price == null) {
    priceEl.textContent = "...";
    priceEl.className = "slot-price muted";
  } else if (price <= 0) {
    priceEl.textContent = "N/A";
    priceEl.className = "slot-price muted";
  } else {
    priceEl.textContent = `${price}p`;
    priceEl.className = "slot-price";
  }
}

function updateBestPick() {
  let bestIndex = -1;
  let bestPrice = -1;

  for (let i = 0; i < SLOTS; i += 1) {
    slotElement(i).classList.remove("best-slot");
    if (slotState[i].item && slotState[i].price != null && slotState[i].price > bestPrice) {
      bestPrice = slotState[i].price;
      bestIndex = i;
    }
  }

  const bestEl = document.getElementById("best-value");
  if (bestIndex >= 0) {
    slotElement(bestIndex).classList.add("best-slot");
    bestEl.textContent = `${slotState[bestIndex].item.name} - ${bestPrice}p`;
  } else {
    bestEl.textContent = "No priced rewards yet";
  }
}

function resetSlots() {
  for (let i = 0; i < SLOTS; i += 1) {
    slotState[i] = { item: null, price: null };
    renderSlot(i);
  }
  updateBestPick();
}

function showScanning() {
  document.getElementById("scanning-state").classList.add("visible");
  document.getElementById("slots-grid").style.display = "none";
  document.getElementById("error-banner").classList.remove("visible");
  resetSlots();
  document.getElementById("header-sub").textContent = "Detecting...";
  document.getElementById("best-value").textContent = "Detecting...";
}

function showDetectionError() {
  document.getElementById("scanning-state").classList.remove("visible");
  document.getElementById("slots-grid").style.display = "";
  document.getElementById("error-banner").classList.add("visible");
  resetSlots();
  document.getElementById("header-sub").textContent = "Detection failed";
  document.getElementById("best-value").textContent = "OCR failed";
}

async function applyItems(items) {
  const detectedItems = Array.isArray(items) ? items.filter(Boolean).slice(0, SLOTS) : [];

  if (detectedItems.length === 0) {
    showDetectionError();
    return;
  }

  document.getElementById("scanning-state").classList.remove("visible");
  document.getElementById("slots-grid").style.display = "";
  document.getElementById("error-banner").classList.remove("visible");
  document.getElementById("header-sub").textContent = `${detectedItems.length} item(s) found`;

  for (let i = 0; i < SLOTS; i += 1) {
    const item = detectedItems[i] || null;
    slotState[i].item = item;
    slotState[i].price = null;
    renderSlot(i);
  }

  updateBestPick();

  await Promise.all(
    detectedItems.map(async (item, index) => {
      if (!item?.urlName) {
        slotState[index].price = 0;
        renderSlot(index);
        updateBestPick();
        return;
      }

      const price = await fetchPrice(item.urlName);
      slotState[index].price = price ?? 0;
      renderSlot(index);
      updateBestPick();
    }),
  );
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-close").addEventListener("click", () => window.overlay.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.overlay.close();
    }
  });

  window.overlay.onTrigger(showScanning);
  window.overlay.onItems((items) => {
    void applyItems(items);
  });
});
