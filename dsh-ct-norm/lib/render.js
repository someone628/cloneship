/**
 * dsh-ct-norm —— 输出渲染
 *
 * 输出刻意把「命中了什么」与「没归一化什么」放在同等显眼的位置。
 * 一份只说命中、不提漏收的归一化结果，在临床上比没有结果更危险。
 */
import { conceptLabel, CAT_LABEL } from './mesh.js'

const SECTION_LABEL = {
  technique: '检查技术',
  findings: '检查所见',
  impression: '诊断意见',
  comparison: '对比',
}

const BINDING_LABEL = {
  clause: '同小句',
  sentence: '同句（较弱）',
  after: '部位在后',
}

function flags(e) {
  const out = []
  if (e.attrs?.negated) out.push(`否定（${e.attrs.cues?.negation ?? '?'}）`)
  if (e.attrs?.uncertain) out.push(`可疑（${e.attrs.cues?.uncertainty ?? '?'}）`)
  if (e.approx) out.push('近似映射')
  if (e.ambiguity) out.push('歧义')
  if (e.match === 'composition') out.push('规则组合')
  return out
}

function attrBits(e) {
  const a = e.attrs ?? {}
  const bits = []
  if (a.severity) bits.push(`程度:${a.severity}`)
  if (a.count) bits.push(`数量:${a.count}`)
  if (a.laterality) bits.push(`侧别:${a.laterality}`)
  if (a.change) bits.push(`变化:${a.change}`)
  if (e.size) bits.push(`尺寸:${e.size.text}${e.size.unit === 'cm' || e.size.unit === '厘米' ? `(${e.size.mm}mm)` : ''}`)
  return bits
}

