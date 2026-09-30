/**
 * dsh-onco-lexicon 的独立功能测试。
 * 使用真实的 @deepseek-ai/dsh-tools 的 defineTool 做 schema 校验，
 * 但用 mock ctx 代替 DSH 运行时。
 *
 * 前置条件：插件目录下 `node_modules/@deepseek-ai/dsh-tools` 必须可解析。
 * 该包由 DSH 自带，不随插件发布，因此测试前需建一个指向它的 junction：
 *
 *   $host = "$env:LOCALAPPDATA\Programs\ds-harness-desktop\runtime\host\node_modules\@deepseek-ai"
 *   New-Item -ItemType Directory -Force -Path .\dsh-onco-lexicon\node_modules\@deepseek-ai
 *   New-Item -ItemType Junction -Path .\dsh-onco-lexicon\node_modules\@deepseek-ai\dsh-tools -Target "$host\dsh-tools"
 *
 * （该 node_modules 不在 package.json 的 files 列表内，不会被打进 tgz。）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Lexicon, apply, normalize, tokenize } from './dsh-onco-lexicon/lib/index.js'

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}

const root = fileURLToPath(new URL('./dsh-onco-lexicon/', import.meta.url))
const entries = readFileSync(root + 'data/onco.seed.jsonl', 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

console.log('[1] 载入与索引')
const lex = new Lexicon(entries)
const st = lex.stats()
console.log(`  词条 ${st.total}  类别分布 ${JSON.stringify(st.byCategory)}`)
check(st.total === 106, `词条数应为 106，实际 ${st.total}`)
check(Object.keys(st.byCategory).length === 7, '应有 7 个类别')

console.log('[2] 中文分词：靠字符二元组把短词与长名称连起来')
// 设计上中文只产出「分词结果 + 字符二元组」，不产出单字。
// 关键性质：查询「肺癌」的二元组必须出现在「非小细胞肺癌」的二元组里。
const short = tokenize('肺癌')
const long = tokenize('非小细胞肺癌')
console.log(`  tokenize('肺癌')       = ${JSON.stringify(short)}`)
console.log(`  tokenize('非小细胞肺癌') = ${JSON.stringify(long)}`)
check(short.includes('肺癌'), '查询侧缺少二元组 肺癌')
check(long.includes('肺癌'), '长名称侧缺少二元组 肺癌（短词将无法召回长名称）')
check(long.includes('细胞'), '长名称侧缺少二元组 细胞')
check(short.every((t) => long.includes(t)), '查询「肺癌」的 token 未被长名称完全覆盖')

console.log('[3] 归一化（保留 +，短横转空格）')
console.log(`  normalize('Non-Small Cell') = ${JSON.stringify(normalize('Non-Small Cell'))}`)
console.log(`  normalize('ER+')            = ${JSON.stringify(normalize('ER+'))}`)
check(normalize('Non-Small Cell') === 'non small cell', '短横未转空格')
check(normalize('ER+') === 'er+', '加号被误删')
check(normalize('ＰＤ－Ｌ１') === 'pd l1', '全角未归一化')

console.log('[4] 检索')
const cases = [
  ['非小细胞肺癌', 'onco:nsclc'],
  ['NSCLC', 'onco:nsclc'],
  ['肺癌', null],
  ['奥希替尼', 'onco:osimertinib'],
  ['EGFR', 'onco:egfr'],
  ['PFS', 'onco:pfs'],
  ['总生存期', 'onco:os'],
  ['免疫检查点抑制剂', 'onco:ici'],
  ['乳腺癌', 'onco:breast'],
]
for (const [q, expect] of cases) {
  const hits = lex.search(q, 3)
  const top = hits[0]
  console.log(`  ${q.padEnd(10)} -> ${hits.map((h) => `${h.entry.id}(${h.score.toFixed(0)})`).join(', ')}`)
  check(hits.length > 0, `「${q}」无任何命中`)
  if (expect) check(top && top.entry.id === expect, `「${q}」首位应为 ${expect}，实际 ${top?.entry.id}`)
}

console.log('[5] 缩写消歧')
for (const a of ['OS', 'PD', 'MM', 'NSCLC']) {
  const hits = lex.lookupAbbr(a, 10)
  console.log(`  ${a.padEnd(6)} -> ${hits.map((h) => h.entry.id).join(', ')}`)
  check(hits.length > 0, `缩写 ${a} 无命中`)
}
check(lex.lookupAbbr('ZZZZ').length === 0, '不存在的缩写应无命中')

console.log('[6] 未收录术语不应编造')
const miss = lex.search('完全不存在的术语xyz', 3)
console.log(`  命中数 ${miss.length}`)
check(miss.length === 0, '生造术语不应命中')

console.log('[7] 按类别浏览')
const drugs = lex.browse('drug', undefined, 100)
console.log(`  drug 类目 ${drugs.length} 条`)
check(drugs.length === st.byCategory.drug, 'drug 浏览数与统计不符')
check(drugs.every((e) => e.category === 'drug'), '浏览结果混入其他类别')
const lung = lex.browse('disease', '肺', 50)
console.log(`  disease + 关键词「肺」 ${lung.length} 条: ${lung.map((e) => e.zh).join('、')}`)
check(lung.length > 0, '关键词过滤无结果')

console.log('[8] apply() 与真实 defineTool 校验')
const registered = []
const sections = []
const mockCtx = {
  logger: { info: (m) => console.log('  [log]', m) },
  tools: { register: (t) => registered.push(t) },
  systemPrompt: { section: (s) => sections.push(s) },
}
apply(mockCtx, {})
console.log(`  注册工具 ${registered.length} 个: ${registered.map((t) => t.name).join(', ')}`)
check(registered.length === 4, `应注册 4 个工具，实际 ${registered.length}`)
check(
  ['onco_term', 'onco_abbr', 'onco_browse', 'onco_translate'].every((n) => registered.some((t) => t.name === n)),
  '工具名不齐',
)
// schema 层的枚举值必须齐，否则模型传合法方向也会被 defineTool 拦下
const trToolDef = registered.find((t) => t.name === 'onco_translate')
check(!!trToolDef, '未注册 onco_translate')
check(
  String(JSON.stringify(trToolDef && trToolDef.parameters)).includes('"zh2en"'),
  'onco_translate 的 direction 缺少 zh2en 枚举',
)
check(sections.length === 1, '应注入 1 段系统提示词')
check(sections[0]?.name === 'onco-lexicon-usage', '提示词段名不符')

console.log('[9] 工具 execute 端到端')
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const termOut = await byName.onco_term.execute({ term: '非小细胞肺癌' })
console.log('  onco_term 输出首行:', String(termOut).split('\n')[0])
check(String(termOut).includes('非小细胞肺癌'), 'onco_term 未返回该术语')
const abbrOut = await byName.onco_abbr.execute({ abbr: 'MM' })
console.log('  onco_abbr 输出首行:', String(abbrOut).split('\n')[0])
const browseOut = await byName.onco_browse.execute({ category: 'drug', limit: 5 })
console.log('  onco_browse 输出首行:', String(browseOut).split('\n')[0])
check(String(browseOut).includes('5 条'), 'onco_browse 未按 limit 返回')
// 非法类别现在由 defineTool 的 enum 在 schema 层拦下，走不到函数内的兜底分支
let badCatThrew = false
try {
  await byName.onco_browse.execute({ category: 'nope' })
} catch (e) {
  badCatThrew = (e && e.code) === 'INVALID_ARGS'
}
check(badCatThrew, '非法类别未被 schema 拦下')

// 新增：类别 / 出处筛查
const drugBrowse = await byName.onco_browse.execute({ category: 'drug', limit: 5 })
console.log('  onco_browse（类别筛查）:', String(browseOut).split('\n')[0])
check(String(drugBrowse).includes('已按 类别=抗肿瘤药物 筛查'), 'onco_browse 未回显类别筛查')
const seedBrowse = await byName.onco_browse.execute({ source: '自建库', limit: 3 })
console.log('  onco_browse（出处筛查）:', String(seedBrowse).split('\n')[0])
check(String(seedBrowse).includes('出处=自建库'), 'onco_browse 未支持出处筛查')
const catTerm = await byName.onco_term.execute({ term: '肺癌', category: 'drug', topK: 3 })
check(String(catTerm).includes('已按 类别=抗肿瘤药物 筛查'), 'onco_term 未支持类别筛查')
const srcTerm = await byName.onco_term.execute({ term: '非小细胞肺癌', source: '自建库', topK: 3 })
check(String(srcTerm).includes('出处=自建库'), 'onco_term 未支持出处筛查')
check(String(srcTerm).includes('出处：NCIt + 自建库（已合并）'), '合并条目未标出出处')
const noCatBrowse = await byName.onco_browse.execute({ limit: 3 })
check(!String(noCatBrowse).includes('未知类别'), '不给类别时不应报错')

console.log('[10] onco_translate 端到端（含 schema 枚举校验）')
const trOut = await byName.onco_translate.execute({ text: '非小细胞肺癌' })
console.log('  onco_translate 输出首行:', String(trOut).split('\n')[0])
check(String(trOut).includes('中→英'), 'onco_translate 未标明方向')
check(String(trOut).includes('Lung Non-Small Cell Carcinoma'), 'onco_translate 未给出英文标准名')
check(String(trOut).includes('不是机器翻译'), 'onco_translate 未声明这不是机器翻译')
const trBack = await byName.onco_translate.execute({ text: 'NSCLC', direction: 'en2zh' })
check(String(trBack).includes('非小细胞肺癌'), 'onco_translate 英译中未给出中文名')
const trEmpty = await byName.onco_translate.execute({ text: '  ' })
check(String(trEmpty).includes('没有可对照的文本'), 'onco_translate 对空文本未如实回应')
// 非法方向必须由 schema 拦下，而不是静默按 auto 处理
let badDirThrew = false
try {
  await byName.onco_translate.execute({ text: 'abc', direction: 'nope' })
} catch (e) {
  badDirThrew = (e && e.code) === 'INVALID_ARGS'
}
check(badDirThrew, '非法翻译方向未被 schema 拦下')

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
