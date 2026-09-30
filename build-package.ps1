# 打包 dsh-onco-lexicon 为可安装的 tgz。
#
# 为什么要有这个脚本：之前每次都是手敲一遍 staging + tar 序列，结果用
# `Set-Content -Encoding UTF8` 改版本号时误写了 BOM（PS 5.1 的 -Encoding UTF8 带 BOM），
# 而 DSH 是 JSON.parse(readFileSync(pkg,'utf8'))，带 BOM 会直接抛错。
# 把流程固化下来，并在这里强制校验那几条曾出过事的不变量。
#
# 用法：
#   powershell -File build-package.ps1
#   powershell -File build-package.ps1 -SkipChecks
#
# 注意：本文件含中文，**必须存为 UTF-8 with BOM**。
# Windows PowerShell 5.1 对无 BOM 的 .ps1 会按 GBK 解码，中文会乱掉并破坏字符串终止符
# （本脚本第一次写好时就因此直接解析失败）。用外部编辑器改过后请确认 BOM 仍在（EF BB BF）。
#
# 压缩级别：Windows 自带 tar 是 bsdtar，不支持 GNU 的 `-I "gzip -9"`。
# 实测 9 级相对默认 6 级只省 0.08 MB（0.6%），不值得为它引入平台差异，故一律用 -czf。

param(
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$src = Join-Path $root "dsh-onco-lexicon"
$stageRoot = Join-Path $root ".pack"
$stage = Join-Path $stageRoot "package"

function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "    $msg" }

# ---- 读版本号（必须用 UTF8 读，避免 GBK 误判）----
$pkgText = [IO.File]::ReadAllText((Join-Path $src "package.json"), [Text.UTF8Encoding]::new($false))
if ($pkgText -match '^\uFEFF') { Fail "package.json 带 BOM" }
$pkg = $pkgText | ConvertFrom-Json
$version = $pkg.version
Info "版本: $version"

# ---- staging ----
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage "data"), (Join-Path $stage "assets") | Out-Null
Copy-Item (Join-Path $src "package.json"), (Join-Path $src "cordis.patch.yml"), `
          (Join-Path $src "skill.md"), (Join-Path $src "README.md"), `
          (Join-Path $src "LICENSE"), (Join-Path $src "THIRD-PARTY-NOTICES.md") $stage -Force
Copy-Item (Join-Path $src "lib") (Join-Path $stage "lib") -Recurse -Force
Copy-Item (Join-Path $src "data\onco.seed.jsonl") (Join-Path $stage "data") -Force
Copy-Item (Join-Path $src "data\onco.ncit.jsonl") (Join-Path $stage "data") -Force
Copy-Item (Join-Path $src "assets\icon.png") (Join-Path $stage "assets") -Force

# ---- 不变量检查（都是曾经踩过的坑）----
if (-not $SkipChecks) {
  # 1) 随包文本文件不得带 BOM
  foreach ($rel in @("package.json", "cordis.patch.yml", "skill.md", "README.md", "lib\index.js", "lib\client.js", "LICENSE", "THIRD-PARTY-NOTICES.md")) {
    $p = Join-Path $stage $rel
    if (-not (Test-Path $p)) { Fail "staging 缺少 $rel" }
    $b = [IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Fail "$rel 带 BOM" }
  }
  Ok "8 个文本文件均无 BOM"

  # 2) 图标必须随包（否则图标路由 404，客户端只剩文字回退）
  if (-not (Test-Path (Join-Path $stage "assets\icon.png"))) { Fail "assets/icon.png 未随包" }
  Ok "assets/icon.png 已随包"

  # 3) 词典必须精简（text 字段插件不读，实测白占 2.17 MB 压缩体积）
  $dictPath = Join-Path $stage "data\onco.ncit.jsonl"
  $firstLine = ""
  $reader = [IO.File]::OpenText($dictPath)
  try { $firstLine = $reader.ReadLine() } finally { $reader.Close() }
  if ($firstLine -match '"text"\s*:') { Fail "词典含 text 字段，应跑 python build-plugin-dict.py 重建（除非有意 --keep-text）" }
  if ($firstLine -notmatch '"sources"\s*:') { Fail "词典缺少 sources 字段（出处筛查依赖它）" }
  Ok "词典已精简（无 text，含 sources）"

  # 4) client 半必须声明在 package.json 里，否则面板不会加载
  if (-not $pkg.exports.'./client') { Fail "package.json 未声明 ./client 导出" }
  if ($pkg.dsh.client.platform -ne "web") { Fail "package.json 未声明 dsh.client.platform=web" }
  Ok "client 半声明完整"
}

# ---- 打包 ----
$tgz = Join-Path $root "dsh-onco-lexicon-$version.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }
# -czf = gzip 默认 6 级。9 级实测只省 0.6%，且 bsdtar 不支持 -I，故不折腾。
& tar -czf $tgz -C $stageRoot package
if ($LASTEXITCODE -ne 0) { Fail "tar 失败" }

$tgzBytes = (Get-Item $tgz).Length
$dictBytes = (Get-Item (Join-Path $stage "data\onco.ncit.jsonl")).Length
Ok ("tgz: {0}  ({1:N2} MB)" -f (Split-Path $tgz -Leaf), ($tgzBytes / 1MB))
Info ("词典原始 {0:N1} MB -> 压缩占比 {1:P1}" -f ($dictBytes / 1MB), ($tgzBytes / $dictBytes))

# ---- 清理 staging ----
Remove-Item $stageRoot -Recurse -Force

Write-Host ""
Write-Host "安装（需在允许写入 profile 的会话中执行）："
Write-Host "  dsh plugin --profile web remove dsh-onco-lexicon"
Write-Host "  dsh plugin --profile web add file:$tgz"
