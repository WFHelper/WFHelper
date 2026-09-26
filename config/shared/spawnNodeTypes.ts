/** One star-chart node as an enemy spawn location. Display fields follow the game
 *  language; the English twins are what the codex spawn lists are matched on. */
export interface SpawnNode {
  /** Star chart node id, e.g. "SolNode162". */
  nodeId: string;
  node: string;
  nodeEn: string;
  planet: string;
  planetEn: string;
  /** DE star-chart order; a Proxima shares the index of its planet. */
  planetIndex: number;
  /** DE mission enum, e.g. "MT_CAPTURE". */
  missionKey: string;
  mission: string;
  missionEn: string;
  /** Codex faction keys ("infestation"), the node's own faction first. */
  factionKeys: string[];
  minLevel: number;
  maxLevel: number;
  /** Wiki tileset name, e.g. "Infested Ship". */
  tileSet: string;
  darkSector: boolean;
}
