# Prewarm the backend cache for all WFM items.
# Usage:
#   $env:WFC_API_KEY = "your-admin-api-key"
#   .\scripts\prewarm.ps1
#
# Or (less secure — key ends up in process args / history):
#   .\scripts\prewarm.ps1 -ApiKey "your-admin-api-key"
#
# This calls /admin/prewarm in a loop until the cursor wraps around,
# meaning the entire catalog has been processed. With batchSize=100
# and ~3750 items, this takes ~30-60 minutes depending on WFM rate limits.

param(
    [string]$ApiKey = $env:WFC_API_KEY,

    [string]$WorkerUrl = "https://api.wfhelper.com",
    [int]$BatchSize = 100,
    [int]$PauseSec = 8
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: No API key provided. Set `$env:WFC_API_KEY or pass -ApiKey." -ForegroundColor Red
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Content-Type"  = "application/json"
}

$totalProcessed = 0
$totalPrice = 0
$totalMeta = 0
$totalFailures = 0
$totalSkipped = 0
$iteration = 0
$startTime = Get-Date
$firstCursor = $null
$catalogSize = 0

Write-Host "=== Backend Prewarm ===" -ForegroundColor Cyan
Write-Host "Worker:    $WorkerUrl"
Write-Host "Batch:     $BatchSize items per call"
Write-Host "Pause:     ${PauseSec}s between calls"
Write-Host ""

# First call: reset cursor and refresh catalog
Write-Host "Refreshing catalog and resetting cursor..." -ForegroundColor Yellow
$body = @{ batchSize = $BatchSize; resetCursor = $true; refreshCatalog = $true } | ConvertTo-Json

try {
    $resp = Invoke-RestMethod -Uri "$WorkerUrl/admin/prewarm" -Method POST -Headers $headers -Body $body -ErrorAction Stop
    $r = $resp.result
    $catalogSize = $r.totalCatalogSlugs
    $firstCursor = $r.cursorAfter
    $totalProcessed += $r.processed
    $totalPrice += $r.priceUpdated
    $totalMeta += $r.metaUpdated
    $totalFailures += $r.failures
    $totalSkipped += $r.skippedUntradable
    $iteration++

    Write-Host "Catalog: $catalogSize items. First batch done ($($r.processed) processed, $($r.priceUpdated) prices, $($r.failures) failures)" -ForegroundColor Green
} catch {
    Write-Host "ERROR on first call: $_" -ForegroundColor Red
    exit 1
}

# Loop until cursor wraps
$totalCalls = [math]::Ceiling($catalogSize / $BatchSize)
Write-Host "Estimated calls needed: $totalCalls (ETA ~$([math]::Round($totalCalls * $PauseSec / 60, 1)) min)" -ForegroundColor Cyan
Write-Host ""

$body = @{ batchSize = $BatchSize } | ConvertTo-Json

while ($true) {
    Start-Sleep -Seconds $PauseSec
    $iteration++

    try {
        $resp = Invoke-RestMethod -Uri "$WorkerUrl/admin/prewarm" -Method POST -Headers $headers -Body $body -ErrorAction Stop
        $r = $resp.result
        $totalProcessed += $r.processed
        $totalPrice += $r.priceUpdated
        $totalMeta += $r.metaUpdated
        $totalFailures += $r.failures
        $totalSkipped += $r.skippedUntradable

        $pct = [math]::Round($totalProcessed / [math]::Max($catalogSize, 1) * 100, 1)
        $elapsed = ((Get-Date) - $startTime).TotalMinutes
        Write-Host "[$iteration/$totalCalls] cursor=$($r.cursorBefore)->$($r.cursorAfter)  processed=$($r.processed) prices=$($r.priceUpdated) fail=$($r.failures) skip=$($r.skippedUntradable)  total=$totalProcessed/${catalogSize} (${pct}%)  elapsed=$([math]::Round($elapsed,1))m"

        # Stop when cursor wraps back to 0 or past the start
        if ($r.cursorAfter -le $r.cursorBefore -or $r.cursorAfter -eq 0) {
            Write-Host ""
            Write-Host "=== Prewarm Complete ===" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "[$iteration] ERROR: $_ (retrying after pause)" -ForegroundColor Red
    }
}

$elapsed = ((Get-Date) - $startTime).TotalMinutes
Write-Host "Total processed: $totalProcessed"
Write-Host "Prices cached:   $totalPrice"
Write-Host "Meta cached:     $totalMeta"
Write-Host "Failures:        $totalFailures"
Write-Host "Untradable skip: $totalSkipped"
Write-Host "Time:            $([math]::Round($elapsed, 1)) minutes"
