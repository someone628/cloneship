/**
 * dsh-ct-norm —— 别名词表与匹配
 *
 * 词表是构建产物（`data/ct.lexicon.jsonl`），每条的 MeSH 字段都已由构建脚本
 * 从 NLM 索引反解并写入编号，运行时**没有**任何猜测空间。
 *
 * 匹配在「骨架文本」上做（见 text.js：修饰词已被摘掉），所以
 * 「右侧胸腔少量积液」里的「胸腔积液」接得上；而命中的位置能精确映射回原文，
 * 供高亮与人工复核。
 *
 * 匹配按**最长优先**：`淋巴结肿大`(Lymphadenopathy) 赢过 `淋巴结`(Lymph Nodes)，
 * `磨玻璃结节`(未归一化征象) 赢过 `结节`(泛化形态学词)。
 *
 * 拉丁别名另外要过**词边界**（见 `latinBoundaryOk`）：`5mm`、`mmol/L`、`3 MM` 里的
 * `mm` 是毫米，不是 Multiple Myeloma 的缩写——中文报告里毫米是出现频率最高的单位，
 * 这条边界比多认一个缩写重要得多。
 */
import { readFileSync } from 'node:fs'
import { foldChars } from './text.js'

/** 折叠成匹配用的键（与 text.prepare 的骨架文本同一套折叠） */
export function foldKey(s) {
  return foldChars(String(s ?? '')).chars.join('')
}

export function parseLexicon(text) {
  const entries = []
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('//')) return
    let e
    try { e = JSON.parse(t) } catch (err) {
      throw new Error(`ct.lexicon.jsonl 第 ${i + 1} 行不是合法 JSON：${err.message}`)
    }
    if (!e || typeof e.id !== 'string' || !Array.isArray(e.zh)) {
      throw new Error(`ct.lexicon.jsonl 第 ${i + 1} 行缺少 id / zh`)
    }
    entries.push(e)
  })
  return entries
}

export function loadLexicon(file) {
  const entries = parseLexicon(readFileSync(file, 'utf8'))
  if (entries.length === 0) throw new Error('别名词表是空的')
  return entries
}

/**
 * 建匹配表。
 *
 * `entries` 是构建产物，`unmapped` 是规则文件里的「未归一化征象」组。
 * 两者共用一张表，靠最长优先区分：`磨玻璃结节`（未归一化）比 `结节`（泛化形态学）长，
 * 所以先命中前者——这正是我们要的语义。
 *
 * ## 两条匹配通道（这是本模块最关键的设计）
 *
 * 匹配在「骨架文本」上做（修饰词与极性词已被摘掉）。但**有些别名本身就含这些词**，
 * 而且没有别的写法可用：
 *
 *   - `无病生存` / `无进展生存` 含「无」
 *   - `多发性骨髓瘤` 含「多发」
 *   - `椎体压缩骨折` 要能匹配「椎体**多发**压缩骨折」
 *
 * 如果一律只匹配骨架文本，前两条永远命中不了（骨架里「无」已被摘掉）；
 * 如果一律只匹配原文，第三条又匹配不上。
 *
 * 所以把别名分成两桶：
 *   - `plain`（不含屏蔽词）→ 在骨架文本上匹配，能吃下原文里插入的修饰词；
 *   - `masked`（含屏蔽词）  → 在折叠后的原文上匹配，保证这些写法本身不被拆坏。
 * 两条通道的结果按「起点升序、跨度降序」贪心合并，即仍是全局最长优先。
 */
