# ocr-server.ps1 — Persistent Windows OCR (WinRT) server
#
# Stays alive between calls to eliminate per-call PowerShell process-spawn overhead.
# The caller communicates via stdin/stdout with a simple line protocol:
#
#   Startup:   server writes "===OCR_SERVER_READY===" once the engine is initialised.
#   Request:   caller writes one absolute image path followed by "\n".
#   Success:   server writes the recognised text (may be multi-line), then "===OCR_END===".
#   Error:     server writes "===OCR_ERROR: <message>===".
#   Shutdown:  caller writes "EXIT"; server exits cleanly.
#
# The engine and WinRT assemblies are loaded ONCE at startup.  On a typical
# machine the first call is ~250-450 ms (startup + assembly load), every
# subsequent call is ~30-60 ms (just bitmap decode + RecognizeAsync).

param()

$ErrorActionPreference = "Stop"

# ── Load WinRT assemblies (one-time) ─────────────────────────────────────────
$null = [Windows.Media.Ocr.OcrEngine,                   Windows.Media.Ocr,        ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,         Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,        Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,                    Windows.Storage,          ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,    Windows.Storage.Streams,  ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,                 Windows.Globalization,    ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# ── Await helper (same as ocr.ps1) ────────────────────────────────────────────
function Await {
    param([object]$WinRtTask, [type]$ResultType)

    $typeArg = $ResultType
    if ($null -eq $typeArg) {
        $genericArgs = $WinRtTask.GetType().GetGenericArguments()
        if ($genericArgs.Count -gt 0) {
            $typeArg = $genericArgs[0]
        }
    }
    if ($null -eq $typeArg) {
        throw "Cannot determine result type for WinRT async operation"
    }

    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() |
               Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 }

    foreach ($method in $methods) {
        try {
            $generic = $method.MakeGenericMethod($typeArg)
            $task = $generic.Invoke($null, @($WinRtTask))
            $task.Wait()
            return $task.Result
        } catch [System.InvalidOperationException] {
            continue
        } catch [System.ArgumentException] {
            continue
        }
    }

    throw "No compatible AsTask overload found for $($WinRtTask.GetType().FullName)"
}

# ── Initialise OCR engine (one-time) ─────────────────────────────────────────
try {
    $lang   = [Windows.Globalization.Language]::new("en")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        [Console]::Out.WriteLine("===OCR_ERROR: Windows OCR engine unavailable on this system===")
        [Console]::Out.Flush()
        exit 1
    }
} catch {
    [Console]::Out.WriteLine("===OCR_ERROR: Engine init failed: " + $_.Exception.Message + "===")
    [Console]::Out.Flush()
    exit 1
}

[Console]::Out.WriteLine("===OCR_SERVER_READY===")
[Console]::Out.Flush()

# ── Request loop ──────────────────────────────────────────────────────────────
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $imagePath = $line.Trim()
    if (-not $imagePath) { continue }
    if ($imagePath -eq "EXIT") { break }

    $stream = $null
    $bitmap = $null
    try {
        $absPath     = [System.IO.Path]::GetFullPath($imagePath)
        $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath))     ([Windows.Storage.StorageFile])
        $stream      = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read))    ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder     = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))   ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap      = Await ($decoder.GetSoftwareBitmapAsync())                                 ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result      = Await ($engine.RecognizeAsync($bitmap))                                   ([Windows.Media.Ocr.OcrResult])

        [Console]::Out.WriteLine($result.Text)
        [Console]::Out.WriteLine("===OCR_END===")
        [Console]::Out.Flush()
    } catch {
        [Console]::Out.WriteLine("===OCR_ERROR: " + $_.Exception.Message + "===")
        [Console]::Out.Flush()
    } finally {
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    }
}
