param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
)

$ErrorActionPreference = 'Stop'
$configFile = [IO.Path]::GetFullPath($ConfigPath)
$expectedPath = [IO.Path]::GetFullPath($ExpectedExecutable)
$hash = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($configFile))).Replace('-', '') }
finally { $hash.Dispose() }

function Read-WatcherConfig {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try { return [IO.File]::ReadAllText($configFile) | ConvertFrom-Json }
        catch { if ($attempt -lt 2) { Start-Sleep -Milliseconds 200 } }
    }
    return $null
}

function Test-AppRunning($Config) {
    if ($null -eq $Config.appPid -or $Config.appPid -le 0) { return $false }
    try {
        $candidate = Get-Process -Id $Config.appPid -ErrorAction Stop
        if ($candidate.SessionId -ne $sessionId) { return $false }
        if (-not $candidate.Path) { return $null }
        return [String]::Equals([IO.Path]::GetFullPath($candidate.Path), $expectedPath, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $false }
        return $null
    }
}

function Get-GameState {
    try {
        $unknown = $false
        foreach ($candidate in @(Get-Process -ErrorAction Stop)) {
            if ($candidate.ProcessName -ne 'Warframe.x64') { continue }
            try {
                if ($candidate.SessionId -eq $sessionId) { return $true }
            } catch { $unknown = $true }
        }
        if ($unknown) { return $null }
        return $false
    } catch { return $null }
}
$mutex = New-Object Threading.Mutex($false, "Local\WFHelperWarframeWatcher-$key")
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(20000) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit }
    $initial = Read-WatcherConfig
    if ($null -eq $initial) { exit 1 }
    $revision = $initial.revision
    $sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
    $launchedForSession = $false
    $absentSince = $null
    while ($true) {
        $config = Read-WatcherConfig
        if ($null -eq $config -or $config.enabled -ne $true -or $config.revision -ne $revision) { break }
        if (-not [String]::Equals([IO.Path]::GetFullPath($config.executable), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { break }
        if (-not [IO.File]::Exists($expectedPath) -or $config.exitGraceMs -le 0 -or $config.exitGraceMs -gt 60000) { break }
        $game = Get-GameState
        if ($null -eq $game) {
            $absentSince = $null
        } elseif ($game) {
            $absentSince = $null
            if (-not $launchedForSession) {
                $appRunning = Test-AppRunning $config
                if ($null -eq $appRunning) { Start-Sleep -Seconds 2; continue }
                if (-not $appRunning) {
                    Start-Process -FilePath $expectedPath -ArgumentList $config.arguments | Out-Null
                }
                $launchedForSession = $true
            }
        } else {
            if ($null -eq $absentSince) { $absentSince = [DateTime]::UtcNow }
            if (([DateTime]::UtcNow - $absentSince).TotalMilliseconds -ge $config.exitGraceMs) { $launchedForSession = $false }
        }
        Start-Sleep -Seconds 2
    }
} catch {
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