export function buildMatcher(entries, unmappedGroups, options = {}) {
  const maskWords = (options.maskWords ?? []).filter((w) => typeof w === 'string' && w)
  const plain = new Map()
  const masked = new Map()
  let plainMaxLen = 0
  let maskedMaxLen = 0
  let aliasCount = 0
  let maskedAliasCount = 0

  const containsMaskWord = (s) => maskWords.some((w) => s.includes(w))

  const add = (surface, hit) => {
    const key = foldKey(surface)
    if (!key) return
    const isMasked = containsMaskWord(surface)
    const bucket = isMasked ? masked : plain
    const other = isMasked ? plain : masked
    if (bucket.has(key) || other.has(key)) {
      // 构建脚本已保证全局唯一；运行期再兜一层，避免静默覆盖
      throw new Error(`别名词表里「${surface}」出现两次（${(bucket.get(key) || other.get(key)).entryId} 与 ${hit.entryId}）`)
    }
    bucket.set(key, hit)
    aliasCount += 1
    if (isMasked) {
      maskedAliasCount += 1
      if (key.length > maskedMaxLen) maskedMaxLen = key.length
    } else if (key.length > plainMaxLen) {
      plainMaxLen = key.length
    }
  }

  entries.forEach((e, idx) => {
    const approxSet = new Set(Array.isArray(e.approx) ? e.approx : [])
    const allApprox = e.approx === true
    const site = e.kind === 'anatomy'
    for (const a of e.zh ?? []) {
      add(a, { type: site ? 'site' : 'entry', entryIndex: idx, entryId: e.id, alias: a, approx: allApprox || approxSet.has(a), lang: 'zh' })
    }
    for (const a of e.en ?? []) {
      add(a, { type: site ? 'site' : 'entry', entryIndex: idx, entryId: e.id, alias: a, approx: allApprox || approxSet.has(a), lang: 'en' })
    }
  })

  const unmapped = []
  ;(unmappedGroups ?? []).forEach((g) => {
    const idx = unmapped.length
    unmapped.push({ term: g.term, reason: g.reason ?? '', site: g.site ?? null })
    const forms = new Set([g.term, ...(g.aliases ?? [])].filter((x) => typeof x === 'string' && x))
    for (const f of forms) {
      add(f, { type: 'unmapped', entryIndex: idx, entryId: `unmapped:${g.term}`, alias: f, approx: false, lang: 'zh' })
    }
  })

  return {
    entries, unmapped, plain, masked,
    plainMaxLen, maskedMaxLen, aliasCount, maskedAliasCount,
    /** 兼容旧调用：全部别名的键集合 */
    surfaces: plain,
    maxLen: Math.max(plainMaxLen, maskedMaxLen),
  }
}

const ASCII_WORD_CHAR_RE = /[a-z0-9]/
const LATIN_LETTER_RE = /[a-z]/
const SHORT_LATIN_ABBR_RE = /^[a-z]{1,3}$/

/**
 * 拉丁别名的词边界判定。
 *
 * 词表里的英文别名是拿来认「HCC」「TB」「multiple myeloma」这类写法的，但**不能**
 * 在字母/数字串内部起止——否则：
 *
 *   - `5mm` / `3MM` 里的 `mm`（毫米）会被当成 multiple-myeloma 的缩写 `mm`；
 *   - `mmol/L` 里的 `mm` 同理；
 *   - `mm2`（平方毫米）也一样。
 *
 * 中文报告里毫米是最常见的单位，误命中的代价是把每一处径线都变成一个「多发性骨髓瘤」
 * 概念，所以这里必须加边界，而不是靠词表里删掉 `mm` 了事（`MM 患者` 这种真实写法还得认）。
 *
 * 另外，长度 ≤3 的纯字母缩写**隔着空格**紧跟在数字后面时同样按单位处理：
 * 「较大者约 5 mm」不该命中 Multiple Myeloma。
 */
function latinBoundaryOk(text, start, end, key) {
  if (!LATIN_LETTER_RE.test(key)) return true
  if (ASCII_WORD_CHAR_RE.test(text[start - 1] ?? '') || ASCII_WORD_CHAR_RE.test(text[end] ?? '')) return false
  if (SHORT_LATIN_ABBR_RE.test(key)) {
    let l = start - 1
    while (l >= 0 && /\s/.test(text[l])) l -= 1
    if (l >= 0 && text[l] >= '0' && text[l] <= '9') return false
  }
  return true
}

/** 在一条通道上按「当前小句内最长优先」扫描 */
function scanChannel(text, segIds, rawStartIdx, rawEndIdx, map, maxLen, raw, out) {
  if (!map.size || maxLen === 0) return
  const L = text.length
  let i = 0
  while (i < L) {
    const seg = segIds[i]
    let segEnd = i
    while (segEnd < L && segIds[segEnd] === seg) segEnd += 1
    const maxN = Math.min(maxLen, segEnd - i)
    let n = 0
    for (let k = maxN; k >= 1; k--) {
      const candidate = text.slice(i, i + k)
      if (!map.has(candidate)) continue
      // 边界不过就继续往短里试：长别名接不上时，短别名可能是合法的（如「肺门淋巴结」→「淋巴结」）
      if (!latinBoundaryOk(text, i, i + k, candidate)) continue
      n = k
      break
    }
    if (n === 0) { i += 1; continue }
    const key = text.slice(i, i + n)
    const hit = map.get(key)
    const start = rawStartIdx[i]
    const end = rawEndIdx[i + n - 1]
    out.push({
      type: hit.type,
      entryIndex: hit.entryIndex,
      entryId: hit.entryId,
      alias: hit.alias,
      approx: hit.approx,
      lang: hit.lang,
      surface: raw.slice(start, end),
      start,
      end,
      segIndex: seg,
      folded: key,
    })
    i += n
  }
}

