# Prewarm ranked order summaries in the backend worker.
#
# Default mode walks the global ranked-summary catalog built from the WFM item catalog.
# Optional hotset mode uploads the local ranked-hotset.json and prewarms only those entries.
#
# Usage examples:
#   .\scripts\prewarm-order-summaries.ps1 -ApiKey "your-admin-api-key"
#   .\scripts\prewarm-order-summaries.ps1 -ApiKey "your-admin-api-key" -Source hotset
#   .\scripts\prewarm-order-summaries.ps1 -ApiKey "your-admin-api-key" -Source hotset -HotsetFile "$env:APPDATA\warframe-companion\ranked-hotset.json"
#   .\scripts\prewarm-order-summaries.ps1 -ApiKey "your-admin-api-key" -Source catalog -RefreshCatalog

param(
    [Parameter(Mandatory=$true)]
    [string]$ApiKey,

    [string]$WorkerUrl = "https://worker.wfcompanion-cache.workers.dev",
    [ValidateSet("catalog", "hotset")]
    [string]$Source = "catalog",
    [string]$HotsetFile = "",
    [int]$BatchSize = 24,
    [int]$PauseSec = 5,
    [switch]$ReplaceHotset,
    [switch]$SkipSeed,
    [switch]$RefreshCatalog,
    [switch]$DryRun
)

function Get-HotsetCandidates {
    return @(
        $HotsetFile,
        (Join-Path $env:APPDATA "warframe-companion\ranked-hotset.json"),
        (Join-Path $env:APPDATA "Warframe Companion\ranked-hotset.json"),
        (Join-Path $env:LOCALAPPDATA "warframe-companion\ranked-hotset.json"),
        (Join-Path $env:LOCALAPPDATA "Warframe Companion\ranked-hotset.json")
    ) | Where-Object { $_ -and $_.Trim().Length -gt 0 } | Select-Object -Unique
}

