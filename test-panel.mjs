/**
 * dsh-onco-lexicon —— host 半的端到端测试：
 * 用真实的合并词典跑 apply()，再用假的 req/res 调用面板 HTTP 路由（RPC + 图标）。
 */
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { apply } from './dsh-onco-lexicon/lib/index.js'

// 导出目录指到工作区内：默认会写用户 Downloads，测试不该往那儿丢文件
const EXPORT_DIR = fileURLToPath(new URL('./.test-export/', import.meta.url))
rmSync(EXPORT_DIR, { recursive: true, force: true })
mkdirSync(EXPORT_DIR, { recursive: true })
process.env.ONCO_LEXICON_EXPORT_DIR = EXPORT_DIR

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}

const tools = []
const sections = []
const routes = []
let route = null

const mockCtx = {
  logger: { info: (m) => console.log('  [log]', m) },
  tools: { register: (t) => tools.push(t) },
  systemPrompt: { section: (s) => sections.push(s) },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get: () => undefined,
  effect: (fn) => fn(),
}

console.log('[1] apply()（加载 185,885 条合并词典）')
const t0 = Date.now()
apply(mockCtx, {})
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s`)
const m = process.memoryUsage()
console.log(`  内存 rss ${(m.rss / 2 ** 20).toFixed(0)} MB  heapUsed ${(m.heapUsed / 2 ** 20).toFixed(0)} MB`)
check(tools.length === 4, `应注册 4 个工具（term/abbr/browse/translate），实际 ${tools.length}`)
check(sections.length === 1, '应注入 1 段系统提示词')
check(routes.length === 2, `应注册 2 条路由（RPC + 图标），实际 ${routes.length}`)
route = routes.find((r) => r.path === '/dsh-onco-lexicon/rpc')
check(!!route, 'RPC 路由未注册')
check(routes.some((r) => r.path === '/dsh-onco-lexicon/icon.png'), '图标路由未注册')

/** 直接调用某条路由，返回原始响应体（图标是二进制，不能 JSON.parse） */
function callRoute(target, method = 'GET', raw = '') {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      method,
      setEncoding() {},
      destroy() {},
      on(ev, cb) { handlers[ev] = cb; return this },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
      end(body) { resolve({ status: res.statusCode, headers: res.headers, body }) },
    }
    const pending = target.handler(req, res)
    if (handlers.data) handlers.data(raw)
    if (handlers.end) handlers.end()
    pending.catch(reject)
  })
}

/**
 * 调一次 RPC。handler 是 async：其同步段会在第一个 await 前调用 readBody()，
 * 从而同步注册好 data/end 监听器。所以在调用后必须**立即**投喂数据；
 * 若放进 .then() 就会死锁——handler 等 body，而 body 等 handler 结束。
 */
async function call(payload) {
  const r = await callRoute(route, 'POST', JSON.stringify(payload))
  return { status: r.status, body: JSON.parse(r.body) }
}

console.log('[2] RPC: stats')
const stats = await call({ op: 'stats' })
console.log(`  ok=${stats.body.ok}  total=${stats.body.total}  词典=${stats.body.dictLabel}`)
check(stats.body.ok === true, 'stats 未成功')
check(stats.body.total === 185885, `总数应为 185,885（合并后），实际 ${stats.body.total}`)

console.log('[3] RPC: search —— 中文（靠回填的 zh）')
const zh = await call({ op: 'search', args: { q: '非小细胞肺癌', limit: 5 } })
for (const x of zh.body.hits || []) console.log(`  ${x.score}  ${x.id}  ${x.en}  via=${x.via}`)
check((zh.body.hits || []).length > 0, '中文查询「非小细胞肺癌」无命中（回填 zh 未生效）')
check((zh.body.hits || []).some((x) => x.id === 'ncit:c2926'), '未命中 ncit:c2926（NCIt 侧中文未生效）')

// 合并后的关键性质：同一概念只应有一条，且自建库字段已并入 NCIt 条目
console.log('[3b] 合并校验：概念唯一 + 自建库字段已并入')
const nsclcHits = (zh.body.hits || []).filter((x) => x.id === 'ncit:c2926' || x.id === 'onco:nsclc')
check(nsclcHits.length === 1, `同一概念应只有 1 条，实际 ${nsclcHits.length} 条`)
check(!(zh.body.hits || []).some((x) => x.id === 'onco:nsclc'), 'onco:nsclc 仍作为重复条目存在（未真正合并）')
const merged = (zh.body.hits || []).find((x) => x.id === 'ncit:c2926')
if (merged) {
  check(merged.zh === '非小细胞肺癌', `合并条目缺少中文名，实际 ${merged.zh}`)
  check((merged.abbr || []).includes('NSCLC'), '合并条目缺少自建库缩写 NSCLC')
  check((merged.codes || {}).mesh === 'D002289', '合并条目缺少自建库 MeSH 编码')
  check(merged.category === 'disease', `类别应采用自建库的人工整理值，实际 ${merged.category}`)
  check(/[\u4e00-\u9fff]/.test(merged.def || ''), '合并条目的释义里没有中文（中文释义未并入）')
  check(/\n\n/.test(merged.def || ''), '中英释义未分段（应中文在前、空行、英文在后）')
  check((merged.aliases || []).some((a) => a.toLowerCase() === 'non-small cell lung carcinoma'),
    '自建库的旧英文名未并入 aliases（旧叫法会搜不到）')
}

console.log('[3c] 外部编码可直接检索')
const bare = await call({ op: 'search', args: { q: 'D002289', limit: 3 } })
console.log(`  裸码 D002289        -> ${(bare.body.hits || []).map((x) => x.id).join(', ') || '(无)'}`)
check((bare.body.hits || []).some((x) => x.id === 'ncit:c2926'), '裸 MeSH 码 D002289 查不到 ncit:c2926')
const ns = await call({ op: 'search', args: { q: 'mesh:D002289', limit: 3 } })
console.log(`  带词表前缀          -> ${(ns.body.hits || []).map((x) => x.id).join(', ') || '(无)'}`)
check((ns.body.hits || []).some((x) => x.id === 'ncit:c2926'), '带词表前缀 mesh:D002289 查不到 ncit:c2926')
const upper = await call({ op: 'search', args: { q: 'MESH:D002289', limit: 3 } })
check((upper.body.hits || []).some((x) => x.id === 'ncit:c2926'), '大写 MESH:D002289 查不到（大小写未归一）')
const missCode = await call({ op: 'search', args: { q: 'D999999', limit: 3 } })
console.log(`  不存在的编码        -> ${(missCode.body.hits || []).length} 条`)
check((missCode.body.hits || []).length === 0, '不存在的编码竟有命中')

console.log('[3d] 分类与出处筛查')
const catFiltered = await call({ op: 'search', args: { q: '肺癌', limit: 20, category: 'drug' } })
console.log(`  肺癌 + 类别=drug   -> ${(catFiltered.body.hits || []).length} 条`)
check((catFiltered.body.hits || []).every((x) => x.category === 'drug'), '类别筛查未生效（混入其他类别）')

const srcSeed = await call({ op: 'search', args: { q: '肺癌', limit: 20, source: '自建库' } })
console.log(`  肺癌 + 出处=自建库 -> ${(srcSeed.body.hits || []).map((x) => x.id).join(', ') || '(无)'}`)
check((srcSeed.body.hits || []).length > 0, '按自建库筛查无结果')
check((srcSeed.body.hits || []).every((x) => (x.sources || []).includes('自建库')), '出处筛查未生效')

const srcNcit = await call({ op: 'search', args: { q: '非小细胞肺癌', limit: 5, source: 'NCIt' } })
check((srcNcit.body.hits || []).some((x) => x.id === 'ncit:c2926'),
  '合并条目应同时属于 NCIt 出处（sources 是数组，不是二选一）')

// 筛查必须在候选环节生效：否则 topK 会被不符条件的条目占满。
// 用「类别=drug + 查肺癌」这种基本没有交集的条件来验：应当干净地返回 0 条，
// 而不是返回几条被事后过滤剩下的残渣。
check((catFiltered.body.hits || []).length === 0, `类别=drug 查肺癌应无交集，实际 ${(catFiltered.body.hits || []).length} 条`)

const browseSeed = await call({ op: 'browse', args: { source: '自建库', limit: 200 } })
const seedEntries = browseSeed.body.entries || []
console.log(`  浏览 + 出处=自建库 -> ${seedEntries.length} 条`)
check(seedEntries.length === 106, `自建库条目应为 106（101 合并 + 5 独立），实际 ${seedEntries.length}`)
check(seedEntries.every((e) => (e.sources || []).includes('自建库')), '浏览的出处筛查未生效')

const catBrowse = await call({ op: 'browse', args: { category: 'endpoint', limit: 100 } })
check((catBrowse.body.entries || []).every((e) => e.category === 'endpoint'), '浏览的类别筛查未生效')

const noCatBrowse = await call({ op: 'browse', args: { limit: 5 } })
check((noCatBrowse.body.entries || []).length === 5, '不给类别时应能浏览全部类别')
check(noCatBrowse.body.ok === true, '不给类别时不应报错')

check(stats.body.bySource && stats.body.bySource['自建库'] === 106,
  `stats.bySource 自建库应为 106，实际 ${JSON.stringify(stats.body.bySource)}`)
check(stats.body.bySource && stats.body.bySource['NCIt'] === 185880,
  `stats.bySource NCIt 应为 185,880，实际 ${stats.body.bySource && stats.body.bySource['NCIt']}`)

console.log('[3e] 工具层的筛查')
const termTool = tools.find((t) => t.name === 'onco_term')
const browseTool = tools.find((t) => t.name === 'onco_browse')
const abbrTool = tools.find((t) => t.name === 'onco_abbr')
check(!!termTool && !!browseTool && !!abbrTool, '工具未注册齐')
const drugTerm = await termTool.execute({ term: '肺癌', category: 'drug', topK: 5 })
check(String(drugTerm).includes('已按'), 'onco_term 未回显筛查条件')
check(String(drugTerm).includes('类别=抗肿瘤药物'), 'onco_term 筛查条件回显不对')
const seedBrowse = await browseTool.execute({ source: '自建库', limit: 5 })
check(String(seedBrowse).includes('出处=自建库'), 'onco_browse 未支持出处筛查')
const srcAbbr = await abbrTool.execute({ abbr: 'MM', source: '自建库' })
check(String(srcAbbr).includes('出处=自建库'), 'onco_abbr 未支持出处筛查')
// 工具的文本输出不含 id，只能按名称断言
check(String(srcAbbr).includes('多发性骨髓瘤') && String(srcAbbr).includes('黑色素瘤'),
  'onco_abbr 按自建库筛查后应命中多发性骨髓瘤与黑色素瘤')
// 出处筛查要真的把不属于自建库的义项挡掉：结果数必须明显少于不过滤时
const allAbbr = await abbrTool.execute({ abbr: 'MM', topK: 50 })
const lines = (s) => String(s).split('\n').filter((l) => /^\d+\. /.test(l)).length
console.log(`  MM 义项：不过滤 ${lines(allAbbr)} 条，仅自建库 ${lines(srcAbbr)} 条`)
check(lines(srcAbbr) < lines(allAbbr), '按自建库筛查后义项数没有减少（筛查未生效）')
check(lines(srcAbbr) >= 2, '按自建库筛查后应仍有两个义项（多发性骨髓瘤 / 黑色素瘤）')

console.log('[3f] 类别精准 + NCIt 语义类型精确筛查')
// 语义类型是权威维度，覆盖面远大于 7 个粗类别
const typeCount = stats.body.byType ? Object.keys(stats.body.byType).length : 0
console.log(`  stats.byType 类型数: ${typeCount}`)
check(typeCount > 100, `stats.byType 应有 100+ 种类型，实际 ${typeCount}`)
check(stats.body.byType && stats.body.byType['Neoplastic Process'] > 10000,
  'Neoplastic Process 计数异常')

const neo = await call({ op: 'search', args: { q: 'carcinoma', limit: 20, type: 'Neoplastic Process' } })
console.log(`  carcinoma + Neoplastic Process -> ${(neo.body.hits || []).length} 条`)
check((neo.body.hits || []).length > 0, '按 Neoplastic Process 筛查无结果')
check((neo.body.hits || []).every((x) => (x.types || []).includes('Neoplastic Process')),
  '语义类型筛查未生效（混入其他类型）')

const pharm = await call({ op: 'search', args: { q: 'carcinoma', limit: 20, type: 'Pharmacologic Substance' } })
check((pharm.body.hits || []).every((x) => (x.types || []).includes('Pharmacologic Substance')),
  'Pharmacologic Substance 筛查未生效')

// 粗类别与精确类型可叠加
const combo = await call({
  op: 'search', args: { q: 'carcinoma', limit: 20, category: 'disease', type: 'Neoplastic Process' },
})
check(
  (combo.body.hits || []).every((x) => x.category === 'disease' && (x.types || []).includes('Neoplastic Process')),
  '类别 + 类型叠加筛查未生效',
)
const impossible = await call({ op: 'search', args: { q: 'carcinoma', limit: 20, category: 'drug', type: 'Neoplastic Process' } })
check((impossible.body.hits || []).length === 0, 'drug + Neoplastic Process 应无交集')

// 这条是「正则被判错」的典型：名字里有 Drug，实际是量表条目
const scale = await call({ op: 'search', args: { q: 'SOAPP-R - Others Suggested Drug or Alcohol Problem', limit: 3 } })
const scaleHit = (scale.body.hits || [])[0]
console.log(`  量表条目 -> category=${scaleHit && scaleHit.category}  types=${JSON.stringify(scaleHit && scaleHit.types)}`)
check(scaleHit && scaleHit.category === 'concept',
  `量表条目应归 concept（名称正则曾误判为 drug），实际 ${scaleHit && scaleHit.category}`)
check(scaleHit && (scaleHit.types || []).includes('Intellectual Product'), '量表条目应带 Intellectual Product 类型')

// 分类准确性抽查：药 / 病 / 靶点 / 疗法
const expect = {
  Cisplatin: 'drug', Gefitinib: 'drug', Osimertinib: 'drug',
  'Breast Carcinoma': 'disease', Melanoma: 'disease',
  'Epidermal Growth Factor Receptor': 'biomarker', 'KRAS Gene': 'biomarker',
  'Immunohistochemistry Staining Method': 'method', 'Adjuvant Therapy': 'treatment',
}
let wrong = 0
for (const [name, want] of Object.entries(expect)) {
  const r = await call({ op: 'search', args: { q: name, limit: 1 } })
  const top = (r.body.hits || [])[0]
  const ok = top && top.category === want
  if (!ok) {
    wrong++
    console.log(`    !! ${name}: ${top && top.category}（期望 ${want}）`)
  }
}
check(wrong === 0, `${wrong} 个常见词条的类别不符（药/病/靶点/疗法抽查）`)
console.log(`  常见词条类别抽查 ${Object.keys(expect).length} 项，不符 ${wrong} 项`)

// 工具层也支持 ncitType
const typedTool = await termTool.execute({ term: 'carcinoma', ncitType: 'Neoplastic Process', topK: 3 })
check(String(typedTool).includes('类型=Neoplastic Process'), 'onco_term 未支持 ncitType 筛查')

console.log('[3g] 术语模糊检索')
// "cisplatni" 是 "cisplatin" 的字母换位，编辑距离 2，正好落在模糊阈值内
const exactOnly = await call({ op: 'search', args: { q: 'cisplatni', limit: 5 } })
const withFuzzy = await call({ op: 'search', args: { q: 'cisplatni', limit: 5, fuzzy: true } })
console.log(`  cisplatni：默认 ${(exactOnly.body.hits || []).length} 条，开模糊 ${(withFuzzy.body.hits || []).length} 条`)
check((withFuzzy.body.hits || []).length > 0, '开启模糊后仍无结果')
check((withFuzzy.body.hits || []).some((x) => /cisplatin/i.test(x.en)),
  '模糊检索未找回 Cisplatin')
check((withFuzzy.body.hits || []).some((x) => String(x.via).includes('模糊')),
  '模糊命中的 via 未标明是模糊匹配')
check(withFuzzy.body.fuzzy === true, '响应未回显 fuzzy 标志')

console.log('[3h] 术语关联推荐')
// ncit:c4878 = Lung Carcinoma（注意不是 Breast Carcinoma，那是 c4872）
const rel = await call({ op: 'related', args: { id: 'ncit:c4878', limit: 8 } })
console.log(`  ${rel.body.seed && rel.body.seed.en}: 上位 ${(rel.body.parents || []).length} / 下位 ${(rel.body.children || []).length} / 近似 ${(rel.body.similar || []).length}`)
check(rel.body.ok === true, `related 失败：${rel.body.error}`)
check(rel.body.seed && rel.body.seed.en === 'Lung Carcinoma', `种子词条不对：${rel.body.seed && rel.body.seed.en}`)
check((rel.body.children || []).length > 0, 'Lung Carcinoma 应能反查出下位概念')
check((rel.body.similar || []).length > 0, '应给出名称近似的术语')
const childNames = (rel.body.children || []).map((c) => c.en)
console.log('  下位示例:', JSON.stringify(childNames.slice(0, 3)))
// 下位概念自带的 parents 里必须真的含本词条（这一步直接验数据，不依赖检索的 top-1）
const badChild = (rel.body.children || []).find(
  (c) => !(c.parents || []).some((p) => p.toLowerCase() === 'lung carcinoma'),
)
check(!badChild, `下位概念 ${badChild && badChild.en} 的 parents 里没有 Lung Carcinoma`)
// 上位概念必须来自本词条自己的 parents
const seedParents = (rel.body.seed && rel.body.seed.parents) || []
check(
  (rel.body.parents || []).every((p) => seedParents.some((sp) => sp.toLowerCase() === String(p.en).toLowerCase())),
  '上位概念与词条自身的 parents 不一致',
)
console.log('  上位:', JSON.stringify((rel.body.parents || []).map((p) => p.en)))
// 近似度必须单调不增
const sims = (rel.body.similar || []).map((s) => s.score)
check(sims.every((v, i) => i === 0 || sims[i - 1] >= v), '近似推荐未按相似度降序')
// 关联结果不应包含自身
const allIds = [
  ...(rel.body.parents || []), ...(rel.body.children || []), ...(rel.body.similar || []),
].map((x) => x.id)
check(!allIds.includes('ncit:c4878'), '关联结果不应包含自身')
check(new Set(allIds).size === allIds.length, '关联结果不应重复出现同一词条')
const badRel = await call({ op: 'related', args: { id: 'ncit:不存在' } })
check(badRel.body.ok === false, '未知 id 的关联查询应报错')

console.log('[3k] 翻译对照（词典式，非机器翻译）')
{
  // 单术语 中→英
  const t1 = await call({ op: 'translate', args: { text: '非小细胞肺癌' } })
  const b1 = t1.body
  console.log(`  「非小细胞肺癌」-> ${b1.direction}  primary=${b1.primary && b1.primary.en}`)
  check(b1.ok === true, `translate 失败：${b1.error}`)
  check(b1.direction === 'zh2en', `中文应判为中→英，实际 ${b1.direction}`)
  check(b1.terms.length === 1, `单术语应只有 1 个命中，实际 ${b1.terms.length}`)
  check(b1.terms[0] && b1.terms[0].en === 'Lung Non-Small Cell Carcinoma', '未给出英文标准名')
  check(b1.terms[0] && b1.terms[0].missing === false, '该词条有英文名，不应标记 missing')
  check(b1.primary && b1.primary.id === 'ncit:c2926', '最相近词条不对')
  check(b1.stats.coverage === 1, `整段都是术语时覆盖率应为 1，实际 ${b1.stats.coverage}`)

  // 缩写 英→中：NSCLC 应给出中文名
  const t2 = await call({ op: 'translate', args: { text: 'NSCLC' } })
  const b2 = t2.body
  console.log(`  「NSCLC」-> ${b2.direction}  ${b2.terms[0] && b2.terms[0].zh}`)
  check(b2.direction === 'en2zh', '纯英文应判为英→中')
  check(b2.terms.length === 1 && b2.terms[0].zh === '非小细胞肺癌', 'NSCLC 未给出中文名')

  // 中文长句：两个术语都要标出来
  const t3 = await call({ op: 'translate', args: { text: '非小细胞肺癌患者接受顺铂治疗' } })
  const b3 = t3.body
  const names3 = b3.terms.map((x) => x.en).sort()
  console.log(`  中文长句 -> ${b3.stats.distinctTerms} 个术语，覆盖 ${(b3.stats.coverage * 100).toFixed(0)}%：${names3.join(' / ')}`)
  check(b3.stats.distinctTerms === 2, `中文长句应命中 2 个术语，实际 ${b3.stats.distinctTerms}`)
  check(names3.includes('Cisplatin'), '未标出「顺铂」')
  check(b3.terms.every((x) => x.surface), '术语缺少原文写法 surface')
  // 未命中的部分必须原样保留，一处都不能丢
  const rebuilt = b3.segments.map((s) => s.text).join('')
  check(rebuilt === '非小细胞肺癌患者接受顺铂治疗', `分段拼接后与原文不一致：${rebuilt}`)

  // 英文长句：可对照的术语高亮，通用词标记为缺中文名
  const en = 'Patients with advanced non-small cell lung cancer received cisplatin and pembrolizumab.'
  const t4 = await call({ op: 'translate', args: { text: en } })
  const b4 = t4.body
  console.log(`  英文长句 -> ${b4.stats.spans} 处 / ${b4.stats.distinctTerms} 个术语，其中可对照 ${b4.stats.translatedTerms}、缺中文名 ${b4.stats.missingTerms}`)
  check(b4.direction === 'en2zh', '英文长句应判为英→中')
  check(b4.terms.some((x) => x.zh === '非小细胞肺癌'), '未标出 non-small cell lung cancer 的中文名')
  check(b4.terms.some((x) => x.zh === '顺铂'), '未标出 cisplatin 的中文名')
  check(b4.stats.translatedTerms >= 2, `可对照术语数异常：${b4.stats.translatedTerms}`)
  // And / With 这类通用词会被 NCIt 收录，必须如实标成「无中文名」而不是编个中文
  check(b4.stats.missingTerms > 0, '英文通用词应被标记为无中文名')
  const noZh = b4.terms.filter((x) => x.missing)
  check(noZh.every((x) => x.zh === null), '标记 missing 的术语不该带中文名')
  check(b4.terms.every((x) => !x.missing || x.en), '标记 missing 的术语仍应保留英文名')
  check(b4.segments.map((s) => s.text).join('') === en, '英文长句分段拼接后与原文不一致')
  check((b4.notes || []).some((n) => n.includes('不是机器翻译')), '缺少「不是机器翻译」的说明')
  check((b4.notes || []).some((n) => n.includes('没有中文名')), '缺少中文覆盖不足的说明')

  // 手动指定方向
  const t5 = await call({ op: 'translate', args: { text: 'Lung Carcinoma', direction: 'en2zh' } })
  check(t5.body.direction === 'en2zh', '手动指定的方向未生效')
  check(t5.body.terms[0] && t5.body.terms[0].missing === true,
    'Lung Carcinoma 在词典里没有中文名，应标记 missing 而不是编一个')
  const t5b = await call({ op: 'translate', args: { text: 'Lung Carcinoma', direction: 'zh2en' } })
  check(t5b.body.direction === 'zh2en', '手动指定中→英未生效')
  check(t5b.body.terms[0] && t5b.body.terms[0].missing === false, '中→英时该词条有英文名')

  // 假命中回归：这条查询曾被「反向包含」规则打出 615 分（XY Genotype），越过 MIN_SCORE
  const t6 = await call({ op: 'translate', args: { text: '完全不存在的术语xyz' } })
  console.log(`  生造词 -> 命中 ${t6.body.stats.spans} 处，primary=${t6.body.primary && t6.body.primary.en}`)
  check(t6.body.stats.spans === 0, `生造词不该命中任何术语，实际 ${t6.body.stats.spans}`)
  check(t6.body.primary === null, `生造词不该给出「最相近词条」，实际 ${t6.body.primary && t6.body.primary.en}`)
  const s6 = await call({ op: 'search', args: { q: '完全不存在的术语xyz' } })
  check((s6.body.hits || []).length === 0, 'search 对生造词仍返回假命中')
  check((t6.body.notes || []).some((n) => n.includes('未命中')), '中文未命中时应如实说明')

  // 词边界：既不能在拉丁词中间起止，也不能把中文旁边的术语漏掉
  const t7 = await call({ op: 'translate', args: { text: 'her2neu' } })
  check(t7.body.stats.spans === 0, `"her2neu" 不该被拆出 her2，实际命中 ${t7.body.stats.spans}`)
  const t8 = await call({ op: 'translate', args: { text: 'her2阳性' } })
  console.log(`  "her2阳性" -> 命中 ${t8.body.terms.map((x) => x.surface).join(',')}`)
  check(t8.body.stats.spans === 1, `"her2阳性" 应命中 her2，实际 ${t8.body.stats.spans}`)
  check(t8.body.terms[0] && t8.body.terms[0].key === 'her2', '命中的应是 her2')

  // 空文本与超长文本
  const t9 = await call({ op: 'translate', args: { text: '   ' } })
  check(t9.body.ok === false, '空白文本应报错')
  const t10 = await call({ op: 'translate', args: { text: 'x'.repeat(20001) } })
  check(t10.body.ok === false, '超长文本应报错')

  // 工具层
  const trTool = tools.find((t) => t.name === 'onco_translate')
  check(!!trTool, '未注册 onco_translate 工具')
  if (trTool) {
    const out1 = String(await trTool.execute({ text: '非小细胞肺癌' }))
    console.log('  onco_translate 片段:', out1.split('\n').slice(0, 2).join(' | '))
    check(out1.includes('中→英'), '工具输出未标明方向')
    check(out1.includes('Lung Non-Small Cell Carcinoma'), '工具输出未给出英文标准名')
    check(out1.includes('不是机器翻译'), '工具输出未声明这不是机器翻译')
    const out2 = String(await trTool.execute({ text: 'NSCLC', direction: 'en2zh' }))
    check(out2.includes('非小细胞肺癌'), '工具未给出中文名')
    const out3 = String(await trTool.execute({ text: 'Patients with non-small cell lung cancer' }))
    check(out3.includes('[['), '短文本应额外给出逐词对照（[[ ]] 标记）')
  }
}

console.log('[3i] 性能统计')
const perf = await call({ op: 'perf' })
const p = perf.body
console.log(`  加载 ${p.loadMs} ms | 词条 ${p.index.docs} | 词项 ${p.index.terms} | postings ${p.index.postings}`)
console.log(`  内存 rss ${(p.memory.rss / 2 ** 20).toFixed(0)} MB | 查询 ${p.queries.count} 次，均 ${p.queries.avgMs.toFixed(2)} ms，p95 ${p.queries.p95Ms.toFixed(2)} ms`)
check(p.ok === true, 'perf 失败')
check(p.index.docs === 185885, `perf 词条数不对：${p.index.docs}`)
// 注意：插件只对 en/zh/abbr/aliases/codes 建键，不像 Python 侧那样把 def 也纳入分词，
// 所以词项数约 14 万，而不是 Python 索引的 67 万。别把两边的量级搞混。
check(p.index.terms > 100000, `perf 词项数异常：${p.index.terms}`)
check(p.index.postings > 1000000, `perf postings 异常：${p.index.postings}`)
check(p.loadMs > 0 && p.loadMs < 60000, `perf 加载耗时异常：${p.loadMs}`)
check(p.dictBytes > 50 * 2 ** 20, `perf 词典体积异常：${p.dictBytes}`)
check(p.memory.rss > 100 * 2 ** 20, 'perf 内存读数异常')
check(p.queries.count > 0, 'perf 应已累计到查询次数')
check(p.queries.p95Ms >= p.queries.avgMs * 0.5, 'perf 分位数明显不合理')
check(typeof p.queries.lastMs === 'number', 'perf 缺少最近一次耗时')
check(p.index.typeCount > 100, `perf 类型数异常：${p.index.typeCount}`)
check(p.process && /^v\d/.test(p.process.node), 'perf 缺少 node 版本')

console.log('[3j] 导出为 TXT')
const exportPayload = '术语\t类别\n非小细胞肺癌\t疾病\n'
const exp = await call({ op: 'export', args: { text: exportPayload, name: 'onco-test.txt' } })
console.log(`  导出 -> ${exp.body.path}（${exp.body.bytes} 字节）`)
check(exp.body.ok === true, `导出失败：${exp.body.error}`)
if (exp.body.ok) {
  const written = readFileSync(exp.body.path)
  check(existsSync(exp.body.path), '导出文件不存在')
  // 必须带 UTF-8 BOM，否则 Windows 记事本会把中文显示成乱码
  check(written[0] === 0xef && written[1] === 0xbb && written[2] === 0xbf, '导出文件缺少 UTF-8 BOM')
  const body = written.slice(3).toString('utf8')
  check(body.includes('非小细胞肺癌'), '导出内容丢失中文')
  check(body === exportPayload, '导出内容与传入不一致')
}
// 文件名里的非法字符要被替换，且最终必须落在导出目录内。
// 注意比较时要先 resolve：EXPORT_DIR 由 fileURLToPath 得来会带尾部反斜杠，
// 而 dirname() 不带，直接字符串比较必然不等。
const sameDir = (p) => dirname(resolve(p)) === resolve(EXPORT_DIR)
const evil = await call({ op: 'export', args: { text: 'x', name: '../../evil.txt' } })
check(evil.body.ok === true, '非法文件名的导出不应直接失败')
if (evil.body.ok) {
  console.log(`  非法名 -> ${evil.body.path}`)
  check(sameDir(evil.body.path), `导出不应跳出目录：${evil.body.path}`)
}
// 恰好叫 ".." 的文件名最危险：path.join(dir,'..') 会跳到上级目录
const dotdot = await call({ op: 'export', args: { text: 'x', name: '..' } })
check(dotdot.body.ok === true, 'name=".." 的导出不应失败')
if (dotdot.body.ok) {
  console.log(`  ".."   -> ${dotdot.body.path}`)
  check(sameDir(dotdot.body.path), `name=".." 跳出了导出目录：${dotdot.body.path}`)
}
const emptyExp = await call({ op: 'export', args: { text: '' } })
check(emptyExp.body.ok === false, '空内容导出应报错')

console.log('[4] RPC: search —— 英文缩写（def 同义词位）')
const en = await call({ op: 'search', args: { q: 'TIMIFLOW', limit: 3 } })
for (const x of en.body.hits || []) console.log(`  ${x.score}  ${x.id}  ${x.en}`)
check((en.body.hits || []).some((x) => x.id === 'ncit:c100021'), 'TIMIFLOW 未命中 ncit:c100021')

console.log('[5] RPC: abbr —— 歧义')
const ab = await call({ op: 'abbr', args: { q: 'MM' } })
console.log(`  MM -> ${(ab.body.hits || []).map((x) => x.id).join(', ')}`)
check((ab.body.hits || []).length >= 2, 'MM 应返回多个义项')

console.log('[6] RPC: browse')
const br = await call({ op: 'browse', args: { category: 'drug', limit: 5 } })
console.log(`  drug -> ${(br.body.entries || []).length} 条`)
check((br.body.entries || []).length === 5, 'browse 未按 limit 返回')
check((br.body.entries || []).every((e) => e.category === 'drug'), 'browse 混入其他类别')

console.log('[7] RPC: 错误处理')
const badOp = await call({ op: 'nope' })
check(badOp.body.ok === false, '未知 op 应返回 ok=false')
const badCat = await call({ op: 'browse', args: { category: 'zzz' } })
check(badCat.body.ok === false, '非法类别应返回 ok=false')
const emptyQ = await call({ op: 'search', args: { q: '   ' } })
check(emptyQ.body.ok === true && emptyQ.body.hits.length === 0, '空查询应返回空列表')

console.log('[8] 图标路由（内嵌 data URI 失效时的回退来源）')
const iconRoute = routes.find((r) => r.path === '/dsh-onco-lexicon/icon.png')
if (iconRoute) {
  const r = await callRoute(iconRoute)
  const isPng = Buffer.isBuffer(r.body) && r.body.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  console.log(`  status=${r.status}  type=${r.headers['content-type']}  bytes=${r.body ? r.body.length : 0}`)
  check(r.status === 200, `图标路由应返回 200，实际 ${r.status}`)
  check(r.headers['content-type'] === 'image/png', '图标路由 content-type 应为 image/png')
  check(isPng, '图标路由返回的不是合法 PNG（assets/icon.png 可能没打进包）')
  check(r.body.length > 1000, `图标字节数过小（${r.body.length}）`)
}
// 防止"只在嘴上修"：assets 必须随包发布，否则路由 404
const pkg = JSON.parse(readFileSync(new URL('./dsh-onco-lexicon/package.json', import.meta.url), 'utf8'))
check((pkg.files || []).some((f) => f.startsWith('assets')), 'package.json 的 files 未包含 assets（图标不会随包发布）')

console.log('[9] 随包文本文件不得带 BOM')
// DSH 的 client-modules 是 JSON.parse(readFileSync(pkgPath,'utf8'))，Node 不会自动去 BOM，
// 带 BOM 的 package.json 会让它直接抛错。PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
// 所以这里必须兜住。
const textFiles = ['package.json', 'cordis.patch.yml', 'skill.md', 'lib/index.js', 'lib/client.js', 'README.md']
for (const rel of textFiles) {
  const buf = readFileSync(new URL(`./dsh-onco-lexicon/${rel}`, import.meta.url))
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  check(!hasBom, `${rel} 带 BOM（会导致 JSON.parse / 解析失败）`)
}
console.log(`  已检查 ${textFiles.length} 个文件`)

console.log('[10] 打包精简不变量')
// text 字段是 Python 侧知识库用的；插件按 en/zh/abbr/aliases/codes 建键，从不读取它。
// 实测去掉它能省 2.17 MB 压缩体积（14.9%），所以不该再回到插件词典里。
const dictUrl = new URL('./dsh-onco-lexicon/data/onco.ncit.jsonl', import.meta.url)
const rawDict = readFileSync(dictUrl, 'utf8')
const firstRec = JSON.parse(rawDict.slice(0, rawDict.indexOf('\n')))
console.log('  首条字段:', Object.keys(firstRec).sort().join(', '))
check(!('text' in firstRec), '插件词典不应含 text 字段（插件从不读取，白占压缩体积）')
check(Array.isArray(firstRec.sources), '插件词典应含 sources 数组（出处筛查依赖它）')
check('source' in firstRec, '插件词典应保留 source（人类可读的来源）')
const dictMiB = Buffer.byteLength(rawDict) / 2 ** 20
console.log(`  词典体积: ${dictMiB.toFixed(1)} MiB`)
check(dictMiB < 80, `词典体积应小于 80 MiB（精简后约 71.7），实际 ${dictMiB.toFixed(1)}`)

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
