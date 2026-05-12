import { existsSync } from "node:fs";
import path from "node:path";

export function resolveRuntimeResourcePath(...parts: string[]): string {
  const resourcesPath = process.resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, ...parts)] : []),
    path.join(__dirname, "..", "resources", ...parts),
    path.join(__dirname, "..", "..", "resources", ...parts),
    path.join(process.cwd(), "resources", ...parts),
    path.join(__dirname, "..", ...parts),
    path.join(__dirname, "..", "..", ...parts),
    path.join(process.cwd(), ...parts),
  ];

  return candidates.find(existsSync) ?? candidates[0];
}
