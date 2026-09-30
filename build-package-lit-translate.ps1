# 打包 dsh-lit-translate 为可安装的 tgz。
#
# 这个脚本照抄 build-package.ps1（onco-lexicon 那份）的骨架，理由也一样：
# 手敲 staging + tar 序列容易出事，尤其是 `Set-Content -Encoding UTF8` 在
# Windows PowerShell 5.1 下会写出 BOM，而 DSH 是 JSON.parse(readFileSync(pkg,'utf8'))，
# 带 BOM 直接抛错。把流程固化下来，并强制校验几条踩过的不变量。
#
# 用法：
#   pwsh -File build-package-lit-translate.ps1
#
# 注意：本文件含中文，**必须存为 UTF-8 with BOM**。
# Windows PowerShell 5.1 对无 BOM 的 .ps1 会按 GBK 解码，中文会乱掉并可能破坏字符串终止符。
# 用外部编辑器改过后请确认 BOM 仍在（EF BB BF）。
#
# 压缩级别：Windows 自带 tar 是 bsdtar，不支持 GNU 的 `-I "gzip -9"`，故一律用 -czf。

param(
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$src = Join-Path $root "dsh-lit-translate"
$stageRoot = Join-Path $root ".pack-lit-translate"
$stage = Join-Path $stageRoot "package"

function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "    $msg" }

# ---- 读版本号（必须用 UTF8 读，避免 GBK 误判）----
$pkgPath = Join-Path $src "package.json"
$pkgText = [IO.File]::ReadAllText($pkgPath, [Text.UTF8Encoding]::new($false))
if ($pkgText -match '^\uFEFF') { Fail "package.json 带 BOM" }
$pkg = $pkgText | ConvertFrom-Json
$version = $pkg.version
Info "版本: $version"

# ---- staging ----
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item (Join-Path $src "package.json"), (Join-Path $src "cordis.patch.yml"), `
          (Join-Path $src "skill.md"), (Join-Path $src "README.md"), `
          (Join-Path $src "LICENSE") $stage -Force
Copy-Item (Join-Path $src "lib") (Join-Path $stage "lib") -Recurse -Force

# ---- 不变量检查（都是曾经踩过的坑）----
if (-not $SkipChecks) {
  # 1) 随包文本文件不得带 BOM
  foreach ($rel in @("package.json", "cordis.patch.yml", "skill.md", "README.md", "lib\index.js", "lib\client.js", "LICENSE")) {
    $p = Join-Path $stage $rel
    if (-not (Test-Path $p)) { Fail "staging 缺少 $rel" }
    $b = [IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Fail "$rel 带 BOM" }
  }
  Ok "7 个文本文件均无 BOM"

  # 2) client 半必须声明在 package.json 里，否则面板不会加载
  if (-not $pkg.exports.'./client') { Fail "package.json 未声明 ./client 导出" }
  if ($pkg.dsh.client.platform -ne "web") { Fail "package.json 未声明 dsh.client.platform=web" }
  Ok "client 半声明完整"

  # 3) bundle patch 必须随包，且 id 和包名一致
  $patchText = [IO.File]::ReadAllText((Join-Path $stage "cordis.patch.yml"), [Text.UTF8Encoding]::new($false))
  if ($patchText -notmatch 'id:\s*dsh-lit-translate') { Fail "cordis.patch.yml 里的 id 不是 dsh-lit-translate" }
  Ok "bundle patch id 正确"

  # 4) 两半的模块名必须一致，否则 host 注册了工具、client 却挂不上面板
  $hostText = [IO.File]::ReadAllText((Join-Path $stage "lib\index.js"), [Text.UTF8Encoding]::new($false))
  $clientText = [IO.File]::ReadAllText((Join-Path $stage "lib\client.js"), [Text.UTF8Encoding]::new($false))
  if ($hostText -notmatch "export const name = 'lit-translate'") { Fail "lib/index.js 的 name 不是 lit-translate" }
  if ($clientText -notmatch "id: 'dsh-lit-translate'") { Fail "lib/client.js 的模块 id 不是 dsh-lit-translate" }
  if ($hostText -notmatch "'lit_translate'") { Fail "lib/index.js 未注册 lit_translate 工具" }
  Ok "两半模块名一致，工具已注册"

  # 5) 测试用的 node_modules 链接绝不能进包
  $junk = Get-ChildItem $stage -Recurse -Force -Directory -Filter "node_modules" -ErrorAction SilentlyContinue
  if ($junk) { Fail "staging 里混进了 node_modules（测试用的 junction）" }
  Ok "无 node_modules 混入"
}

# ---- 打包 ----
$tgz = Join-Path $root "dsh-lit-translate-$version.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }
& tar -czf $tgz -C $stageRoot package
if ($LASTEXITCODE -ne 0) { Fail "tar 失败" }

$tgzBytes = (Get-Item $tgz).Length
Ok ("tgz: {0}  ({1:N1} KB)" -f (Split-Path $tgz -Leaf), ($tgzBytes / 1KB))

# ---- 清理 staging ----
Remove-Item $stageRoot -Recurse -Force

Write-Host ""
Write-Host "安装（需在允许写入 profile 的会话中执行）："
Write-Host "  dsh plugin --profile web remove dsh-lit-translate"
Write-Host "  dsh plugin --profile web add file:$tgz"
Write-Host ""
Write-Host "自测：node test-lit-translate.mjs"
