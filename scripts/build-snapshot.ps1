# Trigger a full snapshot build on the backend worker.
#
# Usage:
#   $env:WFC_API_KEY = "your-admin-api-key"
#   .\scripts\build-snapshot.ps1
#
# Or (less secure — key ends up in process args / history):
#   .\scripts\build-snapshot.ps1 -ApiKey "your-admin-api-key"

param(
    [string]$ApiKey = $env:WFC_API_KEY,

    [string]$WorkerUrl = "https://api.wfhelper.com"
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: No API key provided. Set `$env:WFC_API_KEY or pass -ApiKey." -ForegroundColor Red
    exit 1
}

$resolvedWorkerUrl = $WorkerUrl.TrimEnd('/')
$headers = @{ "Authorization" = "Bearer $ApiKey" }

Write-Host "=== Snapshot Build ===" -ForegroundColor Cyan
Write-Host "Worker: $resolvedWorkerUrl"
Write-Host ""

Write-Host "Checking current snapshot status..." -ForegroundColor Yellow
try {
    $status = Invoke-RestMethod -Uri "$resolvedWorkerUrl/admin/snapshot/status" -Method GET -Headers $headers -ErrorAction Stop
    if ($status.result.generatedAt) {
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $status.result.generatedAt
        $ageMin = [math]::Round($age / 60000, 1)
        Write-Host "  Last snapshot: $ageMin minutes ago ($($status.result.generatedAt))" -ForegroundColor Gray
    } else {
        Write-Host "  No snapshot exists yet." -ForegroundColor Red
    }
} catch {
    Write-Host "  Could not read status: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Triggering snapshot build..." -ForegroundColor Yellow

try {
    $result = Invoke-RestMethod -Uri "$resolvedWorkerUrl/admin/snapshot/build" -Method POST -Headers $headers -ErrorAction Stop
    if ($result.ok) {
        $ts = $result.result.generatedAt
        Write-Host "  Snapshot built successfully. generatedAt: $ts" -ForegroundColor Green
    } else {
        Write-Host "  Build returned ok=false: $($result | ConvertTo-Json)" -ForegroundColor Red
    }
} catch {
    Write-Host "  Build failed: $_" -ForegroundColor Red
    exit 1
}
