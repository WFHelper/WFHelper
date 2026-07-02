# ocr.ps1 - Windows built-in OCR (WinRT) for relic reward detection
# Usage: powershell -ExecutionPolicy Bypass -File ocr.ps1 "C:\path\to\image.png"
# Outputs: recognized text to stdout
param([string]$ImagePath)

$ErrorActionPreference = "Stop"

# Load required WinRT assemblies
$null = [Windows.Media.Ocr.OcrEngine,        Windows.Media.Ocr,        ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,         Windows.Storage,          ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,      Windows.Globalization,    ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Synchronously await a WinRT IAsyncOperation<T>. Tries MakeGenericMethod on
# every 1-arg AsTask overload and uses the first that works, since
# IsGenericMethodDefinition/GetGenericArguments() differ across .NET versions.
function Await {
    param([object]$WinRtTask, [type]$ResultType)

    # Determine the generic type argument: prefer explicit $ResultType,
    # fall back to inspecting the task's generic arguments
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
            # Not a generic method or wrong generic arity - try next overload
            continue
        } catch [System.ArgumentException] {
            # Type argument doesn't satisfy constraints - try next overload
            continue
        }
    }

    throw "No compatible AsTask overload found for $($WinRtTask.GetType().FullName)"
}

try {
    # Resolve absolute path (GetFileFromPathAsync requires absolute Windows path)
    $absPath = [System.IO.Path]::GetFullPath($ImagePath)

    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
    $stream      = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder     = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap      = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Try English first - Warframe's riven stats are always in English
    # regardless of the user's game language setting.  Using the English OCR
    # model gives the best recognition accuracy for stat names.
    $lang   = [Windows.Globalization.Language]::new("en")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) {
        # Fallback: use system language if English pack is unavailable
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        Write-Error "OCR engine unavailable"
        exit 1
    }

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    Write-Output $result.Text
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
