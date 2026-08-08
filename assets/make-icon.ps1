Add-Type -AssemblyName System.Drawing

function New-IconFrame {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $Size
    $pad = [Math]::Max(1, [int]($s * 0.03))
    $rect = New-Object System.Drawing.RectangleF $pad, $pad, ($s - 2*$pad), ($s - 2*$pad)
    $radius = $s * 0.22

    # rounded-square background path
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $bg1 = [System.Drawing.Color]::FromArgb(255, 15, 23, 32)   # #0f1720
    $bg2 = [System.Drawing.Color]::FromArgb(255, 31, 44, 64)   # #1f2c40
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bg1, $bg2, 45)
    $g.FillPath($bgBrush, $path)

    # subtle border
    $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 77, 163, 255)), ([Math]::Max(1, $s * 0.012))
    $g.DrawPath($borderPen, $path)
    $g.SetClip($path)

    # --- skyline: two buildings ---
    $accent  = [System.Drawing.Color]::FromArgb(255, 77, 163, 255)   # #4da3ff
    $accent2 = [System.Drawing.Color]::FromArgb(255, 124, 212, 192)  # #7cd4c0
    $window  = [System.Drawing.Color]::FromArgb(235, 232, 238, 247)  # near-white

    # back building (shorter, teal)
    $bw = $s * 0.26
    $bx = $s * 0.14
    $bh = $s * 0.40
    $by = $s * 0.50
    $backBrush = New-Object System.Drawing.SolidBrush $accent2
    $g.FillRectangle($backBrush, $bx, $by, $bw, $bh)

    # front building (taller, blue)
    $fw = $s * 0.40
    $fx = $s * 0.44
    $fh = $s * 0.60
    $fy = $s * 0.30
    $frontBrush = New-Object System.Drawing.SolidBrush $accent
    $g.FillRectangle($frontBrush, $fx, $fy, $fw, $fh)

    # windows on front building
    $winBrush = New-Object System.Drawing.SolidBrush $window
    $cols = 3; $rows = 4
    $wInset = $fw * 0.14
    $cellW = ($fw - 2*$wInset) / $cols
    $cellH = ($fh - $wInset) / ($rows + 1)
    $winW = $cellW * 0.55
    $winH = $cellH * 0.5
    for ($r = 0; $r -lt $rows; $r++) {
        for ($c = 0; $c -lt $cols; $c++) {
            $wx = $fx + $wInset + $c * $cellW + ($cellW - $winW)/2
            $wy = $fy + $wInset*0.6 + $r * $cellH + ($cellH - $winH)/2
            $g.FillRectangle($winBrush, $wx, $wy, $winW, $winH)
        }
    }
    # windows on back building
    $cols2 = 2; $rows2 = 3
    $wInset2 = $bw * 0.16
    $cellW2 = ($bw - 2*$wInset2) / $cols2
    $cellH2 = ($bh - $wInset2) / ($rows2 + 1)
    $winW2 = $cellW2 * 0.5
    $winH2 = $cellH2 * 0.45
    $winBrush2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 15, 23, 32))
    for ($r = 0; $r -lt $rows2; $r++) {
        for ($c = 0; $c -lt $cols2; $c++) {
            $wx = $bx + $wInset2 + $c * $cellW2 + ($cellW2 - $winW2)/2
            $wy = $by + $wInset2*0.6 + $r * $cellH2 + ($cellH2 - $winH2)/2
            $g.FillRectangle($winBrush2, $wx, $wy, $winW2, $winH2)
        }
    }

    $g.ResetClip()

    # magnifying glass (report/lookup), bottom-right, white with navy outline for contrast
    $mgCx = $s * 0.755
    $mgCy = $s * 0.755
    $mgR  = $s * 0.155
    $ringPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 15, 23, 32)), ($s * 0.075)
    $ringPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawEllipse($ringPen, $mgCx - $mgR, $mgCy - $mgR, $mgR*2, $mgR*2)
    $ringPen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)), ($s * 0.045)
    $ringPen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawEllipse($ringPen2, $mgCx - $mgR, $mgCy - $mgR, $mgR*2, $mgR*2)
    $handleLen = $s * 0.14
    $hx1 = $mgCx + $mgR*0.72; $hy1 = $mgCy + $mgR*0.72
    $hx2 = $hx1 + $handleLen*0.72; $hy2 = $hy1 + $handleLen*0.72
    $handlePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 15, 23, 32)), ($s * 0.085)
    $handlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $handlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($handlePen, $hx1, $hy1, $hx2, $hy2)
    $handlePen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)), ($s * 0.05)
    $handlePen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $handlePen2.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($handlePen2, $hx1, $hy1, $hx2, $hy2)

    $g.Dispose()
    return $bmp
}

function Get-PngBytes($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    # the leading comma prevents PowerShell from unrolling the byte[] into
    # individual boxed bytes when it crosses the function return boundary
    return ,$ms.ToArray()
}

$sizes = @(16, 32, 48, 64, 128, 256)
$frames = @()
foreach ($sz in $sizes) {
    $bmp = New-IconFrame -Size $sz
    $png = Get-PngBytes $bmp
    $frames += [PSCustomObject]@{ Size = $sz; Png = $png }
    $bmp.Dispose()
}

# also save a standalone 256px PNG (handy for favicons etc.) — reuse the
# already-rendered bytes instead of Bitmap.Save(path) to dodge GDI+ file locks
[System.IO.File]::WriteAllBytes("$PSScriptRoot\icon-256.png", ($frames | Where-Object { $_.Size -eq 256 }).Png)

# --- write multi-resolution .ico (ICONDIR + ICONDIRENTRY[] + PNG blobs) ---
$icoPath = "$PSScriptRoot\app.ico"
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type = icon
$bw.Write([UInt16]$frames.Count)

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
    $wByte = if ($f.Size -ge 256) { 0 } else { $f.Size }
    $bw.Write([Byte]$wByte)          # width
    $bw.Write([Byte]$wByte)          # height
    $bw.Write([Byte]0)               # color count
    $bw.Write([Byte]0)               # reserved
    $bw.Write([UInt16]1)             # planes
    $bw.Write([UInt16]32)            # bit count
    $bw.Write([UInt32]$f.Png.Length) # bytes in resource
    $bw.Write([UInt32]$offset)       # offset
    $offset += $f.Png.Length
}
foreach ($f in $frames) {
    $bw.Write($f.Png)
}
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Output "Wrote $icoPath ($([System.IO.File]::ReadAllBytes($icoPath).Length) bytes) and icon-256.png"