export function renderReport(result, meta = {}) {
  const lines = []
  const s = result.stats ?? {}
  const release = String(meta.meshRelease ?? '?')
  const releaseText = /^mesh\b/i.test(release) ? release : `MeSH ${release}`
  lines.push('CT 报告实体归一化（本地词表 + MeSH；不联网、不调用模型、不做推断）')
  lines.push(
    `词表：dsh-ct-norm ${meta.version ?? '?'}，${meta.entries ?? '?'} 条写法条目 / ${meta.aliases ?? '?'} 个表面写法 / ` +
    `${meta.concepts ?? '?'} 个 MeSH 概念；词表基于 ${releaseText}`,
  )
  lines.push('')

  if (s.integrityErrors) {
    lines.push(`⚠ 完整性错误 ${s.integrityErrors} 处（构建产物可能损坏，请重跑 build-ct-lexicon.mjs）：`)
    for (const e of result.integrityErrors) lines.push(`  - ${e}`)
    lines.push('')
  }

  lines.push(
    `原文 ${s.chars} 字，切分 ${s.sentences} 句 / ${s.clauses} 小句；` +
    `命中 ${s.entities} 个实体（${s.concepts} 个不同 MeSH 概念），未归一化 ${s.unmapped} 处，` +
    `仅识别到部位 ${s.orphanSites} 处。`,
  )
  if (s.entities) {
    lines.push(
      `属性统计：否定 ${s.negated} 处、可疑/不确定 ${s.uncertain} 处、歧义待定 ${s.ambiguous} 处。`,
    )
  }
  if (result.entities.length) {
    lines.push('注：侧别/程度/数量/变化 取自该实体所在的**小句**，不保证每个词都直接修饰该实体（例如')
    lines.push('    「纵隔及右肺门见肿大淋巴结」里的「右」修饰的是肺门，不是淋巴结）。请以原文为准复核。')
  }
  lines.push('')

  lines.push(`一、归一化结果（${result.entities.length} 条）`)
  if (!result.entities.length) {
    lines.push('  （无。原文里没有命中词表的写法——这**不代表报告正常**，只代表词表没收录这些写法。）')
  }
  result.entities.forEach((e, i) => {
    const cs = e.concepts.map((c) => `${c.name}（mesh:${c.ui}${c.tree ? `，${c.tree.split(',')[0]}` : ''}）`).join(' ＋ ')
    const siteTxt = e.sites.length
      ? e.sites.map((x) => `${x.name}（mesh:${x.ui}${x.approx ? '，近似' : ''}）`).join(' / ')
      : '—'
    const seg = e.section ? SECTION_LABEL[e.section] ?? e.section : '—'
    const attr = attrBits(e)
    lines.push(`${i + 1}. 「${e.surface}」→ ${cs}`)
    lines.push(
      `   部位：${siteTxt}｜绑定：${BINDING_LABEL[e.binding] ?? '无'}｜段落：${seg}｜词条：${e.entryId}` +
      (attr.length ? `｜${attr.join('｜')}` : ''),
    )
    const f = flags(e)
    if (f.length) lines.push(`   ▸ ${f.join('；')}`)
    for (const c of e.concepts) {
      if (c.def) lines.push(`   ${c.name} 释义：${c.def}`)
    }
    for (const cv of e.caveats ?? []) lines.push(`   ⚠ ${cv}`)
    if (e.ambiguity) lines.push(`   ⚠ ${e.ambiguity.question}`)
  })
  lines.push('')

  lines.push(`二、未归一化（${result.unmapped.length} 处）`)
  if (!result.unmapped.length) lines.push('  （无）')
  for (const u of result.unmapped) {
    const site = u.site ? `（部位：${u.site.name}）` : ''
    const n = u.attrs?.negated ? '［否定］' : u.attrs?.uncertain ? '［可疑］' : ''
    lines.push(`- 「${u.surface}」${site}${n} —— ${u.reason}`)
  }
  lines.push('')

  lines.push(`三、概念汇总（按 MeSH 编号去重，${conceptCount(result)} 个）`)
  const agg = aggregateConcepts(result)
  if (!agg.length) lines.push('  （无）')
  for (const c of agg) {
    const bits = []
    if (c.negated) bits.push(`否定 ${c.negated}`)
    if (c.uncertain) bits.push(`可疑 ${c.uncertain}`)
    lines.push(`- ${c.name}（mesh:${c.ui}${c.tree ? `，${c.tree.split(',')[0]}` : ''}）出现 ${c.count} 次${bits.length ? `（${bits.join('，')}）` : ''}`)
  }
  lines.push('')

  lines.push(`四、仅识别到部位、未绑定任何病变（${result.sites.length} 处）`)
  if (!result.sites.length) lines.push('  （无）')
  for (const x of result.sites) {
    lines.push(`- 「${x.surface}」→ ${x.name}（mesh:${x.ui}${x.approx ? '，近似' : ''}）`)
  }
  lines.push('')

  lines.push('五、边界与免责（请连同上面的结果一起转述）')
  lines.push('- 本工具只做**词表命中**与**固定规则组合**，不做模型推断、不联网。上表未出现的写法即词表未收录；')
  lines.push('  「未归一化」一栏是刻意保留的——MeSH 主题词表以疾病实体为粒度，磨玻璃影、毛刺、低密度灶这类')
  lines.push('  影像描述性征象在 MeSH 里没有对应概念，硬映射只会造出看着规范、实则错误的编码。')
  lines.push('- MeSH **只有英文**，本工具不产出任何中文译名；概念名一律是 MeSH 规范名。')
  lines.push('- 「部位 + 转移/占位」类结果是规则外推（标了「规则组合」），不等于病理诊断，需人工确认。')
  lines.push('- 本工具不提供诊断意见；请以临床指南与医师判断为准。')
  return lines.join('\n')
}

