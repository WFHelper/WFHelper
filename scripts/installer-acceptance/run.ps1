param([switch]$InWindowsSandbox)
$ErrorActionPreference = "Stop"

if (-not $InWindowsSandbox -or $env:USERNAME -ne "WDAGUtilityAccount" -or
    $env:USERPROFILE -ne "C:\Users\WDAGUtilityAccount" -or
    $PSScriptRoot -ne "C:\WFHelperInputs") {
  throw "Refusing installation outside the generated Windows Sandbox session. Open WFHelper-upgrade.wsb."
}

$work = "C:\WFHelperAcceptance"
$results = "C:\WFHelperResults"
$install = Join-Path $work "App"
$profile = Join-Path $env:APPDATA "WFHelper"
if (Test-Path -LiteralPath $work) { throw "Acceptance requires a fresh Windows Sandbox session" }
New-Item -ItemType Directory -Path $work, $profile -Force | Out-Null
Start-Transcript -Path (Join-Path $results "acceptance.log") -Force | Out-Null
$runningApp = $null
$passed = $false
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Json($path, $value) {
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 12), $utf8)
}

function Stop-AcceptanceApp {
  if ($null -eq $script:runningApp) { return }
  $script:runningApp.Refresh()
  if (-not $script:runningApp.HasExited -and
      (-not $script:runningApp.CloseMainWindow() -or -not $script:runningApp.WaitForExit(15000))) {
    & taskkill.exe /PID $script:runningApp.Id /T /F | Out-Null
    throw "Installed app did not exit cleanly; its owned process tree was stopped"
  }
  $script:runningApp.Refresh()
  if ($script:runningApp.ExitCode -ne 0) {
    throw "Installed app exited with code $($script:runningApp.ExitCode)"
  }
}

try {
  Write-Json (Join-Path $results "result.json") @{ passed = $false; status = "running"; startedAt = (Get-Date).ToUniversalTime().ToString("o") }
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "manifest.json") | ConvertFrom-Json
  [IO.File]::WriteAllText((Join-Path $profile "setup-preferences.json"), '{"autoInstallHelper":false}', $utf8)
  [IO.File]::WriteAllText((Join-Path $work "EE.log"), "0.000 Sys [Info]: Main Startup.`n", $utf8)
  $env:WFHELPER_USER_DATA = $profile
  $env:WFHELPER_EE_LOG = Join-Path $work "EE.log"
  $env:WFHELPER_DISABLE_KEYBOARD_HOOK = "1"
  $env:WFHELPER_DISABLE_DBWIN = "1"
  $env:WF_DISABLE_AUTO_UPDATE = "1"
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

  foreach ($phase in @("previous", "current")) {
    $entry = $manifest.$phase
    $installer = Join-Path $PSScriptRoot "$phase.exe"
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $entry.sha256) {
      throw "$phase installer checksum mismatch"
    }
    $setup = Start-Process -FilePath $installer -ArgumentList @("/S", "/currentuser", "/D=$install") -WindowStyle Hidden -PassThru
    if (-not $setup.WaitForExit(180000)) {
      & taskkill.exe /PID $setup.Id /T /F | Out-Null
      throw "$phase installer timed out"
    }
    $setup.Refresh()
    if ($setup.ExitCode -ne 0) { throw "$phase installer failed with exit $($setup.ExitCode)" }
    $executable = Join-Path $install "WFHelper.exe"
    $version = (Get-Item -LiteralPath $executable).VersionInfo.FileVersion
    if ($version -ne $entry.version) { throw "$phase installed version '$version', expected '$($entry.version)'" }
    $preferences = Get-Content -Raw -LiteralPath (Join-Path $profile "setup-preferences.json") | ConvertFrom-Json
    if ($preferences.autoInstallHelper -ne $false) { throw "$phase installer replaced existing helper preference" }

    $runningApp = Start-Process -FilePath $executable -ArgumentList @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223", "--no-sandbox") -PassThru -WindowStyle Hidden
    & (Join-Path $PSScriptRoot "node.exe") (Join-Path $PSScriptRoot "verify.mjs") $phase $results
    if ($LASTEXITCODE -ne 0) { throw "$phase application acceptance failed" }
    if ($runningApp.HasExited) { throw "$phase installed app exited during acceptance" }
    Stop-AcceptanceApp
    $runningApp = $null
    Copy-Item -LiteralPath (Join-Path $profile "overlay-settings.json") -Destination (Join-Path $results "$phase-settings.json")
    Copy-Item -LiteralPath (Join-Path $profile "trade-log.json") -Destination (Join-Path $results "$phase-trades.json")
  }
  $passed = $true
} catch {
  Write-Json (Join-Path $results "failure.json") @{ error = $_.ToString(); stack = $_.ScriptStackTrace }
  Write-Warning $_.ToString()
} finally {
  try { Stop-AcceptanceApp } catch { $passed = $false; Write-Warning $_.ToString() }
  foreach ($folder in @("logs", "Crashpad", "Crashes")) {
    $source = Join-Path $profile $folder
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $results -Recurse -Force }
  }
  Write-Json (Join-Path $results "result.json") @{ passed = $passed; status = "completed"; installers = $manifest; evidence = "Windows Sandbox installer and application acceptance"; completedAt = (Get-Date).ToUniversalTime().ToString("o") }
  Stop-Transcript | Out-Null
}
if (-not $passed) { exit 1 }
