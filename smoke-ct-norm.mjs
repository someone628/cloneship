// 冒烟测试：拿一段真实风格的中文 CT 报告跑一遍，看抽取、归一化与渲染是否讲得通
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { loadLexicon } from './dsh-ct-norm/lib/lexicon.js'
import { loadMeshSubset } from './dsh-ct-norm/lib/mesh.js'
import { createNormalizer } from './dsh-ct-norm/lib/normalize.js'
import { renderReport } from './dsh-ct-norm/lib/render.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const P = path.join(ROOT, 'dsh-ct-norm', 'data')
const entries = loadLexicon(path.join(P, 'ct.lexicon.jsonl'))
const meshSubset = loadMeshSubset(path.join(P, 'mesh.subset.jsonl'))
const rules = JSON.parse(fs.readFileSync(path.join(P, 'ct.rules.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(P, 'ct.manifest.json'), 'utf8'))

const n = createNormalizer({ entries, meshSubset, rules })

const REPORT = `检查技术：胸部CT平扫+增强扫描。
检查所见：
右肺上叶见一大小约2.3cm结节影，边缘毛糙，可见分叶，考虑周围型肺癌可能。
双肺另见多发小结节，较大者约5mm。
纵隔及右肺门见多发肿大淋巴结，最大短径约1.5cm。
右侧胸腔见少量积液，胸膜未见明显增厚。
肝内见多发低密度灶，考虑转移瘤可能；腹膜后未见肿大淋巴结。
所见骨质未见明确破坏征象。
诊断意见：
1. 右肺上叶结节，考虑周围型肺癌；
2. 双肺多发结节，考虑转移瘤可能；
3. 纵隔及右肺门淋巴结肿大；
4. 右侧胸腔少量积液；
5. 肝内多发低密度灶，考虑转移瘤。`

const r = n.normalize(REPORT)
console.log('########## ct_norm 工具的渲染输出 ##########\n')
console.log(renderReport(r, {
  version: manifest.version,
  meshRelease: manifest.mesh_release,
  entries: entries.length,
  aliases: n.aliasCount,
  concepts: meshSubset.records.length,
}))
console.log('\n########## 结构化 stats ##########')
console.log(JSON.stringify(r.stats, null, 2))
if (r.integrityErrors.length) console.log('!! integrityErrors', r.integrityErrors)
