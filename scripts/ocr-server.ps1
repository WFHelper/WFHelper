# ocr-server.ps1 — Persistent Windows OCR (WinRT) server with JSON protocol

param()

$ErrorActionPreference = "Stop"

$null = [Windows.Media.Ocr.OcrEngine,                   Windows.Media.Ocr,        ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,         Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,        Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,                    Windows.Storage,          ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,    Windows.Storage.Streams,  ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter,             Windows.Storage.Streams,  ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,                 Windows.Globalization,    ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

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

function Convert-RectToHash {
    param([Parameter(Mandatory=$true)] $Rect)

    return @{
        left = [int][Math]::Round($Rect.X)
        top = [int][Math]::Round($Rect.Y)
        width = [int][Math]::Round($Rect.Width)
        height = [int][Math]::Round($Rect.Height)
    }
}

function Get-LineRect {
    param([Parameter(Mandatory=$true)] $Words)

    if ($null -eq $Words -or $Words.Count -eq 0) {
        return @{ X = 0; Y = 0; Width = 0; Height = 0 }
    }

    $left = [double]::MaxValue
    $top = [double]::MaxValue
    $right = 0.0
    $bottom = 0.0

    foreach ($word in $Words) {
        $box = $word.BoundingRect
        if ($box.X -lt $left) { $left = $box.X }
        if ($box.Y -lt $top) { $top = $box.Y }
        if (($box.X + $box.Width) -gt $right) { $right = $box.X + $box.Width }
        if (($box.Y + $box.Height) -gt $bottom) { $bottom = $box.Y + $box.Height }
    }

    return @{
        X = $left
        Y = $top
        Width = [Math]::Max(0, $right - $left)
        Height = [Math]::Max(0, $bottom - $top)
    }
}

function Get-SoftwareBitmap {
    param([string]$ImagePath, [string]$ImageBase64)

    $stream = $null
    try {
        if ($ImageBase64) {
            $bytes = [Convert]::FromBase64String($ImageBase64)
            $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
            $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
            try {
                $writer.WriteBytes($bytes)
                $null = Await ($writer.StoreAsync()) ([uint32])
                $null = Await ($writer.FlushAsync()) ([bool])
            } finally {
                # DetachStream() must be called before Dispose() — DataWriter.Dispose()
                # closes the underlying stream, which would cause RO_E_CLOSED (0x80000013)
                # on the subsequent Seek(0) call.
                $null = $writer.DetachStream()
                $writer.Dispose()
            }
            $stream.Seek(0)
        } elseif ($ImagePath) {
            $absPath = [System.IO.Path]::GetFullPath($ImagePath)
            $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
            $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        } else {
            throw "Request missing imagePath/imageBase64"
        }

        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        return Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } finally {
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    }
}

try {
    $lang   = [Windows.Globalization.Language]::new("en")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        [Console]::Out.WriteLine('{"id":"startup","ok":false,"error":"Windows OCR engine unavailable on this system"}')
        [Console]::Out.Flush()
        exit 1
    }
} catch {
    $payload = @{
        id = 'startup'
        ok = $false
        error = "Engine init failed: $($_.Exception.Message)"
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($payload)
    [Console]::Out.Flush()
    exit 1
}

[Console]::Out.WriteLine("===OCR_SERVER_READY===")
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    if ($trimmed -eq "EXIT") { break }

    $bitmap = $null
    try {
        $req = $trimmed | ConvertFrom-Json
        $bitmap = Get-SoftwareBitmap -ImagePath $req.imagePath -ImageBase64 $req.imageBase64
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        $lines = @()
        foreach ($ocrLine in $result.Lines) {
            $words = @()
            foreach ($word in $ocrLine.Words) {
                $words += @{
                    text = $word.Text
                    box = Convert-RectToHash -Rect $word.BoundingRect
                }
            }

            $lines += @{
                text = $ocrLine.Text
                box = Convert-RectToHash -Rect (Get-LineRect -Words $ocrLine.Words)
                words = $words
            }
        }

        $payload = @{
            id = $req.id
            ok = $true
            result = @{
                text = $result.Text
                lines = $lines
            }
        } | ConvertTo-Json -Depth 8 -Compress

        [Console]::Out.WriteLine($payload)
        [Console]::Out.Flush()
    } catch {
        $reqId = $null
        try {
            if ($req -and $req.id) { $reqId = [string]$req.id }
        } catch {}
        $payload = @{
            id = $reqId
            ok = $false
            error = $_.Exception.Message
        } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($payload)
        [Console]::Out.Flush()
    } finally {
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    }
}
