import { existsSync } from "node:fs";
import path from "node:path";

function appResourcesPath(): string | null {
  const resourcesPath = process.resourcesPath;
  return resourcesPath ? resourcesPath : null;
}

export function resolveRuntimeResourcePath(...parts: string[]): string {
  const candidates = [
    ...(appResourcesPath() ? [path.join(appResourcesPath()!, ...parts)] : []),
    path.join(__dirname, "..", "resources", ...parts),
    path.join(__dirname, "..", "..", "resources", ...parts),
    path.join(process.cwd(), "resources", ...parts),
    path.join(__dirname, "..", ...parts),
    path.join(__dirname, "..", "..", ...parts),
    path.join(process.cwd(), ...parts),
  ];

  return candidates.find(existsSync) ?? candidates[0];
}
