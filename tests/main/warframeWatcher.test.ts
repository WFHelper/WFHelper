import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const windowsTest = process.platform === "win32" ? it : it.skip;
const watcher = path.resolve("scripts/warframe-watcher.ps1");

const APP_PID_SCENES = new Set(["alive-app", "unreadable-app", "reused-pid"]);

function runWatcher(scene: string): {
  status: number | null;
  launches: { file: string; style: string }[];
  queries: number;
  timeout: number | null;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-watcher-test-"));
  try {
    const executable = path.join(dir, "fixture.exe");
    const configPath = path.join(dir, "watcher.json");
    const resultPath = path.join(dir, "result.json");
    const fixturePath = path.join(dir, "fixture.json");
    const runner = path.join(dir, "run.ps1");
    const config = {
      enabled: true,
      revision: "fixture",
      executable,
      arguments: ["--warframe-auto-launch"],
      appPid: APP_PID_SCENES.has(scene) ? 1234 : 0,
      exitGraceMs: scene === "second-game" ? 5 : 10_000,
    };
    fs.writeFileSync(executable, "Never executed: Start-Process is a fixture function.");
    fs.writeFileSync(configPath, scene.includes("invalid") ? "{" : JSON.stringify(config));
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({ scene, config, configPath, resultPath, watcher, executable }),
    );
    fs.writeFileSync(
      runner,
      String.raw`
$fixture = Get-Content -LiteralPath $env:WFH_WATCHER_FIXTURE -Raw | ConvertFrom-Json
$script:steps = 0
$script:queries = 0
$script:timeout = $null
$script:launches = @()
function Get-Process {
    [CmdletBinding()] param([int]$Id)
    if ($Id -eq $PID) { return [pscustomobject]@{ SessionId = 1 } }
    if ($Id -eq 1234) {
        if ($fixture.scene -eq 'unreadable-app') { throw 'unreadable fixture process' }
        $file = if ($fixture.scene -eq 'reused-pid') { 'C:\unrelated.exe' } else { $fixture.executable }
        return [pscustomobject]@{ SessionId = 1; Path = $file }
    }
    if ($fixture.scene -eq 'second-game' -and $script:steps -ge 1 -and $script:steps -le 2) { return @() }
    $session = if ($fixture.scene -eq 'other-session') { 2 } else { 1 }
    $gameId = 600
    $started = [datetime]::new(2026, 9, 24, 12, 0, 0)
    if ($fixture.scene -in 'applet-only', 'applet-exited' -or ($fixture.scene -in 'applet-then-game', 'reused-applet-pid' -and $script:steps -lt 2)) {
        $gameId = 500
    } elseif ($fixture.scene -eq 'reused-applet-pid') {
        $gameId = 500
        $started = $started.AddSeconds(4)
    }
    return [pscustomobject]@{ ProcessName = 'Warframe.x64'; SessionId = $session; Id = $gameId; StartTime = $started }
}
function Get-CimInstance {
    param([Parameter(Position = 0)]$ClassName, $Filter, $Property, $OperationTimeoutSec)
    $script:queries++
    $script:timeout = $OperationTimeoutSec
    if ($fixture.scene -eq 'failed-command-line-query') { throw 'WMI unavailable' }
    if ($fixture.scene -eq 'timed-out-command-line-query') {
        Write-Error 'The WS-Management service cannot complete the operation within the time specified in OperationTimeout.'
    }
    if ($fixture.scene -eq 'applet-exited') { return @() }
    if ($fixture.scene -eq 'unreadable-command-line') { return [pscustomobject]@{ CommandLine = $null } }
    $applet = $Filter -eq 'ProcessId=500' -and ($fixture.scene -ne 'reused-applet-pid' -or $script:steps -lt 2)
    $line = if ($applet) {
        '"C:\Warframe\Warframe.x64.exe" -silent -log:/Preprocess.log -graphicsDriver:dx12 -cluster:public -language:en -applet:/EE/Types/Framework/ContentUpdate'
    } else {
        '"C:\Warframe\Warframe.x64.exe" -windowMode:2 -graphicsDriver:dx12 -cluster:public -language:en -clienttype:Steam'
    }
    return [pscustomobject]@{ CommandLine = $line }
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle)
    $script:launches += @{ file = $FilePath; style = $WindowStyle }
}
function Start-Sleep {
    param([int]$Seconds, [int]$Milliseconds)
    if ($Milliseconds -gt 0) {
        if ($fixture.scene -eq 'transient-invalid') {
            [IO.File]::WriteAllText($fixture.configPath, ($fixture.config | ConvertTo-Json))
        }
        return
    }
    $script:steps++
    if ($fixture.scene -eq 'second-game') { [Threading.Thread]::Sleep(10) }
    if ($script:steps -ge 4) {
        $fixture.config.enabled = $false
        [IO.File]::WriteAllText($fixture.configPath, ($fixture.config | ConvertTo-Json))
    }
}
if ($fixture.scene -eq 'changed-executable') {
    $fixture.config.executable = 'C:\unexpected.exe'
    [IO.File]::WriteAllText($fixture.configPath, ($fixture.config | ConvertTo-Json))
}
. $fixture.watcher -ConfigPath $fixture.configPath -ExpectedExecutable $fixture.executable
if ($LASTEXITCODE -eq 1) { exit 1 }
[IO.File]::WriteAllText($fixture.resultPath, (ConvertTo-Json -InputObject @{ launches = @($script:launches); queries = $script:queries; timeout = $script:timeout } -Compress))
`,
    );
    const child = spawnSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner],
      {
        windowsHide: true,
        timeout: 15_000,
        encoding: "utf8",
        env: { ...process.env, WFH_WATCHER_FIXTURE: fixturePath },
      },
    );
    if (child.error) throw child.error;
    if (child.stderr) throw new Error(child.stderr);
    const result = fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
          launches: { file: string; style: string }[];
          queries: number;
          timeout: number | null;
        })
      : { launches: [], queries: 0, timeout: null };
    return { status: child.status, ...result };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("packaged PowerShell watcher behavior", () => {
  windowsTest.each([
    "alive-app",
    "unreadable-app",
    "applet-only",
    "applet-exited",
    "other-session",
    "changed-executable",
  ])("does not launch for %s", (scene) => {
    const result = runWatcher(scene);
    expect(result.status).toBe(0);
    expect(result.launches).toEqual([]);
  });

  windowsTest.each([
    "absent-app",
    "reused-pid",
    "applet-then-game",
    "reused-applet-pid",
    "unreadable-command-line",
    "failed-command-line-query",
    "timed-out-command-line-query",
  ])("launches once for %s with a normal, visible window", (scene) => {
    const result = runWatcher(scene);
    expect(result.status).toBe(0);
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]).toMatchObject({
      file: expect.stringContaining("fixture.exe"),
    });
    // Hidden here reached the app's first ShowWindow, so its window never appeared.
    expect(result.launches[0]?.style ?? null).toBeNull();
  });

  windowsTest(
    "recovers a transient invalid config but terminates on persistent invalid JSON",
    () => {
      expect(runWatcher("transient-invalid").status).toBe(0);
      expect(runWatcher("persistent-invalid").status).toBe(1);
    },
  );

  windowsTest("reads each Warframe process command line once", () => {
    expect(runWatcher("applet-only").queries).toBe(1);
    expect(runWatcher("applet-then-game").queries).toBe(2);
    expect(runWatcher("reused-applet-pid").queries).toBe(2);
    expect(runWatcher("other-session").queries).toBe(0);
  });

  windowsTest("bounds the command line query so a hung WMI ends as the game", () => {
    const result = runWatcher("timed-out-command-line-query");
    expect(result.launches).toHaveLength(1);
    expect(result.timeout).toBeGreaterThan(0);
    expect(result.timeout).toBeLessThanOrEqual(10);
  });

  windowsTest("rearms only after the configured absence grace", () => {
    const result = runWatcher("second-game");
    expect(result.status).toBe(0);
    expect(result.launches).toHaveLength(2);
  });
});
