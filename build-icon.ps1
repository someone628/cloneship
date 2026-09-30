# 把源图做成词典图标，并把 base64 内嵌进 lib/client.js。
#
# 做法：
#   1) 缩放到 64px 并做 gamma 校正（源图是浅灰线稿，不加深对比度缩到 20px 会糊）
#   2) 输出 assets/icon.png
#   3) 把 PNG 以 data URI 写进 client.js 的 ICON_B64_START / ICON_B64_END 标记之间
#
# 用标记而不是占位符，是为了脚本可重复运行（不会第二次就找不到替换目标）。
#
# 用法：pwsh -File build-icon.ps1 [-Source <jpg>] [-Size 64] [-Gamma 2.2]

param(
  [string]$Source = "C:\Users\Abc89\Desktop\9fde96db4c4e5dc0343bae6ae96affa9.jpg",
  [int]$Size = 64,
  [double]$Gamma = 2.2
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$pluginDir = Join-Path $PSScriptRoot "dsh-onco-lexicon"
$assetsDir = Join-Path $pluginDir "assets"
$clientJs = Join-Path $pluginDir "lib\client.js"
$pngOut = Join-Path $assetsDir "icon.png"

if (-not (Test-Path $Source)) { throw "源图不存在：$Source" }
if (-not (Test-Path $clientJs)) { throw "找不到 client.js：$clientJs" }
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

# ---- 1) 缩放 + gamma ----
$src = [System.Drawing.Image]::FromFile($Source)
$bmp = New-Object System.Drawing.Bitmap($Size, $Size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$attr = New-Object System.Drawing.Imaging.ImageAttributes
$attr.SetGamma($Gamma)
$rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
$g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
$g.Dispose(); $attr.Dispose(); $src.Dispose()
$bmp.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$pngBytes = (Get-Item $pngOut).Length
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pngOut))

# ---- 2) 注入 client.js ----
$text = [IO.File]::ReadAllText($clientJs)
$start = "/* ICON_B64_START */"
$end = "/* ICON_B64_END */"
$i = $text.IndexOf($start)
$j = $text.IndexOf($end)
if ($i -lt 0 -or $j -lt 0 -or $j -lt $i) { throw "client.js 里找不到 ICON_B64 标记" }

$block = @"
$start
    const ICON_DATA_URI = 'data:image/png;base64,$b64'
    $end
"@
$newText = $text.Substring(0, $i) + $block + $text.Substring($j + $end.Length)
[IO.File]::WriteAllText($clientJs, $newText, (New-Object Text.UTF8Encoding($false)))

Write-Host ("源图     : {0}" -f $Source)
Write-Host ("图标     : {0}x{0}  gamma={1}  {2} B" -f $Size, $Gamma, $pngBytes)
Write-Host ("base64   : {0} B" -f $b64.Length)
Write-Host ("已写入   : {0}" -f $clientJs)
