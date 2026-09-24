import { vi } from "vitest";

export interface FakeRegion {
  base: bigint;
  contents: Buffer;
  type?: number;
  protect?: number;
  /** The read reports failure but still hands over its bytes, like a partial copy. */
  failed?: boolean;
  reportedBytes?: bigint;
}

interface FakeProcess {
  pid: number;
  imagePath?: string;
  regions: FakeRegion[];
}

const running: { pid: number; imagePath: string }[] = [];

/** Stands in for services/win32Process with the processes of the latest fake. */
export const win32ProcessMock = {
  enumProcessIds: () => running.map((process) => process.pid),
  exePathOfPid: (pid: number) => running.find((process) => process.pid === pid)?.imagePath ?? null,
  isWarframeExePath: (exePath: string | null) =>
    typeof exePath === "string" && exePath.toLowerCase().endsWith("\\warframe.x64.exe"),
};

export function nativeFn(implementation: (...args: unknown[]) => unknown) {
  return Object.assign(vi.fn(implementation), { async: vi.fn() });
}

/** Like the real calls: queries round down to a page and report gaps as free, reads cross regions. */
export function createWin32Fake(processes: FakeProcess[]) {
  running.splice(
    0,
    running.length,
    ...processes.map((process) => ({
      pid: process.pid,
      imagePath: process.imagePath ?? "C:\\Games\\Warframe.x64.exe",
    })),
  );
  const byPid = new Map(processes.map((process) => [process.pid, process.regions]));
  const regionsOf = (handle: unknown) => byPid.get(handle as number) ?? [];
  const endOf = (region: FakeRegion) => region.base + BigInt(region.contents.length);
  const regionAt = (regions: FakeRegion[], address: bigint) =>
    regions.find((region) => address >= region.base && address < endOf(region));

  const readMemory = nativeFn(() => 0);
  readMemory.async.mockImplementation((...args: unknown[]) => {
    const regions = regionsOf(args[0]);
    const address = args[1] as bigint;
    const out = args[2] as Buffer;
    const len = args[3] as number;
    const bytesRead = args[4] as Buffer;
    const callback = args[5] as (error: Error | null, ok: number) => void;
    const first = regionAt(regions, address);
    let copied = 0;
    for (let region = first; region && copied < len; ) {
      const from = Number(address + BigInt(copied) - region.base);
      const n = region.contents.copy(out, copied, from, from + len - copied);
      if (n === 0) break;
      copied += n;
      region = regionAt(regions, address + BigInt(copied));
    }
    bytesRead.writeBigUInt64LE(first?.reportedBytes ?? BigInt(copied), 0);
    if (first?.failed) callback(new Error("partial copy"), 0);
    else callback(null, copied === len ? 1 : 0);
  });

  return {
    api: {
      OpenProcess: nativeFn((_access: unknown, _inherit: unknown, pid: unknown) =>
        byPid.has(pid as number) ? pid : 0,
      ),
      CloseHandle: nativeFn(() => 1),
      GetLastError: nativeFn(() => 0),
      VirtualQueryEx: nativeFn((handle: unknown, address: unknown, output: unknown) => {
        const regions = regionsOf(handle);
        const at = address as bigint;
        const page = at - (at % 4096n);
        const mbi = output as Buffer;
        mbi.fill(0);
        const region = regionAt(regions, at);
        if (region) {
          const base = page > region.base ? page : region.base;
          mbi.writeBigUInt64LE(base, 0);
          mbi.writeBigUInt64LE(endOf(region) - base, 24);
          mbi.writeUInt32LE(0x1000, 32);
          mbi.writeUInt32LE(region.protect ?? 0x04, 36);
          mbi.writeUInt32LE(region.type ?? 0, 40);
          return 48;
        }
        const next = regions.find((candidate) => candidate.base > at);
        if (!next) return 0;
        mbi.writeBigUInt64LE(page, 0);
        mbi.writeBigUInt64LE(next.base - page, 24);
        mbi.writeUInt32LE(0x10000, 32);
        mbi.writeUInt32LE(0x01, 36);
        return 48;
      }),
      ReadProcessMemory: readMemory,
    },
  };
}
