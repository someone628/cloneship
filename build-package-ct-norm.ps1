# 打包 dsh-ct-norm 为可安装的 tgz。
#
# 骨架照抄 build-package-lit-translate.ps1，理由一样：手敲 staging + tar 序列容易出事，
# 尤其是 `Set-Content -Encoding UTF8` 在 Windows PowerShell 5.1 下会写出 BOM，
# 而 DSH 是 JSON.parse(readFileSync(pkg,'utf8'))，带 BOM 直接抛错。
#
# 本脚本额外多做一件别处没有的事：把「诚实性不变量」变成**打包期硬校验**。
# 这个插件的全部价值都建立在一条性质上——归一化结果里的每个 MeSH 编号都来自 NLM 索引，
# 不可能是人编的。如果这条在打包时不被检查，它迟早会被某次手改悄悄破坏。
#
# 用法：
#   pwsh -File build-package-ct-norm.ps1
#   pwsh -File build-package-ct-norm.ps1 -SkipChecks
#
# 注意：本文件含中文，**必须存为 UTF-8 with BOM**。
# Windows PowerShell 5.1 对无 BOM 的 .ps1 会按 GBK 解码，中文会乱掉并可能破坏字符串终止符。
#
# 压缩级别：Windows 自带 tar 是 bsdtar，不支持 GNU 的 `-I "gzip -9"`，故一律用 -czf。

