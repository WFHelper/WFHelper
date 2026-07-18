import { app } from "electron";
import * as warframeStatus from "../../services/warframeStatus";

interface ZOrderSubscriber {
  isActive: () => boolean;
  sync: (warframeFocused: boolean) => void;
}

const subscribers = new Set<ZOrderSubscriber>();
let interval: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  const active = [...subscribers].filter((subscriber) => subscriber.isActive());
  if (active.length === 0) return;

  polling = true;
  try {
    const status = await warframeStatus.getStatus();
    for (const subscriber of active) subscriber.sync(status.isFocused);
  } catch {
    // status polling is best effort
  } finally {
    polling = false;
  }
}

function ensureInterval(): void {
  if (interval) return;
  interval = setInterval(() => void poll(), 2000);
}

export function registerZOrderSubscriber(subscriber: ZOrderSubscriber): void {
  subscribers.add(subscriber);
  ensureInterval();
}

app.once("before-quit", () => {
  if (interval) clearInterval(interval);
  interval = null;
  subscribers.clear();
});
