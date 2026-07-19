import fs from "node:fs";

// Windows AV/indexers can briefly lock the destination; retry transient rename failures.
const RENAME_RETRY_DELAYS_MS = [15, 45];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Write to a tmp file, fsync, then rename so a crash can't truncate the target. */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd already dead */
      }
    }
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}
