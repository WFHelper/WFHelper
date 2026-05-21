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
  ducats?: number;
  credits?: number;
  [key: string]: unknown;
}

export interface VaultTrader {
  activation?: string;
  expiry?: string;
  location?: string;
  inventory?: VaultTraderInventoryItem[];
  [key: string]: unknown;
}

interface DuviriChoiceSet {
  category: string;
  choices: string[];
  [key: string]: unknown;
}

interface DuviriCycle {
  state?: string;
  expiry?: string;
  choices?: DuviriChoiceSet[];
  [key: string]: unknown;
}

interface InvasionReward {
  items: string[];
  countedItems: { count: number; type: string }[];
  credits: number;
}

export interface Invasion {
  id: string;
  node: string;
  desc?: string;
  attacker: { reward?: InvasionReward; faction: string };
  defender: { reward?: InvasionReward; faction: string };
  vsInfestation: boolean;
  completion: number;
  completed: boolean;
}

interface BountyJob {
  type: string;
  enemyLevels: [number, number];
  standingStages: number[];
  minMR?: number;
  challengeDesc?: string;
}

export interface SyndicateBounty {
  syndicate: string;
  syndicateKey: string;
  expiry?: string;
  jobs: BountyJob[];
}

interface SteelPathReward {
  name: string;
  cost: number;
}

export interface SteelPathHonors {
  currentReward: SteelPathReward;
  activation?: string;
  expiry?: string;
  rotation: SteelPathReward[];
  upcoming?: Array<SteelPathReward & {
    activation: string;
    expiry: string;
    weekOffset: number;
  }>;
  evergreens: SteelPathReward[];
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
  steelPath?: SteelPathHonors | null;
  fissures?: Fissure[];
  invasions?: Invasion[];
  bounties?: SyndicateBounty[];
  bountyRotation?: string;
  [key: string]: unknown;
}
