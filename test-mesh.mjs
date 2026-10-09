/**
 * dsh-lit-translate —— MeSH 术语层自测（lib/mesh.js）
 *
 * 跑法：node test-mesh.mjs
 *
 * 重点是**跨语言一致性**：索引由 Python（mesh_build.py）产出，
 * 归一化口径必须与 JS 端逐字对齐，否则中文/英文术语会「查不到但看不出来」。
 * 因此这里直接用 Python 写出的 mesh_fixtures.json 逐条比对命中结果。
 *
 * 依赖产物（都在工作区里，缺失时相关检查会明确报错而不是静默跳过）：
 *   mesh_out/mesh_index.bin        索引（同时复制到 dsh-lit-translate/data/）
 *   mesh_out/mesh_fixtures.json    Python 侧查询夹具
 *   mesh_out/mesh_index.json       清单（计数与 sha256）
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  } else {
    console.log('  ok   ', label)
  }
}

const ROOT = fileURLToPath(new URL('./', import.meta.url))
const PLUGIN = path.join(ROOT, 'dsh-lit-translate')
const OUT = path.join(ROOT, 'mesh_out')
const INDEX_FILE = process.env.MESH_INDEX || path.join(PLUGIN, 'data', 'mesh_index.bin')

/** 随包分发的副本优先，工作区构建产物兜底（两者内容相同，构建后复制一次） */
function artifact(name) {
  const shipped = path.join(PLUGIN, 'data', name)
  if (existsSync(shipped)) return shipped
  return path.join(OUT, name)
}

const mesh = await import(new URL('./dsh-lit-translate/lib/mesh.js', import.meta.url).href)

console.log('\n[1] 模块面与归一化口径')

for (const name of [
  'normalizeText', 'tokenize', 'splitMatchSegments', 'MeshIndex', 'createMeshSource',
  'findMeshTerms', 'renderMeshBlock', 'renderMeshSummary', 'meshBrief', 'acceptSingleToken',
  'kindOfId', 'DEFAULT_MESH_FILE', 'STOPWORDS',
]) {
  check(typeof mesh[name] !== 'undefined', `导出 ${name}`)
}

{
  const cases = [
    ["Crohn's disease", 'crohns disease'],
    ['Non-Small-Cell Lung Carcinoma', 'non small cell lung carcinoma'],
    ['Programmed Death-Ligand 1', 'programmed death ligand 1'],
    ['TGF-β', 'tgf β'],
    ['Ménière disease', 'meniere disease'],
    ['   spaced   out   ', 'spaced out'],
    ['PD-L1', 'pd l1'],
    ['IL-6', 'il 6'],
    ['95% CI', '95 ci'],
    ['', ''],
    [null, ''],
    ['Antibodies, Monoclonal', 'antibodies monoclonal'],
  ]
  let bad = []
  for (const [input, want] of cases) {
    const got = mesh.normalizeText(input)
    if (got !== want) bad.push(`${JSON.stringify(input)} -> ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`)
  }
  check(bad.length === 0, 'normalizeText 与 Python 口径一致（12 例）' + (bad.length ? '：' + bad.join(' | ') : ''))

  const toks = mesh.tokenize("Crohn's disease and PD-L1")
  check(
    toks.length === 5 &&
      toks[0].norm === 'crohns' &&
      toks[0].raw === "Crohn's" &&
      toks[3].raw === 'PD' &&
      toks[4].norm === 'l1',
    'tokenize：撇号按词内处理；连字符按分隔符拆开（PD-L1 → pd + l1，与索引口径一致）',
  )
  check(
    toks[0].start === 0 && "Crohn's disease and PD-L1".slice(toks[0].start, toks[0].end) === "Crohn's",
    'tokenize：偏移量能还原原文片段',
  )

  const segs = mesh.splitMatchSegments('Alpha beta. Gamma delta (epsilon) zeta')
  check(
    segs.length === 4 && segs[0].text.trim() === 'Alpha beta' && segs[3].text.trim() === 'zeta' &&
      segs.every((s, i) => i === 0 || s.offset > segs[i - 1].offset),
    'splitMatchSegments：按句读切开并保留递增偏移（括号也不跨段）',
  )
}

console.log('\n[2] 单字接受规则（泛化词 / 缩写）')

{
  const Tok = (raw) => ({ raw, norm: mesh.normalizeText(raw) })
  check(mesh.acceptSingleToken(Tok('HR'), [1, 2, 3, 4, 5, 6, 7, 8]), '全大写缩写 HR 放行（不看候选数）')
  check(mesh.acceptSingleToken(Tok('trastuzumab'), [1]), '专名单词放行（候选少、够长）')
  check(!mesh.acceptSingleToken(Tok('patients'), [1]), '泛化词 patients 被泛化词表拦住')
  check(!mesh.acceptSingleToken(Tok('hazard'), [1, 2, 3, 4]), '候选过多的普通词拦住')
  check(!mesh.acceptSingleToken(Tok('ab'), [1]), '过短的单字拦住（2 字且非缩写）')
  check(!mesh.acceptSingleToken(Tok('5'), [1]), '纯数字拦住')
  check(mesh.STOPWORDS.has('response') && mesh.STOPWORDS.has('survival'), '泛化词表含 response / survival 这类高频词')
}

