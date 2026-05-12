import { writable } from "svelte/store";
import { readStorage } from "../lib/persistence.js";

function getInitialView(): string {
  return readStorage("setup-completed") === "1" ? "inventory" : "setup";
}

export const currentView = writable<string>(getInitialView());
export const statusText = writable<string>("No inventory loaded");