function Resolve-HotsetFile {
    foreach ($candidate in Get-HotsetCandidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    return $null
}

function Read-HotsetEntries([string]$Path) {
    $raw = Get-Content -Path $Path -Raw -Encoding UTF8
    $json = $raw | ConvertFrom-Json
    if (-not $json -or -not $json.entries) {
        throw "Hotset file does not contain an entries array: $Path"
    }

    $entries = @()
    foreach ($entry in $json.entries) {
        if (-not $entry.slug -or -not $entry.maxRank) {
            continue
        }

        $entries += @{
            slug = [string]$entry.slug
            maxRank = [int]$entry.maxRank
            lastSeenAt = if ($entry.lastSeenAt) { [long]$entry.lastSeenAt } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        }
    }

    return $entries
}

function Invoke-WorkerJson([string]$Uri, [string]$Method, [object]$Body = $null) {
    $headers = @{
        "Authorization" = "Bearer $ApiKey"
        "Content-Type"  = "application/json"
    }

    if ($DryRun) {
        Write-Host "[DryRun] $Method $Uri" -ForegroundColor Yellow
        if ($Body -ne $null) {
            Write-Host ($Body | ConvertTo-Json -Depth 8)
        }
        return $null
    }

    if ($Body -ne $null) {
        $payload = $Body | ConvertTo-Json -Depth 8
        return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -Body $payload -ErrorAction Stop
    }

    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers -ErrorAction Stop
}

$resolvedWorkerUrl = $WorkerUrl.TrimEnd('/')
$startTime = Get-Date

Write-Host "=== Ranked Summary Prewarm ===" -ForegroundColor Cyan
Write-Host "Worker:    $resolvedWorkerUrl"
Write-Host "Source:    $Source"
Write-Host "Batch:     $BatchSize entries per call"
Write-Host "Pause:     ${PauseSec}s between calls"
if ($Source -eq "catalog") {
    Write-Host "Catalog:   $(if ($RefreshCatalog) { 'refresh before run' } else { 'use cached catalog if fresh' })"
} else {
    Write-Host "Seed:      $(if ($SkipSeed) { 'skip' } else { 'upload local hotset' })"
}
Write-Host ""

if ($Source -eq "hotset" -and -not $SkipSeed) {
    $resolvedHotsetFile = Resolve-HotsetFile
    if (-not $resolvedHotsetFile) {
        throw "Could not find ranked-hotset.json. Pass -HotsetFile explicitly, use -SkipSeed, or use -Source catalog."
    }

    $entries = Read-HotsetEntries $resolvedHotsetFile
    if ($entries.Count -eq 0) {
        throw "Hotset file has no valid entries: $resolvedHotsetFile"
    }

    Write-Host "Uploading $($entries.Count) ranked hotset entries from: $resolvedHotsetFile" -ForegroundColor Yellow
    $seedBody = @{
        replace = [bool]$ReplaceHotset
        entries = $entries
    }
    $seedResponse = Invoke-WorkerJson "$resolvedWorkerUrl/admin/order-summary-hotset" "POST" $seedBody
    if ($seedResponse) {
        Write-Host "Hotset stored in worker: $([int]$seedResponse.result.total) entries" -ForegroundColor Green
    }
    Write-Host ""
}

$firstBody = @{
    source = $Source
    batchSize = $BatchSize
    resetCursor = $true
}
if ($Source -eq "catalog" -and $RefreshCatalog) {
    $firstBody.refreshCatalog = $true
}

Write-Host "Resetting $Source order summary prewarm cursor..." -ForegroundColor Yellow
$firstResponse = Invoke-WorkerJson "$resolvedWorkerUrl/admin/prewarm/order-summaries" "POST" $firstBody

if (-not $firstResponse) {
    Write-Host "[DryRun] Finished without sending requests." -ForegroundColor Yellow
    exit 0
}

$result = $firstResponse.result
$totalEntries = [int]$result.totalEntries

if ($totalEntries -le 0) {
    Write-Host "No $Source entries available to prewarm." -ForegroundColor Yellow
    exit 0
}

$totalCalls = [math]::Ceiling($totalEntries / [math]::Max($BatchSize, 1))
$iteration = 1
$totalProcessed = [int]$result.processed
$totalUpdated = [int]$result.updated
$totalFailures = [int]$result.failures

Write-Host "$($Source.Substring(0,1).ToUpper() + $Source.Substring(1)) entries: $totalEntries. Estimated calls: $totalCalls" -ForegroundColor Cyan
Write-Host "[1/$totalCalls] cursor=$($result.cursorBefore)->$($result.cursorAfter) updated=$($result.updated) failures=$($result.failures)" -ForegroundColor Green

while ($true) {
    if ($result.cursorAfter -le $result.cursorBefore -or $result.cursorAfter -eq 0) {
        break
    }

    Start-Sleep -Seconds $PauseSec
    $iteration++

    try {
        $response = Invoke-WorkerJson "$resolvedWorkerUrl/admin/prewarm/order-summaries" "POST" @{ source = $Source; batchSize = $BatchSize }
        $result = $response.result
        $totalProcessed += [int]$result.processed
        $totalUpdated += [int]$result.updated
        $totalFailures += [int]$result.failures

        Write-Host "[$iteration/$totalCalls] cursor=$($result.cursorBefore)->$($result.cursorAfter) updated=$($result.updated) failures=$($result.failures) processedOps=$($result.processed)"
    } catch {
        Write-Host "[$iteration] ERROR: $_ (retrying after pause)" -ForegroundColor Red
    }
}

$elapsed = ((Get-Date) - $startTime).TotalMinutes
Write-Host ""
Write-Host "=== Ranked Summary Prewarm Complete ===" -ForegroundColor Green
Write-Host "Source:         $Source"
Write-Host "Total entries:  $totalEntries"
Write-Host "Processed ops:  $totalProcessed"
Write-Host "Updated ops:    $totalUpdated"
Write-Host "Failures:       $totalFailures"
Write-Host "Time:           $([math]::Round($elapsed, 1)) minutes"