/**
 * 在两条通道上各扫一遍，再按「起点升序、跨度降序」贪心取不重叠——
 * 等价于全局的最长优先，同时保证不会跨小句。
 */
export function matchMentions(prep, segIdOfCompact, segIdOfFold, matcher, raw) {
  const out = []
  scanChannel(prep.compact, segIdOfCompact, prep.compactRawStart, prep.compactRawEnd, matcher.plain, matcher.plainMaxLen, raw, out)
  scanChannel(prep.folded, segIdOfFold, prep.rawStart, prep.rawEnd, matcher.masked, matcher.maskedMaxLen, raw, out)

  out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const picked = []
  let lastEnd = -1
  for (const c of out) {
    if (c.start < lastEnd) continue
    picked.push(c)
    lastEnd = c.end
  }
  return picked
}

/**
 * 词表检索：给面板与 ct_lexicon 工具用。
 *
 * 一条词表条目可能引用**多个** MeSH 概念——除了自己的 `mesh`，解剖条目还带
 * `neoplasm`（该部位肿瘤概念），形态学条目带 `lymphaticMesh` 与 `candidates`。
 * 检索必须把这些一并算上：否则按 `mesh:D008113`（Liver Neoplasms）会一条都查不到，
 * 而它恰恰是「肝转移瘤」归一化时会用到的编号。
 */
export function searchLexicon(entries, query, options = {}) {
  const q = foldKey(query)
  if (!q) return []
  const limit = options.limit ?? 20
  const kind = options.kind ?? null
  const hits = []

  const conceptsOf = (e) => {
    const list = []
    if (e.mesh) list.push([e.mesh, '本条目概念'])
    if (e.neoplasm) list.push([e.neoplasm, '该部位肿瘤概念'])
    if (e.lymphaticMesh) list.push([e.lymphaticMesh, '淋巴转移特例'])
    for (const [k, v] of Object.entries(e.candidates ?? {})) list.push([v, `结节候选（${k}）`])
    return list
  }

  for (const [idx, e] of entries.entries()) {
    if (kind && e.kind !== kind) continue
    let score = 0
    let via = null
    const concepts = conceptsOf(e)
    const codeHit = concepts.find(([c]) => foldKey(c.ui) === q || foldKey(`mesh:${c.ui}`) === q)
    if (codeHit) { score = 1000; via = `MeSH 编号（${codeHit[1]}）` }
    else if (e.id && foldKey(e.id) === q) { score = 1000; via = '条目 id' }
    else {
      const nameExact = concepts.find(([c]) => foldKey(c.name) === q)
      if (nameExact) { score = 900; via = `MeSH 规范名（${nameExact[1]}）` }
      for (const a of e.zh ?? []) {
        const k = foldKey(a)
        if (k === q) { score = Math.max(score, 800); via = via ?? '中文别名（完全相同）' }
        else if (k.includes(q)) { score = Math.max(score, 400); via = via ?? '中文别名（包含）' }
      }
      for (const a of e.en ?? []) {
        const k = foldKey(a)
        if (k === q) { score = Math.max(score, 700); via = via ?? '英文别名（完全相同）' }
        else if (k.includes(q)) { score = Math.max(score, 350); via = via ?? '英文别名（包含）' }
      }
      const namePart = concepts.find(([c]) => foldKey(c.name).includes(q))
      if (!score && namePart) { score = 300; via = `MeSH 规范名（包含，${namePart[1]}）` }
      if (!score && e.note && e.note.includes(query)) { score = 100; via = '说明' }
    }
    if (score > 0) hits.push({ entry: e, index: idx, score, via })
  }
  hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))
  return hits.slice(0, limit)
}