param(
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$src = Join-Path $root "dsh-ct-norm"
$stageRoot = Join-Path $root ".pack-ct-norm"
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
Copy-Item (Join-Path $src "data") (Join-Path $stage "data") -Recurse -Force
Copy-Item (Join-Path $src "assets") (Join-Path $stage "assets") -Recurse -Force
# 构建脚本随包：data\README.md 让使用者跑 `node build-ct-lexicon.mjs` 复现产物，
# 脚本不随包的话那条说明就是空头支票。（它不依赖任何 npm 包，只读本地 MeSH 索引。）
Copy-Item (Join-Path $src "build-ct-lexicon.mjs") $stage -Force

$utf8 = [Text.UTF8Encoding]::new($false)

if (-not $SkipChecks) {
  # 1) 随包文本文件不得带 BOM
  $textFiles = @(
    "package.json", "cordis.patch.yml", "skill.md", "README.md", "LICENSE",
    "THIRD-PARTY-NOTICES.md", "build-ct-lexicon.mjs", "lib\index.js", "lib\client.js", "lib\mesh.js",
    "lib\lexicon.js", "lib\normalize.js", "lib\render.js", "lib\text.js",
    "data\README.md", "data\ct.rules.json", "data\ct.manifest.json"
  )
  foreach ($rel in $textFiles) {
    $p = Join-Path $stage $rel
    if (-not (Test-Path $p)) { Fail "staging 缺少 $rel" }
    $b = [IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Fail "$rel 带 BOM" }
  }
  Ok "$($textFiles.Count) 个文本文件均无 BOM"

  # 2) client 半必须声明在 package.json 里，否则面板不会加载
  if (-not $pkg.exports.'./client') { Fail "package.json 未声明 ./client 导出" }
  if ($pkg.dsh.client.platform -ne "web") { Fail "package.json 未声明 dsh.client.platform=web" }
  Ok "client 半声明完整"

  # 3) bundle patch 必须随包，且 id 和包名一致
  $patchText = [IO.File]::ReadAllText((Join-Path $stage "cordis.patch.yml"), $utf8)
  if ($patchText -notmatch 'id:\s*dsh-ct-norm') { Fail "cordis.patch.yml 里的 id 不是 dsh-ct-norm" }
  Ok "bundle patch id 正确"

  # 4) 两半的模块名必须一致，工具必须都注册上
  $hostText = [IO.File]::ReadAllText((Join-Path $stage "lib\index.js"), $utf8)
  $clientText = [IO.File]::ReadAllText((Join-Path $stage "lib\client.js"), $utf8)
  if ($hostText -notmatch "export const name = 'ct-norm'") { Fail "lib/index.js 的 name 不是 ct-norm" }
  if ($clientText -notmatch "id: 'dsh-ct-norm'") { Fail "lib/client.js 的模块 id 不是 dsh-ct-norm" }
  if ($hostText -notmatch "'ct_norm'") { Fail "lib/index.js 未注册 ct_norm 工具" }
  if ($hostText -notmatch "'ct_lexicon'") { Fail "lib/index.js 未注册 ct_lexicon 工具" }
  if ($clientText -notmatch "ct-norm/rpc") { Fail "lib/client.js 未指向 ct-norm 的 RPC 路由" }
  Ok "两半模块名一致，两个工具都已注册"

  # 5) 测试用的 node_modules 链接绝不能进包
  $junk = Get-ChildItem $stage -Recurse -Force -Directory -Filter "node_modules" -ErrorAction SilentlyContinue
  if ($junk) { Fail "staging 里混进了 node_modules（测试用的 junction）" }
  Ok "无 node_modules 混入"

  # 6) 图标必须是真 PNG
  $icon = Join-Path $stage "assets\icon.png"
  if (-not (Test-Path $icon)) { Fail "staging 缺少 assets\icon.png（先跑 build-icon-ct-norm.ps1）" }
  $ib = [IO.File]::ReadAllBytes($icon)
  if ($ib.Length -lt 100 -or $ib[0] -ne 0x89 -or $ib[1] -ne 0x50 -or $ib[2] -ne 0x4E -or $ib[3] -ne 0x47) {
    Fail "assets\icon.png 不是合法 PNG"
  }
  Ok ("图标 {0} 字节，PNG 头正确" -f $ib.Length)

  # 7) 构建产物必须齐、且与清单自洽
  $lex = Join-Path $stage "data\ct.lexicon.jsonl"
  $sub = Join-Path $stage "data\mesh.subset.jsonl"
  foreach ($p in @($lex, $sub)) {
    if (-not (Test-Path $p)) { Fail "staging 缺少 $(Split-Path $p -Leaf)（先跑 node build-ct-lexicon.mjs）" }
  }
  $manifest = [IO.File]::ReadAllText((Join-Path $stage "data\ct.manifest.json"), $utf8) | ConvertFrom-Json
  $lexLines = ([IO.File]::ReadAllLines($lex, $utf8) | Where-Object { $_.Trim() -ne "" }).Count
  $subLines = ([IO.File]::ReadAllLines($sub, $utf8) | Where-Object { $_.Trim() -ne "" }).Count
  if ($lexLines -ne [int]$manifest.counts.entries) {
    Fail ("词表行数 {0} 与清单 entries {1} 不一致（改了源词表没重跑 build-ct-lexicon.mjs？）" -f $lexLines, $manifest.counts.entries)
  }
  if ($subLines -ne [int]$manifest.counts.meshConcepts) {
    Fail ("MeSH 子集行数 {0} 与清单 meshConcepts {1} 不一致" -f $subLines, $manifest.counts.meshConcepts)
  }
  $rulesHash = (Get-FileHash (Join-Path $stage "data\ct.rules.json") -Algorithm SHA256).Hash.ToLower()
  if ($rulesHash -ne $manifest.rules.sha256) {
    Fail "ct.rules.json 的 sha256 与清单不一致（改了规则没重跑 build-ct-lexicon.mjs？）"
  }
  Ok ("词表 {0} 行 / MeSH 子集 {1} 行，规则指纹与清单一致" -f $lexLines, $subLines)

  # 8) 源词表要随包，且指纹与清单一致——别人才能复现这份产物
  foreach ($f in (Get-ChildItem (Join-Path $stage "data\src") -Filter "*.json")) {
    $key = $f.Name
    $entry = $manifest.sources.PSObject.Properties[$key]
    if (-not $entry) { Fail "manifest.sources 里没有 $key" }
    $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $entry.Value.sha256) { Fail "$key 的 sha256 与清单不一致" }
  }
  Ok "data\src 下 $((Get-ChildItem (Join-Path $stage "data\src") -Filter "*.json").Count) 个源文件指纹与清单一致"

  # 9) 诚实性不变量：源词表里不得出现手写 MeSH 编号
  #    编号只能由 build-ct-lexicon.mjs 从 NLM 索引反解。note 也随包分发并显示给用户，
  #    所以 note 里同样不允许手写编号——手写的错编号会和算出来的对编号混在一起。
  $viol = 0
  foreach ($f in (Get-ChildItem (Join-Path $stage "data\src") -Filter "*.json")) {
    $t = [IO.File]::ReadAllText($f.FullName, $utf8)
    $m = [regex]::Matches($t, '\bD\d{6,}\b')
    if ($m.Count -gt 0) {
      $viol += $m.Count
      Write-Host ("    !! {0} 里有手写 MeSH 编号：{1}" -f $f.Name, (($m | ForEach-Object { $_.Value } | Select-Object -First 5) -join ",")) -ForegroundColor Red
    }
  }
  if ($viol -gt 0) { Fail "源词表里出现 $viol 处手写 MeSH 编号——编号必须由构建脚本反解，不得手写" }
  Ok "源词表无手写 MeSH 编号（编号只能来自 NLM 索引）"

  # 10) host 半必须真的用上子集与词表，免得改坏了看不出来
  if ($hostText -notmatch "from './lexicon.js'") { Fail "lib/index.js 没有引入 ./lexicon.js" }
  if ($hostText -notmatch "from './normalize.js'") { Fail "lib/index.js 没有引入 ./normalize.js" }
  if (-not (Test-Path (Join-Path $stage "lib\text.js"))) { Fail "staging 缺少 lib\text.js" }
  $normText = [IO.File]::ReadAllText((Join-Path $stage "lib\normalize.js"), $utf8)
  if ($normText -notmatch "byUi") { Fail "lib/normalize.js 未从 MeSH 子集按编号取概念（编号来源不可控）" }
  Ok "host 半已接入词表 / 子集 / 归一化层"
}

# ---- 打包 ----
$tgz = Join-Path $root "dsh-ct-norm-$version.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }
& tar -czf $tgz -C $stageRoot package
if ($LASTEXITCODE -ne 0) { Fail "tar 失败" }

$tgzBytes = (Get-Item $tgz).Length
Ok ("tgz: {0}  ({1:N1} KiB)" -f (Split-Path $tgz -Leaf), ($tgzBytes / 1KB))

# ---- 清理 staging ----
Remove-Item $stageRoot -Recurse -Force

Write-Host ""
Write-Host "安装（需在允许写入 profile 的会话中执行）："
Write-Host "  dsh plugin --profile web remove dsh-ct-norm"
Write-Host "  dsh plugin --profile web add file:$tgz"
Write-Host ""
Write-Host "自测：node test-ct-norm.mjs"
