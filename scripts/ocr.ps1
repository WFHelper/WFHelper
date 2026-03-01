# ocr.ps1 — Windows built-in OCR (WinRT) for relic reward detection
# Usage: powershell -ExecutionPolicy Bypass -File ocr.ps1 "C:\path\to\image.png"
# Outputs: recognized text to stdout
param([string]$ImagePath)

$ErrorActionPreference = "Stop"

# Load required WinRT assemblies
$null = [Windows.Media.Ocr.OcrEngine,        Windows.Media.Ocr,        ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,         Windows.Storage,          ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Helper: synchronously await a WinRT IAsyncOperation
function Await {
    param([object]$WinRtTask, [type]$ResultType)
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() |
               Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 }
    $asTask = $methods | Select-Object -First 1
    $generic = $asTask.MakeGenericMethod($WinRtTask.GetType().GetGenericArguments()[0])
    $task = $generic.Invoke($null, @($WinRtTask))
    $task.Wait()
    return $task.Result
}

try {
    # Resolve absolute path (GetFileFromPathAsync requires absolute Windows path)
    $absPath = [System.IO.Path]::GetFullPath($ImagePath)

    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath))
    $stream      = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read))
    $decoder     = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
    $bitmap      = Await ($decoder.GetSoftwareBitmapAsync())

    # Use the system's default user language for OCR
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        # Fallback: try English explicitly
        $lang   = [Windows.Globalization.Language]::new("en")
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    if ($null -eq $engine) {
        Write-Error "OCR engine unavailable"
        exit 1
    }

    $result = Await ($engine.RecognizeAsync($bitmap))
    Write-Output $result.Text
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
