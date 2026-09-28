# Build the project icon assets\app.ico (multi-size: 256/64/48/32/16).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
# NOTE: keep this file ASCII-only so Windows PowerShell 5.1 (ANSI codepage) can parse it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$assetsDir = Join-Path $projectRoot 'assets'
if (-not (Test-Path -LiteralPath $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir | Out-Null }
$target = Join-Path $assetsDir 'app.ico'

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded square background #0071E3
  $radius = [Math]::Max(2, [int]($size * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 113, 227))
  $g.FillPath($brush, $path)

  # White glyph U+8BC4, written by code point to stay encoding independent
  $fontSize = [float]($size * 0.58)
  $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, [float]($size * 0.02), $size, $size)
  $g.DrawString([string][char]0x8BC4, $font, [System.Drawing.Brushes]::White, $rect, $format)

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
  $brush.Dispose()
  $font.Dispose()
  return $bytes
}

$sizes = @(256, 64, 48, 32, 16)
# ArrayList.Add keeps each image as one object (+= would flatten byte arrays)
$images = New-Object System.Collections.ArrayList
foreach ($s in $sizes) { [void]$images.Add([byte[]](New-IconPng $s)) }

$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)
$writer.Write([UInt16]0)                 # reserved
$writer.Write([UInt16]1)                 # type: icon
$writer.Write([UInt16]$sizes.Count)      # image count

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $data = $images[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $writer.Write([byte]$dim)              # width
  $writer.Write([byte]$dim)              # height
  $writer.Write([byte]0)                 # palette
  $writer.Write([byte]0)                 # reserved
  $writer.Write([UInt16]1)               # color planes
  $writer.Write([UInt16]32)              # bits per pixel
  $writer.Write([UInt32]$data.Length)    # size
  $writer.Write([UInt32]$offset)         # offset
  $offset += $data.Length
}
foreach ($data in $images) { $writer.Write($data) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
$writer.Dispose()
$out.Dispose()

Write-Output ("icon written: " + $target + "  (" + (Get-Item -LiteralPath $target).Length + " bytes, " + $sizes.Count + " sizes)")
