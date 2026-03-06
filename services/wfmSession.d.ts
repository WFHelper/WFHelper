/** Type declarations for services/wfmSession.js */

export interface SessionSummary {
  loggedIn: boolean;
  userName: string | null;
  platform: string;
}

export interface SignInResult extends SessionSummary {
  loggedIn: true;
}

export interface SignOutResult {
  loggedIn: false;
}

export interface SetStatusResult {
  status: "online" | "ingame" | "invisible";
}

export interface WfmUserProfile {
  id: string;
  ingame_name: string;
  status: string;
  [key: string]: unknown;
}

export function signIn(email: string, password: string): Promise<SignInResult>;
export function signOut(): SignOutResult;
export function restoreSession(): Promise<void>;
export function getSession(): SessionSummary;
export function getInGameName(): string | null;
export function getMe(): Promise<WfmUserProfile | null>;
export function setStatus(status: "online" | "ingame" | "invisible"): Promise<SetStatusResult>;
