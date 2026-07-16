# Synthetic 1920x1080 relic reward screens on FIXED_REWARD_LAYOUTS[4] geometry.
# Three variants: clean, wrap-clipped (second name line falls below the title
# crop), bright strip behind slot 4. Invoked by run-check.cjs; Windows-only.
param([string]$OutDir)

Add-Type -AssemblyName System.Drawing

$W = 1920
$H = 1080
$slotX = @(470, 714, 958, 1202)
$slotY = 243
$slotW = 234
$titleY = 413
$titleH = 44

$names = @(
    @("Vadarya Prime Stock"),
    @("Perigale Prime Blueprint"),
    @("Pangolin Prime Handle"),
    @("Yareli Prime Chassis", "Blueprint")
)

function New-RewardScreen {
    param([string]$Path, [bool]$ClipSecondLine, [bool]$BrightSlot4)

    $bmp = New-Object Drawing.Bitmap($W, $H)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([Drawing.Color]::FromArgb(16, 16, 24))

    $artBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(138, 138, 146))
    $stripBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(21, 21, 28))
    $goldBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(200, 168, 75))
    $textBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(240, 240, 240))
    $font = New-Object Drawing.Font("Segoe UI", 17, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)

    for ($i = 0; $i -lt 4; $i++) {
        $x = $slotX[$i]
        $g.FillRectangle($artBrush, $x, $slotY, $slotW, ($titleY - $slotY - 3))
        if ($BrightSlot4 -and $i -eq 3) {
            $g.FillRectangle($goldBrush, $x, ($titleY - 3), $slotW, ($titleH + 14))
        } else {
            $g.FillRectangle($stripBrush, $x, ($titleY - 3), $slotW, ($titleH + 14))
        }

        $lines = $names[$i]
        if ($lines.Count -eq 1) {
            $size = $g.MeasureString($lines[0], $font)
            $g.DrawString($lines[0], $font, $textBrush, ($x + (($slotW - $size.Width) / 2)), ($titleY + 11))
        } else {
            $size1 = $g.MeasureString($lines[0], $font)
            $g.DrawString($lines[0], $font, $textBrush, ($x + (($slotW - $size1.Width) / 2)), ($titleY + 2))
            $size2 = $g.MeasureString($lines[1], $font)
            $tx2 = $x + (($slotW - $size2.Width) / 2)
            if ($ClipSecondLine) {
                $g.DrawString($lines[1], $font, $textBrush, $tx2, ($titleY + $titleH + 6))
            } else {
                $g.DrawString($lines[1], $font, $textBrush, $tx2, ($titleY + 22))
            }
        }
    }

    $g.Dispose()
    $bmp.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

New-RewardScreen -Path (Join-Path $OutDir "synthetic-clean.png") -ClipSecondLine $false -BrightSlot4 $false
New-RewardScreen -Path (Join-Path $OutDir "synthetic-clipped-wrap.png") -ClipSecondLine $true -BrightSlot4 $false
New-RewardScreen -Path (Join-Path $OutDir "synthetic-bright-slot4.png") -ClipSecondLine $false -BrightSlot4 $true
Write-Output "synthetic screens written to $OutDir"
