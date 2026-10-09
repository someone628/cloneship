# 生成 dsh-ct-norm 的侧边栏图标（64x64 PNG）。
#
# 用 .NET 的 System.Drawing 直接画，不依赖任何图像库与源图；
# 与 onco-lexicon 的 build-icon.ps1 思路一致（那边是从源图缩放，这里是从零绘制，
# 因为本插件没有设计稿）。
#
# 用法：pwsh -File build-icon-ct-norm.ps1
#
# 注意：本文件含中文，**必须存为 UTF-8 with BOM**。

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot "dsh-ct-norm\assets\icon.png"
$dir = Split-Path $out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$size = 64
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角方块底：青绿（与面板主色 #0d9488 一致）
$bg = [System.Drawing.Color]::FromArgb(255, 13, 148, 136)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 14
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush($bg)
$g.FillPath($brush, $path)

# 「CT」字样：白色粗体
$font = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$g.DrawString("CT", $font, $white, $rect, $fmt)

# 右下角一个小圆点，暗示"归一化到的目标概念"
$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 253, 250))
$g.FillEllipse($dot, 46, 46, 9, 9)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$bytes = (Get-Item $out).Length
Write-Host ("[+] 已生成 {0}（{1} 字节）" -f $out, $bytes) -ForegroundColor Green
