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
          (Join-Path $src "LICENSE"), (Join-Path $src "THIRD-PARTY-NOTICES.md") $stage -Force
Copy-Item (Join-Path $src "lib") (Join-Path $stage "lib") -Recurse -Force
# MeSH 2026 派生索引：74 MiB 的二进制，只随 tgz / npm 包分发，不进 git
# （与 dsh-onco-lexicon/data/onco.ncit.jsonl 同一套办法，见 .gitignore 与 data/README.md）
Copy-Item (Join-Path $src "data") (Join-Path $stage "data") -Recurse -Force

# ---- 不变量检查（都是曾经踩过的坑）----
if (-not $SkipChecks) {
  # 1) 随包文本文件不得带 BOM
  foreach ($rel in @("package.json", "cordis.patch.yml", "skill.md", "README.md", "LICENSE",
                     "THIRD-PARTY-NOTICES.md", "lib\index.js", "lib\client.js", "lib\mesh.js",
                     "data\README.md", "data\mesh_index.json", "data\mesh_build_report.txt",
                     "data\mesh_fixtures.json")) {
    $p = Join-Path $stage $rel
    if (-not (Test-Path $p)) { Fail "staging 缺少 $rel" }
    $b = [IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Fail "$rel 带 BOM" }
  }
  Ok "13 个文本文件均无 BOM"

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

  # 6) MeSH 索引必须随包，magic 正确，且与清单里的 sha256 对得上
  #    （索引缺失时插件会静默降级成纯翻译——用户会以为"术语功能没做"，所以宁可在打包时就拦下来）
  $meshBin = Join-Path $stage "data\mesh_index.bin"
  if (-not (Test-Path $meshBin)) { Fail "staging 缺少 data\mesh_index.bin（先跑 python mesh_build.py build，再把索引复制到 dsh-lit-translate\data）" }
  $meshBytes = (Get-Item $meshBin).Length
  if ($meshBytes -lt 50MB -or $meshBytes -gt 200MB) { Fail ("data\mesh_index.bin 大小异常：{0:N1} MiB" -f ($meshBytes / 1MB)) }
  $fs = [IO.File]::OpenRead($meshBin)
  $head = New-Object byte[] 8
  $null = $fs.Read($head, 0, 8)
  $fs.Close()
  $meshMagic = [Text.Encoding]::ASCII.GetString($head)
  if ($meshMagic -ne "MESHIDX1") { Fail "data\mesh_index.bin 的 magic 不是 MESHIDX1（读到 '$meshMagic'）" }
  $manifestText = [IO.File]::ReadAllText((Join-Path $stage "data\mesh_index.json"), [Text.UTF8Encoding]::new($false))
  $manifest = $manifestText | ConvertFrom-Json
  $entry = $manifest.files.PSObject.Properties['mesh_index.bin'].Value
  if (-not $entry) { Fail "data\mesh_index.json 里没有 mesh_index.bin 的条目" }
  if ([int64]$entry.bytes -ne $meshBytes) { Fail ("data\mesh_index.bin 与清单字节数不一致：清单 {0} / 实际 {1}" -f $entry.bytes, $meshBytes) }
  $gotHash = (Get-FileHash $meshBin -Algorithm SHA256).Hash.ToLower()
  if ($entry.sha256 -ne $gotHash) { Fail "data\mesh_index.bin 与 data\mesh_index.json 的 sha256 不一致（清单 $($entry.sha256) / 实际 $gotHash）" }
  Ok ("MeSH 索引 {0:N1} MiB，sha256 与清单一致（{1}…）" -f ($meshBytes / 1MB), $gotHash.Substring(0, 12))

  # 7) host 半必须真的用上术语层（免得改坏了看不出来）
  if ($hostText -notmatch "from './mesh.js'") { Fail "lib/index.js 没有引入 ./mesh.js" }
  if (-not (Test-Path (Join-Path $stage "lib\mesh.js"))) { Fail "staging 缺少 lib\mesh.js" }
  Ok "host 半已接入 MeSH 术语层"
}

# ---- 打包 ----
$tgz = Join-Path $root "dsh-lit-translate-$version.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }
& tar -czf $tgz -C $stageRoot package
if ($LASTEXITCODE -ne 0) { Fail "tar 失败" }

$tgzBytes = (Get-Item $tgz).Length
$meshMiB = (Get-Item (Join-Path $src "data\mesh_index.bin")).Length / 1MB
Ok ("tgz: {0}  ({1:N1} MiB，其中 MeSH 索引解包后 {2:N1} MiB)" -f (Split-Path $tgz -Leaf), ($tgzBytes / 1MB), $meshMiB)

# ---- 清理 staging ----
Remove-Item $stageRoot -Recurse -Force

Write-Host ""
Write-Host "安装（需在允许写入 profile 的会话中执行）："
Write-Host "  dsh plugin --profile web remove dsh-lit-translate"
Write-Host "  dsh plugin --profile web add file:$tgz"
Write-Host ""
Write-Host "自测：node test-lit-translate.mjs"