console.log('\n[3] 索引读取（对照 Python 清单与夹具）')

if (!existsSync(INDEX_FILE)) {
  check(false, `找不到 MeSH 索引：${INDEX_FILE}（先跑 python mesh_build.py build）`)
} else {
  const manifest = JSON.parse(readFileSync(artifact('mesh_index.json'), 'utf8'))
  const t0 = Date.now()
  const index = mesh.MeshIndex.load(INDEX_FILE)
  const loadMs = Date.now() - t0
  console.log(`        索引加载 ${loadMs} ms，${(Buffer.byteLength(readFileSync(INDEX_FILE)) / 1048576).toFixed(1)} MiB`)

  check(index.termCount === manifest.counts.terms, `术语数与清单一致（${index.termCount.toLocaleString('en-US')}）`)
  check(index.recordCount === manifest.counts.records, `记录数与清单一致（${index.recordCount.toLocaleString('en-US')}）`)
  check(index.refCount === manifest.counts.refs, `引用数与清单一致（${index.refCount.toLocaleString('en-US')}）`)
  check(index.version === 1 && index.meta() !== null && index.meta().mesh_release === 'MeSH 2026', 'meta 可读且标注 MeSH 2026')
  check(loadMs < 8000, `索引加载在 8 秒内（实测 ${loadMs} ms）`)

  // 术语表严格升序（抽样，避免每次都全量遍历 84 万条）
  let orderBad = 0
  let prev = ''
  for (let i = 0; i < index.termCount; i += 997) {
    const t = index.termAt(i)
    if (t <= prev) orderBad++
    prev = t
  }
  check(orderBad === 0, '术语表按字节序升序（每 997 条抽一条）')

  // 二分查找：抽 200 个术语必须自命中
  let miss = 0
  for (let i = 0; i < index.termCount; i += 4201) {
    const t = index.termAt(i)
    const refs = index.lookup(t)
    if (refs.length === 0 || index.recordAt(refs[0]) === null) miss++
  }
  check(miss === 0, '二分查找自命中（抽 200 个术语，全部命中且记录可读）')

  const fixtures = JSON.parse(readFileSync(artifact('mesh_fixtures.json'), 'utf8'))
  let refBad = []
  let recBad = []
  for (const q of fixtures.queries) {
    const norm = mesh.normalizeText(q.q)
    if (q.norm !== undefined && norm !== q.norm) refBad.push(`${q.q} 归一化 ${norm} != ${q.norm}`)
    const refs = index.lookup(norm)
    if (refs.length !== q.n_refs) {
      refBad.push(`${q.q} 候选 ${refs.length} != ${q.n_refs}`)
      continue
    }
    if (q.first) {
      const rec = index.recordAt(refs[0])
      if (!rec || rec.id !== q.first.id || rec.name !== q.first.name) {
        recBad.push(`${q.q} -> ${rec && rec.id}/${rec && rec.name} != ${q.first.id}/${q.first.name}`)
      }
    }
  }
  check(refBad.length === 0, `夹具候选数全部一致（${fixtures.queries.length} 条）` + (refBad.length ? '：' + refBad.join(' | ') : ''))
  check(recBad.length === 0, '夹具首条记录 id/规范名全部一致' + (recBad.length ? '：' + recBad.join(' | ') : ''))

  console.log('\n[4] 术语匹配（真实段落）')

  const PARA = [
    'Patients with non-small cell lung carcinoma were randomly assigned to trastuzumab or placebo.',
    'The primary endpoint was progression-free survival; myocardial infarction and gene expression were secondary.',
    'Immunotherapy was continued until disease progression. Aspirin use and Crohn disease were recorded at baseline.',
    'There were 120 patients in the study; the hazard ratio was 0.72 (95% CI 0.58-0.90).',
  ].join(' ')
  const t1 = Date.now()
  const res = mesh.findMeshTerms(index, PARA)
  const matchMs = Date.now() - t1
  console.log(`        匹配耗时 ${matchMs} ms，命中 ${res.matches.length} 个`)
  for (const m of res.matches) console.log(`          - ${m.name} [${m.id}] ← ${m.surface}`)

  const ids = new Set(res.matches.map((m) => m.id))
  check(ids.has('mesh:D002289'), '命中 non-small cell lung carcinoma（D002289）')
  check(ids.has('mesh:D000068878'), '命中 trastuzumab（D000068878）')
  check(ids.has('mesh:D000077982'), '命中 progression-free survival（D000077982）')
  check(ids.has('mesh:D009203'), '命中 myocardial infarction（D009203）')
  check(ids.has('mesh:D007167'), '命中 immunotherapy（D007167）')
  check(
    res.matches.every((m) => !(m.tokens === 1 && mesh.STOPWORDS.has(m.norm))),
    '单字命中里没有泛化词（patients / study / disease 等没被当术语）',
  )
  check(
    res.matches.every((m) => !(m.tokens === 1 && m.kind === 'qualifier')),
    '单字命中里没有限定词缩写（95% CI 不会被当成「chemically induced」）',
  )
  check(!ids.has('mesh:Q000139'), 'CI 误命中已被拦住')
  {
    // 多词短语的限定词仍然放行：这类短语（adverse effects / drug therapy）对译法一致性有用
    const q = mesh.findMeshTerms(index, 'Adverse effects were reported, and drug therapy was recorded.')
    const qids = new Set(q.matches.map((m) => m.id))
    check(qids.has('mesh:Q000009'), '多词限定词 adverse effects（Q000009）仍然命中')
  }
  check(
    res.matches.every((m, i) => i === 0 || m.start >= res.matches[i - 1].start) &&
      res.matches.every((m) => m.end > m.start && PARA.slice(m.start, m.end) === m.surface),
    '命中按出现顺序排列，且偏移能还原原文',
  )
  check(new Set(res.matches.map((m) => m.id)).size === res.matches.length, '同一概念只报一次')
  check(
    res.matches.every((m) => m.def.length <= index.defLimit + 1),
    `释义长度不超过 def_limit（${index.defLimit}）`,
  )
  check(matchMs < 500, `段落匹配在 500 ms 内（实测 ${matchMs} ms）`)

  {
    const capped = mesh.findMeshTerms(index, PARA, { maxTerms: 2 })
    check(capped.matches.length === 2 && capped.truncated === true && capped.total >= 5, '超过 maxTerms 时截断并标记 truncated')
    const longFirst = capped.matches.every((m) => m.tokens >= 1)
    check(longFirst, '截断时优先保留更长的短语')
  }

  {
    const none = mesh.findMeshTerms(index, 'the and of in on with a an')
    check(none.matches.length === 0, '纯虚词句命中 0 个术语')
  }

  console.log('\n[5] 提示词块与摘要')

  {
    const block = mesh.renderMeshBlock(res)
    check(block.includes('MeSH 2026 术语约束'), '块标题标明来源与用途')
    check(block.includes('mesh:D000077982'), '块里带 MeSH 编号（可回查）')
    check(block.includes('Progression-Free Survival'), '块里用 MeSH 规范名')
    check(block.includes('MeSH 只有英文，没有中文名'), '块里明确 MeSH 没有中文名（防止编造官方译名）')
    check(!block.includes('非小细胞肺癌'), '块里不含任何被编出来的中文术语名')
    check(!/非小细胞|曲妥珠|免疫治疗/.test(block), '块里没有中文译名（只有英文规范名与释义）')
    check(block.includes('不要翻译它'), '块里声明这段不是译文')

    const tight = mesh.renderMeshBlock(res, { maxChars: 400 })
    check(tight.length <= 400 + 260, 'maxChars 生效（只允许末尾约束行略微超一点）')
    check(tight.includes('未列出'), '截断时说明还有术语没列出')

    const empty = mesh.renderMeshBlock({ matches: [] })
    check(empty === '', '没有命中时返回空串（不注入空块）')

    const summary = mesh.renderMeshSummary(res.matches)
    check(summary.includes('命中') && summary.includes('Progression-Free Survival'), '摘要给出命中数量与规范名')
    check(mesh.renderMeshSummary([]).includes('没有命中'), '零命中时摘要说清楚')

    const brief = mesh.meshBrief(res.matches)
    check(brief.count === res.matches.length && Array.isArray(brief.names) && brief.terms.length === brief.count, 'meshBrief 结构可序列化给面板')
  }

  console.log('\n[6] 失败路径')

  {
    const missing = mesh.createMeshSource(path.join(ROOT, 'no-such-dir', 'mesh_index.bin'))
    const st = missing.status()
    check(st.ok === false && st.error.includes('读不到'), '索引缺失时 status 明确报错')
    check(missing.get().ok === false, '索引缺失时 get 失败而不是抛异常')
    check(missing.get().ok === false, '失败后不反复重试（缓存错误）')

    const ok = mesh.createMeshSource(INDEX_FILE)
    check(ok.status().ok === true && ok.status().loaded === false, '未加载时 status 只读头、不整份读入')
    check(ok.get().ok === true && ok.loaded() === true && ok.status().loaded === true, 'get 之后 loaded 变 true')

    let threw = ''
    try {
      new mesh.MeshIndex(Buffer.from('not a mesh index at all, definitely long enough to pass the length check.........'))
    } catch (error) {
      threw = String(error.message || error)
    }
    check(threw.includes('magic'), '垃圾文件被 magic 检查挡住')

    let threw2 = ''
    try {
      new mesh.MeshIndex(Buffer.alloc(8))
    } catch (error) {
      threw2 = String(error.message || error)
    }
    check(threw2.includes('不完整'), '过短文件被长度检查挡住')
  }
}

console.log('')
if (failures.length > 0) {
  console.log(`[x] ${failures.length} / ${checks} 项失败`)
  for (const f of failures) console.log('    - ' + f)
  process.exit(1)
}
console.log(`[+] MeSH 术语层：${checks} 项检查全部通过`)