/** 按 MeSH 编号汇总（同一概念在报告里可能出现多次，含否定/可疑的出现次数） */
export function aggregateConcepts(result) {
  const map = new Map()
  for (const e of result.entities ?? []) {
    for (const c of e.concepts) {
      if (!map.has(c.ui)) {
        map.set(c.ui, { ui: c.ui, name: c.name, tree: c.tree, cat: c.cat, count: 0, negated: 0, uncertain: 0 })
      }
      const t = map.get(c.ui)
      t.count += 1
      if (e.attrs?.negated) t.negated += 1
      if (e.attrs?.uncertain) t.uncertain += 1
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
}

function conceptCount(result) {
  return aggregateConcepts(result).length
}

/** 给工具输出用的一行摘要 */
export function renderSummary(result, meta = {}) {
  const s = result.stats ?? {}
  if (!s.entities && !s.unmapped) return `未从原文中识别出任何词表收录的写法（${s.chars} 字）。`
  const names = result.entities.slice(0, 5).map((e) => e.concepts[0]?.name).filter(Boolean)
  return (
    `归一化 ${s.entities} 个实体（${s.concepts} 个 MeSH 概念${names.length ? `：${names.join('、')}${s.concepts > names.length ? ' 等' : ''}` : ''}）；` +
    `未归一化 ${s.unmapped} 处；否定 ${s.negated}、可疑 ${s.uncertain}。`
  )
}

/** ct_lexicon 工具与面板共用的词条渲染 */
export function renderLexiconHits(hits, meta = {}) {
  const lines = []
  lines.push(
    `dsh-ct-norm 词表 ${meta.version ?? '?'}：${meta.entries ?? '?'} 条条目 / ${meta.aliases ?? '?'} 个表面写法 / ` +
    `${meta.concepts ?? '?'} 个 MeSH 概念（MeSH ${meta.meshRelease ?? '?'}，构建于 ${meta.builtUtc ?? '?'}）`,
  )
  if (!hits.length) {
    lines.push('')
    lines.push('未命中。请换一个写法，或用 --kind / kind 参数按类别浏览。')
    return lines.join('\n')
  }
  lines.push('')
  hits.forEach((h, i) => {
    const e = h.entry
    const approx = new Set(Array.isArray(e.approx) ? e.approx : [])
    const zh = (e.zh ?? []).map((a) => (approx.has(a) ? `${a}*` : a)).join('、')
    const en = (e.en ?? []).map((a) => (approx.has(a) ? `${a}*` : a)).join('、')
    lines.push(`${i + 1}. ${e.mesh ? e.mesh.name : '(无 MeSH 概念)'}${e.mesh ? `（mesh:${e.mesh.ui}${e.mesh.tree ? `，${e.mesh.tree.split(',')[0]}` : ''}）` : ''}`)
    lines.push(`   条目：${e.id}｜类别：${e.kind}${e.region ? `｜区域：${e.region}` : ''}${e.action ? `｜组合规则：${e.action}` : ''}`)
    lines.push(`   中文写法：${zh || '—'}`)
    if (en) lines.push(`   英文写法：${en}`)
    if (e.neoplasm) lines.push(`   该部位肿瘤概念：${e.neoplasm.name}（mesh:${e.neoplasm.ui}）`)
    if (e.note) lines.push(`   说明：${e.note}`)
    if (e.mesh && e.mesh.cat) lines.push(`   类别（本插件粗分类）：${CAT_LABEL[e.mesh.cat] ?? e.mesh.cat}`)
    if (h.via) lines.push(`   命中方式：${h.via}`)
  })
  lines.push('')
  lines.push('注：带 * 的写法是**近似映射**（外延与 MeSH 概念不完全一致）。')
  lines.push('注：本词表只作用于中文 CT 报告文本；MeSH 只有英文，条目里不提供中文译名。')
  return lines.join('\n')
}

/** 概念去向汇总：面板与批量核对用 */
export function conceptIndex(entries) {
  const map = new Map()
  for (const e of entries) {
    const put = (ref, source) => {
      if (!ref) return
      if (!map.has(ref.ui)) map.set(ref.ui, { ui: ref.ui, name: ref.name, cat: ref.cat, tree: ref.tree, from: [] })
      map.get(ref.ui).from.push({ id: e.id, kind: e.kind, source })
    }
    put(e.mesh, 'direct')
    put(e.neoplasm, 'anatomy-neoplasm')
    put(e.lymphaticMesh, 'metastasis-lymphatic')
    if (e.candidates) for (const [k, v] of Object.entries(e.candidates)) put(v, `nodule-${k}`)
  }
  return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

export { conceptLabel }
