const STEEL_PATH_EPOCH_MS = new Date("2020-11-16T00:00:00.000Z").getTime();
const STEEL_PATH_EIGHT_WEEKS_S = 4838400; // 8 * 7 * 86400
const STEEL_PATH_SEVEN_DAYS_S = 604800; // 7 * 86400

const STEEL_PATH_ROTATION: { name: string; cost: number }[] = [
  { name: "Umbra Forma Blueprint", cost: 150 },
  { name: "50,000 Kuva", cost: 55 },
  { name: "Kitgun Riven Mod", cost: 75 },
  { name: "3x Forma", cost: 75 },
  { name: "Zaw Riven Mod", cost: 75 },
  { name: "30,000 Endo", cost: 150 },
  { name: "Rifle Riven Mod", cost: 75 },
  { name: "Shotgun Riven Mod", cost: 75 },
];

const STEEL_PATH_EVERGREENS: { name: string; cost: number }[] = [
  { name: "Veiled Riven Cipher", cost: 20 },
  { name: "Bishamo Pauldrons Blueprint", cost: 15 },
  { name: "Bishamo Cuirass Blueprint", cost: 25 },
  { name: "Bishamo Helmet Blueprint", cost: 20 },
  { name: "Bishamo Greaves Blueprint", cost: 25 },
  { name: "10k Kuva", cost: 15 },
  { name: "Primary Arcane Adapter", cost: 15 },
  { name: "Secondary Arcane Adapter", cost: 15 },
  { name: "Relic Pack", cost: 15 },
  { name: "Stance Forma Blueprint", cost: 10 },
];

export function computeSteelPathHonors(): {
  currentReward: { name: string; cost: number };
  activation: string;
  expiry: string;
  rotation: { name: string; cost: number }[];
  evergreens: { name: string; cost: number }[];
} {
  const nowMs = Date.now();
  const sSinceStart = (nowMs - STEEL_PATH_EPOCH_MS) / 1000;
  const ind = Math.floor((sSinceStart % STEEL_PATH_EIGHT_WEEKS_S) / STEEL_PATH_SEVEN_DAYS_S);

  const now = new Date(nowMs);
  const dayOfWeek = now.getUTCDay();
  const offset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const activation = new Date(nowMs);
  activation.setUTCDate(activation.getUTCDate() - offset);
  activation.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(activation);
  expiry.setUTCDate(expiry.getUTCDate() + 6);
  expiry.setUTCHours(23, 59, 59, 0);

  return {
    currentReward: STEEL_PATH_ROTATION[ind],
    activation: activation.toISOString(),
    expiry: expiry.toISOString(),
    rotation: STEEL_PATH_ROTATION,
    evergreens: STEEL_PATH_EVERGREENS,
  };
}
