import { writable } from "svelte/store";

function readBoolFromStorage(key: string): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(key) === "1";
}

function getInitialView(): string {
  if (typeof localStorage === "undefined") return "welcome";
  return localStorage.getItem("setup-completed") === "1" ? "inventory" : "welcome";
}

export const currentView = writable<string>(getInitialView());
export const statusText = writable<string>("No inventory loaded");
export const debugMode = writable<boolean>(readBoolFromStorage("wf_debug_mode"));

debugMode.subscribe((value) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("wf_debug_mode", value ? "1" : "0");
  }
});
