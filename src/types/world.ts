export interface CycleData {
  activation?: string;
  expiry?: string;
  timeLeft?: string;
  isDay?: boolean;
  isWarm?: boolean;
  active?: string;
  [key: string]: unknown;
}

export interface Fissure {
  expired?: boolean;
  expiry?: string;
  tier?: string;
  isHard?: boolean;
  missionType?: string;
  node?: string;
  [key: string]: unknown;
}

export interface VaultTraderInventoryItem {
  uniqueName?: string;
  item?: string;
  [key: string]: unknown;
}

export interface VaultTrader {
  activation?: string;
  expiry?: string;
  location?: string;
  inventory?: VaultTraderInventoryItem[];
  [key: string]: unknown;
}

export interface DuviriChoiceSet {
  category: string;
  choices: string[];
  [key: string]: unknown;
}

export interface DuviriCycle {
  state?: string;
  expiry?: string;
  choices?: DuviriChoiceSet[];
  [key: string]: unknown;
}

export interface WorldState {
  vaultTrader?: VaultTrader | null;
  voidTrader?: VaultTrader | null;
  earthCycle?: CycleData;
  cetusCycle?: CycleData;
  vallisCycle?: CycleData;
  cambionCycle?: CycleData;
  duviriCycle?: DuviriCycle;
  sortie?: { expiry?: string; [key: string]: unknown };
  steelPath?: { expiry?: string; [key: string]: unknown };
  fissures?: Fissure[];
  [key: string]: unknown;
}
