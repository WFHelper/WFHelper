import path from "node:path";

const ELECTRON_BUILD_DIRNAME = ".electron-build";

function canResolve(modulePath: string): boolean {
  try {
    require.resolve(modulePath);
    return true;
  } catch {
    return false;
  }
}

export function createRuntimeRequire(currentDir: string, levelsUp: number) {
  const rootParts = Array.from({ length: Math.max(0, Math.floor(levelsUp)) }, () => "..");
  const runtimeRoot = path.resolve(currentDir, ...rootParts);
  const isElectronBuildRoot =
    path.basename(runtimeRoot).toLowerCase() === ELECTRON_BUILD_DIRNAME.toLowerCase();

  return function runtimeRequire<T = unknown>(relativePath: string): T {
    const runtimePath = path.join(runtimeRoot, relativePath);
    if (canResolve(runtimePath)) {
      return require(runtimePath) as T;
    }

    if (isElectronBuildRoot) {
      const sourcePath = path.join(runtimeRoot, "..", relativePath);
      if (canResolve(sourcePath)) {
        return require(sourcePath) as T;
      }
    }

    return require(runtimePath) as T;
  };
}
