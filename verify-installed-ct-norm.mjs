/**
 * 验证「已安装到 profile 的那份插件」是否真的可用。
 *
 * 分两步：
 *   1. 把安装目录与工作区源目录逐文件比对 sha256——证明装上去的就是我测过的那份字节；
 *   2. **用安装目录里的 lib 与 data** 跑一遍归一化链路（lib/index.js 依赖 DSH 的
 *      @deepseek-ai/dsh-tools，无法在纯 node 下 import；但词表/子集/归一化/渲染都不依赖它），
 *      并与工作区版本的结果逐字节比对。
 *
 * 这样即使不重启 DSH，也能确认「装上去的那份」是好的；剩下只有"宿主何时加载"这一件事。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(ROOT, 'dsh-ct-norm')
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.ds-harness-desktop', 'dsh-home')
const INST = path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-ct-norm')

let checks = 0
const failures = []
const check = (cond, label) => { checks++; if (!cond) { failures.push(label); console.log('  FAIL ' + label) } }

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const walk = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(full, base, out)
    } else {
      out.push(path.relative(base, full))
    }
  }
  return out
}

console.log('[1] 安装目录 vs 工作区源目录：逐文件 sha256')
check(fs.existsSync(INST), `安装目录不存在：${INST}`)
const srcFiles = walk(SRC).sort()
const instFiles = walk(INST).sort()
const missing = srcFiles.filter((f) => !instFiles.includes(f))
const extra = instFiles.filter((f) => !srcFiles.includes(f))
check(missing.length === 0, `安装目录缺少：${missing.join(', ')}`)
check(extra.length === 0, `安装目录多出：${extra.join(', ')}`)
let diff = 0
for (const f of srcFiles) {
  if (!instFiles.includes(f)) continue
  if (sha(path.join(SRC, f)) !== sha(path.join(INST, f))) { diff++; console.log('  !! 字节不同：' + f) }
}
check(diff === 0, `${diff} 个文件与工作区源目录字节不一致（装上去的不是测过的那份）`)
console.log(`  ${srcFiles.length} 个文件全部一致`)

console.log('\n[2] 用安装目录里的 lib + data 跑一遍归一化链路')
const instLib = (name) => pathToFileURL(path.join(INST, 'lib', name)).href
const { loadLexicon } = await import(instLib('lexicon.js'))
const { loadMeshSubset } = await import(instLib('mesh.js'))
const { createNormalizer } = await import(instLib('normalize.js'))
const { renderReport, aggregateConcepts } = await import(instLib('render.js'))

const D = path.join(INST, 'data')
const iEntries = loadLexicon(path.join(D, 'ct.lexicon.jsonl'))
const iMesh = loadMeshSubset(path.join(D, 'mesh.subset.jsonl'))
const iRules = JSON.parse(fs.readFileSync(path.join(D, 'ct.rules.json'), 'utf8'))
const iManifest = JSON.parse(fs.readFileSync(path.join(D, 'ct.manifest.json'), 'utf8'))
const iNorm = createNormalizer({ entries: iEntries, meshSubset: iMesh, rules: iRules })
check(iEntries.length === iManifest.counts.entries, '安装副本：词表行数与清单不符')
check(iMesh.records.length === iManifest.counts.meshConcepts, '安装副本：MeSH 子集行数与清单不符')
console.log(`  载入 ${iEntries.length} 条条目 / ${iNorm.aliasCount} 个表面写法 / ${iMesh.records.length} 个 MeSH 概念`)

// 同一份报告，两条路径跑，结果必须逐字节一致
const REPORT = `检查技术：胸部CT平扫+增强扫描。
检查所见：
右肺上叶见一大小约2.3cm结节影，边缘毛糙，可见分叶，考虑周围型肺癌可能。
双肺另见多发小结节，较大者约5mm。
纵隔及右肺门见多发肿大淋巴结，最大短径约1.5cm。
右侧胸腔见少量积液，胸膜未见明显增厚。
肝内见多发低密度灶，考虑转移瘤可能；腹膜后未见肿大淋巴结。
所见骨质未见明确破坏征象。
诊断结论：右肺上叶结节，考虑周围型肺癌；肝内多发低密度灶，考虑转移瘤；双肺多发结节考虑转移。`

const iRes = iNorm.normalize(REPORT)
const iMeta = {
  version: iManifest.version, meshRelease: iManifest.mesh_release,
  entries: iEntries.length, aliases: iNorm.aliasCount, concepts: iMesh.records.length,
}
const iReport = renderReport(iRes, iMeta)

// 工作区版本
const { loadLexicon: wLoad } = await import(pathToFileURL(path.join(SRC, 'lib', 'lexicon.js')).href)
const { loadMeshSubset: wMesh } = await import(pathToFileURL(path.join(SRC, 'lib', 'mesh.js')).href)
const { createNormalizer: wNorm } = await import(pathToFileURL(path.join(SRC, 'lib', 'normalize.js')).href)
const { renderReport: wRender } = await import(pathToFileURL(path.join(SRC, 'lib', 'render.js')).href)
const wEntries = wLoad(path.join(SRC, 'data', 'ct.lexicon.jsonl'))
const wSubset = wMesh(path.join(SRC, 'data', 'mesh.subset.jsonl'))
const wRules = JSON.parse(fs.readFileSync(path.join(SRC, 'data', 'ct.rules.json'), 'utf8'))
const wNormalizer = wNorm({ entries: wEntries, meshSubset: wSubset, rules: wRules })
const wRes = wNormalizer.normalize(REPORT)
const wReport = wRender(wRes, iMeta)

check(JSON.stringify(iRes) === JSON.stringify(wRes), '安装副本与工作区版本的归一化结果不一致')
check(iReport === wReport, '安装副本与工作区版本的报告文本不一致')
check(iRes.integrityErrors.length === 0, `安装副本出现完整性错误：${iRes.integrityErrors.join('；')}`)

// 安装副本产出的每个编号都必须在其子集里
const bad = iRes.entities.flatMap((e) => e.concepts.map((c) => c.ui)).filter((ui) => !iMesh.byUi.has(ui))
check(bad.length === 0, `安装副本产出了子集之外的编号：${bad.join(',')}`)

console.log('  实体 ' + iRes.stats.entities + '，概念 ' + iRes.stats.concepts +
  '，未归一化 ' + iRes.stats.unmapped + '，否定 ' + iRes.stats.negated + '，可疑 ' + iRes.stats.uncertain)
console.log('  报告长度 ' + iReport.length + ' 字符，与工作区版本逐字节一致')
console.log('  概念汇总：' + aggregateConcepts(iRes).map((c) => c.name + '(' + c.ui + ')×' + c.count).join('、'))

console.log('\n' + '='.repeat(64))
if (failures.length === 0) console.log(`安装副本验证通过：${checks} 项检查`)
else {
  console.log(`${checks - failures.length}/${checks} 通过，失败：`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
