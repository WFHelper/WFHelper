import { writable } from "svelte/store";

function readBoolFromStorage(key: string): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(key) === "1";
}

export const currentView = writable<string>("welcome");
export const statusText = writable<string>("No inventory loaded");
export const debugMode = writable<boolean>(readBoolFromStorage("wf_debug_mode"));

debugMode.subscribe((value) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("wf_debug_mode", value ? "1" : "0");
  }
});
