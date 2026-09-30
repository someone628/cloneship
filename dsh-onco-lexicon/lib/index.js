/**
 * dsh-onco-lexicon — 离线肿瘤学术语词典插件
 *
 * 提供三个工具：onco_term（查术语）、onco_abbr（缩写消歧）、onco_browse（按类别浏览），
 * 并向系统提示词注入"必须先查词典、不许编造"的使用约束。全程不联网。
 *
 * 实现说明：原项目以 TypeScript 编写，但本机 DSH 运行时**未附带 tsc/esbuild**，
 * 无法在安装期编译，故此处直接以纯 ESM JavaScript 交付（Node 24 原生执行），
 * 逻辑与原始 TS 设计一致。包内不引入任何第三方依赖。
 */
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'onco-lexicon'
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/** 浏览器面板取数用的同源 HTTP 路由 */
const RPC_ROUTE = '/dsh-onco-lexicon/rpc'

/**
 * 图标路由。客户端优先用内嵌 data URI，失败时回退到这里。
 * 之所以要两条来源：内嵌 base64 依赖构建期注入，任何让注入丢失的环节（在别的机器上
 * 重新打包、只拷源码目录等）都会让图标变成空的，只剩文字回退。
 */
const ICON_ROUTE = '/dsh-onco-lexicon/icon.png'
const ICON_FILE = fileURLToPath(new URL('../assets/icon.png', import.meta.url))

/** 面板栏目 key，客户端用 ctx.layout.selectPanel() 激活 */
export const PANEL_KEY = 'onco-lexicon'

// ---------------------------------------------------------------------------
// 文本归一化
// ---------------------------------------------------------------------------
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 标点 → 空格。
 *
 * 原始 TS 版本的字符类在转录中已损坏（`\u2015_-/` 构成反向区间，会让正则
 * 直接抛 SyntaxError），因此这里改用 Unicode 属性写法，语义等价且不会出问题：
 * 保留「字母 + 数字 + 加号」，其余（含中英文标点、全角符号）一律转为空格。
 * 特意保留 `+`，因为 ER+ / HER2+ / PR+ 在肿瘤学中是独立概念，不应与 ER- 合并。
 */
const PUNCT_RE = /[^\p{L}\p{N}+]+/gu

export function normalize(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isCJKChar(ch) {
  return !!ch && CJK_RE.test(ch)
}

/**
 * 带「归一化下标 → 原文下标」映射的归一化。
 *
 * 长文本标注必须能回到原文位置，否则没法把命中的术语高亮出来；而 normalize() 做了
 * 空白压缩与标点替换，长度和原文不再一一对应。这里逐码点做同样的转换，同时记下每个
 * 归一化字符来自原文的哪一段（mapS = 起始，mapE = 结束，均为原文下标）。
 *
 * 与 normalize() 的唯一差别：NFKC 是逐码点做的，而整串 NFKC 在极少数组合字符上会
 * 合并成不同的结果。本词典的键是中英术语，不涉及这类字符；这是为拿到位置映射的取舍。
 */
export function normalizeWithMap(text) {
  const src = String(text ?? '')
  const chars = []
  const mapS = []
  const mapE = []
  let pendingSpace = false
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const at = i
    i += ch.length
    let piece
    if (ch.length === 1) {
      // ASCII 快路径：英文段落占绝大多数，逐字符跑 NFKC + 正则没有意义
      const c = ch.charCodeAt(0)
      if (c === 43 || (c >= 48 && c <= 57)) piece = ch
      else if (c >= 65 && c <= 90) piece = ch.toLowerCase()
      else if (c >= 97 && c <= 122) piece = ch
      else piece = ch.normalize('NFKC').toLowerCase().replace(PUNCT_RE, ' ')
    } else {
      piece = ch.normalize('NFKC').toLowerCase().replace(PUNCT_RE, ' ')
    }
    for (const out of piece) {
      if (out === ' ') {
        if (chars.length) pendingSpace = true
        continue
      }
      if (pendingSpace) {
        chars.push(' ')
        mapS.push(at)
        mapE.push(at)
        pendingSpace = false
      }
      chars.push(out)
      mapS.push(at)
      mapE.push(i)
    }
  }
  return { norm: chars.join(''), mapS, mapE }
}

/**
 * 归一化文本里的「词边界」判定，供 matchTerms 使用。
 *
 * 归一化后只剩「字母 / 数字 / + / 空格 / 汉字」，因此边界只有三种情形：
 * 串首串尾、空格旁边、汉字旁边。汉字必须算边界——中文没有空格，
 * 否则「非小细胞肺癌」这种键在中文句子里永远匹配不上（后面总跟着「的」「患者」）。
 */
function isBreakChar(ch) {
  return ch === undefined || ch === ' ' || isCJKChar(ch)
}

function canStartAt(norm, p) {
  if (p === 0) return true
  if (isBreakChar(norm[p - 1])) return true
  return isCJKChar(norm[p])
}

function canEndAt(norm, end) {
  if (end >= norm.length) return true
  if (isBreakChar(norm[end])) return true
  return isCJKChar(norm[end - 1])
}

/**
 * 判定翻译方向。中文字符占比 ≥ 20% 视为中译英，否则英译中。
 *
 * 20% 这个阈值是为了照顾「NSCLC 患者」这类混写：汉字只占 28%，但作者显然在写中文。
 * 面板上另有显式的方向下拉，自动判定只负责给一个合理默认。
 */
function detectDirection(text) {
  let cjk = 0
  let latin = 0
  for (const ch of String(text ?? '')) {
    if (isCJKChar(ch)) {
      cjk++
      continue
    }
    const c = ch.charCodeAt(0)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++
  }
  const total = cjk + latin
  const ratio = total ? cjk / total : 0
  return { direction: ratio >= 0.2 ? 'zh2en' : 'en2zh', ratio, cjk, latin }
}

let segmenter = null

function wordSegments(text) {
  if (!segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  const out = []
  for (const part of segmenter.segment(text)) if (part.isWordLike) out.push(part.segment)
  return out
}

/**
 * 切词：拉丁文按空格切；中文同时产出「分词结果」和「字符二元组」。
 * 二元组保证「肺癌」能召回「非小细胞肺癌」这类长名称。
 */
export function tokenize(text) {
  const norm = normalize(text)
  if (!norm) return []
  const out = new Set()
  for (const piece of norm.split(' ')) {
    if (!piece) continue
    if (!CJK_RE.test(piece)) {
      out.add(piece)
      continue
    }
    for (const w of wordSegments(piece)) out.add(w)
    const chars = [...piece]
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return [...out]
}

/** 带提前退出的编辑距离 */
export function levenshtein(a, b, maxDist = 3) {
  if (a === b) return 0
  const al = a.length
  const bl = b.length
  if (Math.abs(al - bl) > maxDist) return maxDist + 1
  let prev = new Array(bl + 1)
  let cur = new Array(bl + 1)
  for (let j = 0; j <= bl; j++) prev[j] = j
  for (let i = 1; i <= al; i++) {
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > maxDist) return maxDist + 1
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[bl]
}

// ---------------------------------------------------------------------------
// 词典索引与检索
// ---------------------------------------------------------------------------
const W_EXACT = 1000
const W_PREFIX = 820
const W_CONTAINS = 700
const W_REVERSE = 660
const W_TOKEN = 400
const W_FUZZY = 260

/**
 * 低于此得分一律视为「未收录」。
 *
 * 没有下限时，纯粹靠字符二元组偶然重叠的查询也会产生命中：实测生造词
 * 「完全不存在的术语xyz」仅凭 6% 覆盖率就得到 25.1 分并被当成结果返回。
 * 对术语词典而言这比「查无此词」更糟——系统提示词要求模型在未收录时如实说明，
 * 而一个假命中会让它照抄引用。
 *
 * 阈值取自实测分界：噪声命中 25.1，而合法的弱匹配（如「抗肿瘤药物」以 14%
 * 覆盖率命中药物条目）为 55.8。45 落在两者之间。
 */
const MIN_SCORE = 45

/**
 * 词条的全部可检索键。
 *
 * 除名称/别名/缩写外，还把外部编码（MeSH、UMLS、NCIt 等）的**裸值**并入，
 * 于是 `D002289` 可精确命中（得 1000 分）。
 *
 * 特意**不**把 `mesh:D002289` 这种带词表前缀的写法做成键：那样 `mesh` 会成为一个
 * 独立 token，而每个带 MeSH 编码的词条都含有它，于是查 `mesh:D002289` 会把所有
 * MeSH 词条一起带出来。只放裸值时，带前缀的查询仍能命中——normalize 把冒号转成空格后
 * 得到 token `d002289`，走 token/reverse-contains 路径匹配到同一个词条，且没有副作用。
 */
function collectKeys(entry) {
  const raw = [entry.en, entry.zh, ...(entry.abbr ?? []), ...(entry.aliases ?? [])]
  const codes = entry.codes
  if (codes && typeof codes === 'object') {
    for (const value of Object.values(codes)) {
      if (value === null || value === undefined || value === '') continue
      raw.push(String(value))
    }
  }
  const out = new Set()
  for (const v of raw) {
    if (!v) continue
    const k = normalize(v)
    if (k) out.add(k)
  }
  return [...out]
}

function pushIndex(map, key, value) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function dedupe(hits) {
  const best = new Map()
  for (const hit of hits) {
    const prev = best.get(hit.entry.id)
    if (!prev || hit.score > prev.score) best.set(hit.entry.id, hit)
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || String(a.entry.en).localeCompare(String(b.entry.en)),
  )
}

export class Lexicon {
  constructor(entries, options = {}) {
    this.entries = entries
    this.fuzzy = options.fuzzy ?? true
    this.fuzzyScanLimit = options.fuzzyScanLimit ?? 200000
    this.minScore = options.minScore ?? MIN_SCORE
    this.docs = []
    this.exact = new Map()
    this.postings = new Map()
    this.df = new Map()
    this.abbrIndex = new Map()
    this.sortedKeys = []
    // 下位概念索引：父概念名(归一化) -> 子词条下标。
    // 原始数据只有 parents（指向上位），把它反过来就能回答「谁属于这个概念」。
    this.childrenOf = new Map()
    // id -> 下标，供关联推荐按 id 定位词条
    this.byId = new Map()
    this.build()
  }

  build() {
    for (const entry of this.entries) {
      const keys = collectKeys(entry)
      const tf = new Set()
      for (const k of keys) for (const t of tokenize(k)) tf.add(t)
      this.docs.push({ entry, keys, tf })
    }
    this.docs.forEach((doc, i) => {
      for (const key of doc.keys) pushIndex(this.exact, key, i)
      for (const t of doc.tf) pushIndex(this.postings, t, i)
      for (const abbr of doc.entry.abbr ?? []) pushIndex(this.abbrIndex, normalize(abbr), i)
      for (const parent of doc.entry.parents ?? []) {
        pushIndex(this.childrenOf, normalize(parent), i)
      }
      if (doc.entry.id) this.byId.set(normalize(String(doc.entry.id)), i)
    })
    this.df.clear()
    for (const [token, list] of this.postings) this.df.set(token, list.length)
    for (const abbr of this.abbrIndex.keys()) {
      this.df.set(`abbr:${abbr}`, this.df.get(`abbr:${abbr}`) ?? 1)
    }
    this.sortedKeys = [...this.exact.keys()].sort()
    // 按长度分桶，供 fuzzyHits 只扫长度相近的键（见 fuzzyHits 的说明）
    this.byLength = new Map()
    for (const key of this.sortedKeys) {
      const len = key.length
      let bucket = this.byLength.get(len)
      if (!bucket) {
        bucket = []
        this.byLength.set(len, bucket)
      }
      bucket.push(key)
    }
    // 首字符 -> 该首字符下所有键的长度（去重、降序）。长文本标注用它做最长匹配：
    // 在每个起点只需试「该首字符真实存在的长度」，而不是从 maxKeyLen 一路试下来。
    this.keyLens = new Map()
    this.maxKeyLen = 0
    for (const key of this.sortedKeys) {
      const len = key.length
      if (len < 2) continue // 单字符键全是噪声（单个汉字 / 单个字母）
      const first = key[0]
      let arr = this.keyLens.get(first)
      if (!arr) {
        arr = []
        this.keyLens.set(first, arr)
      }
      arr.push(len)
      if (len > this.maxKeyLen) this.maxKeyLen = len
    }
    for (const arr of this.keyLens.values()) {
      const uniq = [...new Set(arr)].sort((a, b) => b - a)
      arr.length = 0
      for (const n of uniq) arr.push(n)
    }
  }

  idf(token) {
    const n = this.docs.length || 1
    const df = this.df.get(token) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  candidates(q, qTokens) {
    const out = new Set()
    for (const i of this.exact.get(q) ?? []) out.add(i)
    // 前缀扫描：在排序键数组上二分定位首个 >= q 的位置
    const keys = this.sortedKeys
    let lo = 0
    let hi = keys.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (keys[mid] < q) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < keys.length; i++) {
      const key = keys[i]
      if (!key.startsWith(q)) break
      for (const d of this.exact.get(key) ?? []) out.add(d)
    }
    for (const t of qTokens) {
      for (const d of this.postings.get(t) ?? []) out.add(d)
    }
    return out
  }

  scoreDoc(doc, q, qTokens, qIdfSum) {
    let best = 0
    let via = ''
    for (const key of doc.keys) {
      if (key === q) {
        return { entry: doc.entry, score: W_EXACT, via: `精确命中「${key}」` }
      }
      if (q.length >= 2 && key.startsWith(q)) {
        const s = W_PREFIX - Math.min(120, (key.length - q.length) * 10)
        if (s > best) {
          best = s
          via = `前缀命中「${key}」`
        }
      }
      if (key.length >= 2 && key.includes(q)) {
        const s = W_CONTAINS - Math.min(150, (key.length - q.length) * 5)
        if (s > best) {
          best = s
          via = `包含命中「${key}」`
        }
      }
      if (q.length >= 2 && q.includes(key)) {
        // 反向包含要求 key 至少覆盖查询的 1/3。没有这个门槛时，任何含 "xy" 的查询都会把
        // 「XY Genotype」顶上来：实测查询「完全不存在的术语xyz」被这条规则打出 615 分，
        // 直接越过 MIN_SCORE 成了假命中——正是本插件最该避免的那类错误。
        if (key.length * 3 >= q.length) {
          const s = W_REVERSE - Math.min(150, (q.length - key.length) * 5)
          if (s > best) {
            best = s
            via = `命中「${key}」`
          }
        }
      }
    }
    if (qIdfSum > 0) {
      let hitIdf = 0
      for (const t of qTokens) if (doc.tf.has(t)) hitIdf += this.idf(t)
      const coverage = hitIdf / qIdfSum
      if (coverage > 0) {
        const s = W_TOKEN * coverage + 60 * coverage * coverage
        if (s > best) {
          best = s
          via = `关键词匹配（覆盖率 ${(coverage * 100).toFixed(0)}%）`
        }
      }
    }
    if (best <= 0) return null
    return { entry: doc.entry, score: best, via }
  }

  /**
   * 模糊匹配：编辑距离 ≤ 2 的键。
   *
   * 只在「长度相近的桶」里扫，而不是在 sortedKeys 上从头扫。
   * 旧实现是从头扫、撞到 fuzzyScanLimit(=8000) 就停，而 sortedKeys 是**按字母排序**的，
   * 等于只扫到字母靠前的键：实测查询 "cisplatni" 时正确答案 "cisplatin" 排在长度筛选序列的
   * 第 14303 位，限额 8000 直接把它挡在外面——差一个字母也永远搜不到，而且漏得毫无规律。
   * 分桶后候选集完整覆盖（长度 ±2），实测 18.5 万词条下约 22 ms，对用户主动开启的
   * 模糊检索完全可接受。fuzzyScanLimit 退化为纯粹的安全上限，正常不会触发。
   */
  fuzzyHits(q) {
    if (q.length < 3) return []
    const out = []
    let scanned = 0
    for (let len = q.length - 2; len <= q.length + 2; len++) {
      const bucket = this.byLength.get(len)
      if (!bucket) continue
      for (const key of bucket) {
        if (++scanned > this.fuzzyScanLimit) return out
        const d = levenshtein(q, key, 2)
        if (d > 2) continue
        const score = W_FUZZY - d * 40
        for (const i of this.exact.get(key) ?? []) {
          out.push({ entry: this.docs[i].entry, score, via: `模糊匹配「${key}」（编辑距离 ${d}）` })
        }
      }
    }
    return out
  }

  /**
   * 通用检索：术语、别名、缩写、中英文混输皆可。
   *
   * `filter` 是可选的 `(entry) => boolean`，用于按类别 / 出处筛查。**必须传进候选循环**
   * 而不是事后过滤结果——事后过滤会让 topK 被不符条件的条目占满，实际返回只剩几条。
   */
  search(query, topK = 5, filter = null, options = {}) {
    const q = normalize(query)
    if (!q) return []
    const qTokens = tokenize(q)
    let qIdfSum = 0
    for (const t of qTokens) qIdfSum += this.idf(t)

    const collected = []
    for (const i of this.candidates(q, qTokens)) {
      const doc = this.docs[i]
      if (filter && !filter(doc.entry)) continue
      const hit = this.scoreDoc(doc, q, qTokens, qIdfSum)
      if (hit) collected.push(hit)
    }
    // 默认只在「没有像样命中」时才启用模糊匹配；options.fuzzy=true 则强制启用
    //（面板的「模糊检索」开关，用于拼写有误时仍能找出近似术语）。
    const wantFuzzy = options.fuzzy === true
    if (this.fuzzy && (wantFuzzy || !collected.some((h) => h.score >= 300))) {
      const fuzzy = this.fuzzyHits(q)
      collected.push(...(filter ? fuzzy.filter((h) => filter(h.entry)) : fuzzy))
    }
    // 低于下限的弱命中按「未收录」处理，避免用噪声冒充结果
    return dedupe(collected)
      .filter((h) => h.score >= this.minScore)
      .slice(0, topK)
  }

  /** 缩写专用查询：返回该缩写的全部义项，供模型消歧 */
  lookupAbbr(abbr, topK = 10, filter = null) {
    const q = normalize(abbr)
    if (!q) return []
    const keep = (entry) => !filter || filter(entry)
    const hits = []
    for (const i of this.abbrIndex.get(q) ?? []) {
      if (keep(this.docs[i].entry)) {
        hits.push({ entry: this.docs[i].entry, score: W_EXACT, via: '缩写完全匹配' })
      }
    }
    for (const [key, list] of this.abbrIndex) {
      if (key === q || !key.startsWith(q) || q.length < 2) continue
      for (const i of list) {
        if (!keep(this.docs[i].entry)) continue
        hits.push({ entry: this.docs[i].entry, score: W_PREFIX - 200, via: `缩写前缀匹配「${key}」` })
      }
    }
    return dedupe(hits).slice(0, topK)
  }

  browse(category, keyword, limit = 30, filter = null) {
    const kw = keyword ? normalize(keyword) : ''
    const out = []
    for (const doc of this.docs) {
      if (category && doc.entry.category !== category) continue
      if (filter && !filter(doc.entry)) continue
      if (kw && !doc.keys.some((k) => k.includes(kw))) continue
      out.push(doc.entry)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * 关联推荐：上位概念 / 下位概念 / 名称近似。
   *
   * - 上位：直接用词条自带的 parents，按名字查精确索引
   * - 下位：把 parents 反过来查 childrenOf（谁把本词条列为上位）
   * - 近似：用本词条 token 的倒排表取候选，再算 Jaccard。
   *   不对 18.5 万条做全量两两比较——那是 170 亿次，不可行。
   */
  related(entry, limit = 10) {
    const self = this.byId.get(normalize(String((entry && entry.id) ?? '')))
    const used = new Set(self === undefined ? [] : [self])
    const take = (i) => {
      if (i === undefined || used.has(i)) return null
      used.add(i)
      return this.docs[i].entry
    }

    const parents = []
    for (const p of (entry && entry.parents) ?? []) {
      for (const i of this.exact.get(normalize(p)) ?? []) {
        const e = take(i)
        if (e) parents.push(e)
      }
    }

    const children = []
    for (const i of this.childrenOf.get(normalize(String((entry && entry.en) ?? ''))) ?? []) {
      const e = take(i)
      if (e) children.push(e)
    }

    const similar = []
    const selfDoc = self === undefined ? undefined : this.docs[self]
    if (selfDoc) {
      const shared = new Map()
      for (const t of selfDoc.tf) {
        for (const i of this.postings.get(t) ?? []) {
          if (i === self) continue
          shared.set(i, (shared.get(i) ?? 0) + 1)
        }
      }
      const mine = selfDoc.tf.size
      const ranked = []
      for (const [i, common] of shared) {
        if (common < 2 || used.has(i)) continue // 只共享 1 个 token 的太大路货
        const theirs = this.docs[i].tf.size
        ranked.push({ i, jac: common / (mine + theirs - common), common })
      }
      ranked.sort((a, b) => b.jac - a.jac || b.common - a.common)
      for (const r of ranked) {
        if (similar.length >= limit) break
        const e = take(r.i)
        if (e) similar.push({ entry: e, score: Math.round(r.jac * 1000) / 1000, shared: r.common })
      }
    }

    return { parents: parents.slice(0, limit), children: children.slice(0, limit), similar }
  }

  /**
   * 在一个合法起点上，从长到短试键。返回命中的键与归一化区间，未命中返回 null。
   *
   * 边界规则（两条都不能少）：
   * - 拉丁词内部不许起止：`her2` 不该命中 `her2neu` 里的片段；
   * - 中文字符自身构成边界：中文没有空格，若只认空格边界，整串中文将永远匹配不上。
   */
  matchAt(norm, p, minLen) {
    const n = norm.length
    const lens = this.keyLens.get(norm[p])
    if (!lens) return null
    for (const L of lens) {
      if (L < minLen) break // lens 已降序
      const end = p + L
      if (end > n) continue
      if (!canEndAt(norm, end)) continue
      const key = norm.slice(p, end)
      const ids = this.exact.get(key)
      if (ids && ids.length) return { key, normStart: p, normEnd: end, ids }
    }
    return null
  }

  /**
   * 在自由文本里做「最长匹配」术语标注。
   *
   * 与 search 的方向相反：search 是「拿查询找词条」，这里是「拿词条找文本中的出现位置」，
   * 因此必须给出原文 span，供面板高亮。
   */
  matchTerms(text, options = {}) {
    const minLen = Math.max(2, Number(options.minLen) || 2)
    const limit = Math.min(Math.max(Number(options.limit) || 400, 1), 4000)
    const src = String(text ?? '')
    const { norm, mapS, mapE } = normalizeWithMap(src)
    const n = norm.length
    const spans = []
    if (!n) return spans
    for (let p = 0; p < n; ) {
      if (!canStartAt(norm, p)) {
        p++
        continue
      }
      const hit = this.matchAt(norm, p, minLen)
      if (!hit) {
        p++
        continue
      }
      spans.push({
        key: hit.key,
        start: mapS[hit.normStart],
        // 用「最后一个命中字符的原文结束下标」，而不是 mapS[normEnd]：
        // 后者会把紧随其后的那个空格一起圈进来（归一化折叠空格时归属到了下一个字符）。
        end: mapE[hit.normEnd - 1],
        ids: hit.ids,
      })
      p = hit.normEnd
      if (spans.length > limit) break
    }
    return spans
  }

  /**
   * 一个键可能对应多个词条（同名、别名撞车），按「翻译方向」挑最合适的那个。
   *
   * 关键判据是**有没有目标语言的名称**：英译中时没中文名的条目翻不出来，只能标注出来
   * 提示「词典未收录中文名」；中译英时同理。
   */
  pickEntry(ids, key, direction) {
    let best = null
    let bestScore = -Infinity
    for (const i of ids) {
      const e = this.docs[i].entry
      let s = 0
      if (direction === 'zh2en') {
        if (e.zh && normalize(e.zh) === key) s += 100
        if (e.zh) s += 25
        if (e.en) s += 10
      } else {
        if (e.en && normalize(e.en) === key) s += 100
        if (e.zh) s += 40
        if (e.en) s += 10
      }
      if (Array.isArray(e.sources) && e.sources.includes('自建库')) s += 15
      if (Array.isArray(e.abbr) && e.abbr.some((a) => normalize(a) === key)) s += 20
      // 平局时取名字更短的：更可能是那个"标准术语"，而不是一长串限定描述
      s -= Math.min(9, String(e.en ?? '').length / 20)
      if (s > bestScore) {
        bestScore = s
        best = e
      }
    }
    return best
  }

  /**
   * 词典式「翻译」：不是机器翻译，而是把文本里命中的术语逐条换成词典标准名/中文名。
   *
   * 明确不做的事：语序调整、语法重组、整句润色。离线词典没有能力做这些，
   * 假装能做只会产出读起来通顺但内容错误的译文——对医学文本比"看不懂"更危险。
   */
  translate(text, options = {}) {
    const src = String(text ?? '')
    const det = detectDirection(src)
    const want = options.direction
    const direction = want === 'zh2en' || want === 'en2zh' ? want : det.direction
    const maxSpans = Math.min(Math.max(Number(options.limit) || 400, 1), 2000)
    const raw = this.matchTerms(src, { limit: maxSpans })
    const truncated = raw.length >= maxSpans

    const segments = []
    const agg = new Map()
    let matchedChars = 0
    let cursor = 0
    for (const span of raw) {
      const entry = this.pickEntry(span.ids, span.key, direction)
      if (!entry) continue
      const missing = direction === 'en2zh' ? !entry.zh : !entry.en
      if (span.start > cursor) segments.push({ text: src.slice(cursor, span.start), term: null })
      segments.push({
        text: src.slice(span.start, span.end),
        term: { entry, key: span.key, missing },
      })
      cursor = span.end
      matchedChars += span.end - span.start
      const prev = agg.get(entry.id)
      if (prev) prev.count += 1
      else {
        agg.set(entry.id, {
          entry,
          key: span.key,
          // 原文里实际出现的写法（保留大小写与连字符），比归一化后的 key 更便于核对
          surface: src.slice(span.start, span.end),
          length: span.key.length,
          count: 1,
          missing,
        })
      }
    }
    if (cursor < src.length) segments.push({ text: src.slice(cursor), term: null })

    const terms = [...agg.values()].sort(
      (a, b) =>
        b.length - a.length ||
        b.count - a.count ||
        String(a.entry.en ?? '').localeCompare(String(b.entry.en ?? '')),
    )
    const missingTerms = terms.filter((t) => t.missing).length

    // 整段就是一个术语时，额外给一条「最相近词条」——短查询走 search 的打分路径，
    // 靠二元组覆盖率也能召回，比严格键匹配宽容得多（中文查询尤其需要）。
    let primary = null
    let primaryVia = null
    const trimmed = src.trim()
    if (trimmed && trimmed.length <= 60 && !trimmed.includes('\n')) {
      const best = this.search(trimmed, 1)[0]
      if (best) {
        primary = best.entry
        primaryVia = best.via
      }
    }

    const notes = []
    notes.push('本结果为离线词典的逐词对照，不是机器翻译：不做语序调整、语法重组与整句润色。')
    if (direction === 'en2zh' && missingTerms > 0) {
      notes.push(
        `命中的 ${terms.length} 个术语中有 ${missingTerms} 个没有中文名——` +
          '词典里带中文名的条目只有 106 条（人工整理），其余为纯英文 NCIt 本体。' +
          '这些术语已保留英文原名并标出类别 / 语义类型，未作任何翻译。',
      )
    }
    if (direction === 'zh2en' && raw.length === 0 && trimmed) {
      notes.push(
        '中文原文未命中任何词典条目。词典共 185,885 条，但带中文名的仅 106 条，' +
          '中文段落能标注出的术语因此非常有限；单个中文术语建议改用「术语检索」。',
      )
    }
    if (truncated) notes.push(`命中数量已达上限 ${maxSpans} 处，后面的未再标注。`)

    return {
      ok: true,
      direction,
      autoDirection: det.direction,
      zhRatio: det.ratio,
      cjkChars: det.cjk,
      latinChars: det.latin,
      stats: {
        chars: src.length,
        spans: segments.filter((s) => s.term).length,
        distinctTerms: terms.length,
        translatedTerms: terms.length - missingTerms,
        missingTerms,
        matchedChars,
        coverage: src.length ? matchedChars / src.length : 0,
      },
      segments,
      terms,
      primary,
      primaryVia,
      truncated,
      notes,
    }
  }

  stats() {
    const byCategory = {}
    const bySource = {}
    const byType = {}
    for (const doc of this.docs) {
      const c = doc.entry.category
      byCategory[c] = (byCategory[c] ?? 0) + 1
      // sources 是数组（如 ["NCIt","自建库"]），逐项计数；缺失时回落成 NCIt
      const srcs = doc.entry.sources && doc.entry.sources.length ? doc.entry.sources : ['NCIt']
      for (const s of srcs) bySource[s] = (bySource[s] ?? 0) + 1
      // NCIt 语义类型：精确维度，覆盖面比 7 个粗类别广得多
      for (const t of doc.entry.types ?? []) byType[t] = (byType[t] ?? 0) + 1
    }
    return { total: this.docs.length, byCategory, bySource, byType }
  }

  /** 索引规模（性能面板用）。遍历一次倒排表，算好后缓存。 */
  indexStats() {
    if (this._indexStats) return this._indexStats
    let postings = 0
    for (const list of this.postings.values()) postings += list.length
    this._indexStats = {
      docs: this.docs.length,
      terms: this.postings.size,
      keys: this.sortedKeys.length,
      postings,
      childKeys: this.childrenOf.size,
      ids: this.byId.size,
    }
    return this._indexStats
  }
}

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------
const DISCLAIMER =
  '以上内容来自本地离线词典，仅供科研与文献理解参考，不构成诊疗建议；' +
  '编码与释义请以官方词表（NCIt / MeSH）最新版本为准。'

const CATEGORY_LABEL = {
  disease: '疾病',
  concept: '基础概念',
  biomarker: '生物标志物 / 分子靶点',
  drug: '抗肿瘤药物',
  endpoint: '临床试验终点',
  method: '实验技术 / 检测方法',
  treatment: '治疗方式',
}

function formatEntry(entry, index, via, score) {
  const title = entry.zh ? `${entry.zh}（${entry.en}）` : entry.en
  const lines = [`${index}. ${title}`]
  if (via) {
    const tail = score === undefined ? '' : `，得分 ${score.toFixed(0)}`
    lines.push(`   匹配依据：${via}${tail}`)
  }
  if (entry.abbr?.length) lines.push(`   缩写：${entry.abbr.join('、')}`)
  if (entry.aliases?.length) lines.push(`   别名：${entry.aliases.join('；')}`)
  lines.push(`   类别：${CATEGORY_LABEL[entry.category] ?? entry.category}`)
  if (entry.parents?.length) lines.push(`   上位概念：${entry.parents.join('；')}`)
  const codes = Object.entries(entry.codes ?? {})
  if (codes.length) {
    lines.push(`   编码：${codes.map(([k, v]) => `${k.toUpperCase()}:${v}`).join('，')}`)
  }
  if (entry.def) lines.push(`   释义：${entry.def}`)
  // 只在「确由自建库贡献」时才单独标出处：185k 条纯 NCIt 都标一遍只是噪声，
  // 而合并过的条目（带中文名/中文释义/MeSH）才是需要让模型和用户看清来路的。
  const srcs = entry.sources && entry.sources.length ? entry.sources : []
  if (srcs.length > 1) lines.push(`   出处：${srcs.join(' + ')}（已合并）`)
  if (entry.source) lines.push(`   来源：${entry.source}`)
  return lines.join('\n')
}

export function renderHits(hits, query, dictLabel) {
  if (!hits.length) {
    return [
      `未在离线词典中检索到「${query}」。`,
      `当前词典：${dictLabel}。`,
      '请勿据此推测或编造该术语的定义、别名与编码；可建议用户核对术语拼写，或改用手头权威资料。',
    ].join('\n')
  }
  const head = `查询「${query}」命中 ${hits.length} 条（词典：${dictLabel}）`
  const body = hits.map((h, i) => formatEntry(h.entry, i + 1, h.via, h.score)).join('\n\n')
  return `${head}\n\n${body}\n\n${DISCLAIMER}`
}

export function renderAbbr(hits, abbr, dictLabel) {
  if (!hits.length) {
    return `离线词典中未收录缩写「${abbr}」（词典：${dictLabel}）。请勿臆测其含义，可提示用户给出上下文或全称。`
  }
  if (hits.length === 1) return renderHits(hits, abbr, dictLabel)
  const head =
    `缩写「${abbr}」在离线词典中共有 ${hits.length} 个义项（词典：${dictLabel}）：\n` +
    '该缩写存在歧义，请结合上下文向用户确认所指，不要默认取第一条。'
  const body = hits.map((h, i) => formatEntry(h.entry, i + 1, h.via)).join('\n\n')
  return `${head}\n\n${body}\n\n${DISCLAIMER}`
}

export function renderBrowse(entries, category, dictLabel) {
  if (!entries.length) {
    return `离线词典中该类目下没有匹配词条（类别：${category ?? '全部'}，词典：${dictLabel}）。`
  }
  const head = `词典类目「${category ?? '全部'}」下的词条（显示 ${entries.length} 条，词典：${dictLabel}）`
  const body = entries
    .map((e, i) => {
      const nm = e.zh ? `${e.zh} / ${e.en}` : e.en
      const abbr = e.abbr?.length ? `（${e.abbr.join('、')}）` : ''
      return `${i + 1}. ${nm}${abbr}`
    })
    .join('\n')
  return `${head}\n\n${body}`
}

/**
 * 翻译对照的工具文本输出。
 *
 * 措辞上刻意不把结果叫「译文」：这些是词典标准名的逐词替换，句法仍是原文的。
 * 模型若把它当译文转述给用户，就会把「术语对照」包装成「我翻译了这段」。
 */
export function renderTranslate(result, dictLabel) {
  const dirLabel = result.direction === 'zh2en' ? '中→英' : '英→中'
  const head =
    `词典式术语对照（方向：${dirLabel}，词典：${dictLabel}）\n` +
    `命中术语 ${result.stats.distinctTerms} 个（其中 ${result.stats.translatedTerms} 个有目标语言名称），` +
    `共 ${result.stats.spans} 处，覆盖原文字符 ${(result.stats.coverage * 100).toFixed(1)}%。`
  const parts = [head]
  if (result.primary) {
    parts.push(`最相近词条：\n${formatEntry(result.primary, 1, result.primaryVia)}`)
  }
  if (result.terms.length) {
    const rows = result.terms
      .map((t, i) => {
        const e = t.entry
        const surface = t.surface ?? t.key
        const pair =
          result.direction === 'zh2en'
            ? `${e.zh ?? surface} = ${e.en}`
            : `${surface} = ${e.zh ?? '（词典未收录中文名）'}`
        const meta = [`类别：${CATEGORY_LABEL[e.category] ?? e.category}`]
        if (e.abbr?.length) meta.push(`缩写：${e.abbr.join('、')}`)
        const codes = Object.entries(e.codes ?? {})
        if (codes.length) meta.push(`编码：${codes.map(([k, v]) => `${k.toUpperCase()}:${v}`).join('，')}`)
        meta.push(`原文出现 ${t.count} 次`)
        return `${i + 1}. ${pair}\n   ${meta.join('；')}`
      })
      .join('\n')
    parts.push(`【术语对照】\n${rows}`)
  } else {
    parts.push('【术语对照】\n原文中没有命中词典中的任何术语（未作任何翻译，也未编造译名）。')
  }
  if (result.notes?.length) parts.push(`【说明】\n${result.notes.map((n) => `- ${n}`).join('\n')}`)
  return `${parts.join('\n\n')}\n\n${DISCLAIMER}`
}

/**
 * 逐字符对照的工具文本输出。长文本走这条，因为它能保留原文语序，
 * 读者能一眼看出「哪个词被换成了什么」，而不是看到一句伪装成译文的拼接串。
 */
export function renderTranslateSegments(result, dictLabel) {
  const dirLabel = result.direction === 'zh2en' ? '中→英' : '英→中'
  const header =
    `逐词对照（方向：${dirLabel}，词典：${dictLabel}）\n` +
    '格式：原文[[标准名]]；方括号内是词典给出的对应名称，其余原文原样保留，未作润色。\n\n'
  let body = ''
  for (const seg of result.segments) {
    if (!seg.term) {
      body += seg.text
      continue
    }
    const e = seg.term.entry
    const shown = result.direction === 'zh2en' ? e.en : (e.zh ?? `未收录中文名：${e.en}`)
    body += `${seg.text}[[${shown}]]`
  }
  return header + body
}

// ---------------------------------------------------------------------------
// 词典定位与加载
// ---------------------------------------------------------------------------
function readJsonl(file) {
  const entries = []
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, lineNo) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) return
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed.id === 'string' && typeof parsed.en === 'string') {
        entries.push(parsed)
      }
    } catch {
      throw new Error(`词典第 ${lineNo + 1} 行不是合法 JSON`)
    }
  })
  return entries
}

/** 安全写日志：不同版本上下文对象的日志接口存在差异，失败不影响主流程 */
function logInfo(ctx, message) {
  try {
    ctx?.logger?.info?.(`[onco-lexicon] ${message}`)
  } catch {
    /* 忽略 */
  }
}

/** 定位词典文件：显式配置 > 全量 NCIt 构建产物 > 内置种子词典 */
function resolveDict(ctx, config) {
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
  if (config.dictPath) {
    const file = config.dictPath.startsWith('/')
      ? config.dictPath
      : fileURLToPath(new URL(config.dictPath, `file://${pluginRoot}/`))
    if (!existsSync(file)) throw new Error(`指定的词典文件不存在：${file}`)
    return { file, label: file }
  }
  const full = fileURLToPath(new URL('../data/onco.ncit.jsonl', import.meta.url))
  if (existsSync(full)) return { file: full, label: 'NCIt 全量词典（本地构建）' }
  const seed = fileURLToPath(new URL('../data/onco.seed.jsonl', import.meta.url))
  if (existsSync(seed)) {
    logInfo(ctx, '未找到 NCIt 全量词典，已回退到内置种子词典')
    return { file: seed, label: '内置种子词典（覆盖有限）' }
  }
  throw new Error('未找到任何词典文件，请检查 data/ 目录或配置 dictPath')
}

export const CATEGORIES = [
  'disease',
  'concept',
  'biomarker',
  'drug',
  'endpoint',
  'method',
  'treatment',
]

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const topK = config.topK && config.topK > 0 ? config.topK : 5
  let lex = null
  let dictLabel = '（加载失败）'
  let loadError = null
  let loadMs = null
  let dictBytes = null

  // 查询耗时统计：面板的「性能统计」用它算平均 / p95 / 最慢。
  // 只保留最近 MAX_SAMPLES 个样本，避免常驻内存无限增长。
  const MAX_SAMPLES = 300
  const queryStats = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, samples: [] }
  function recordQuery(ms) {
    queryStats.count += 1
    queryStats.totalMs += ms
    queryStats.lastMs = ms
    if (ms > queryStats.maxMs) queryStats.maxMs = ms
    queryStats.samples.push(ms)
    if (queryStats.samples.length > MAX_SAMPLES) queryStats.samples.shift()
  }

  try {
    const t0 = performance.now()
    const resolved = resolveDict(ctx, config)
    const entries = readJsonl(resolved.file)
    if (!entries.length) throw new Error('词典为空')
    lex = new Lexicon(entries, {
      fuzzy: config.fuzzy ?? true,
      minScore: config.minScore,
    })
    loadMs = performance.now() - t0
    try {
      dictBytes = statSync(resolved.file).size
    } catch { /* 拿不到体积不影响功能 */ }
    dictLabel = resolved.label
    logInfo(ctx, `已加载 ${entries.length} 条词条（${dictLabel}），耗时 ${loadMs.toFixed(0)} ms`)
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    logInfo(ctx, `词典加载失败：${loadError}`)
  }

  const dictNote = loadError ? `（词典不可用：${loadError}）` : `（词典：${dictLabel}）`

  // ---------- 提示词层：约束模型必须查词典、不许编造 ----------
  try {
    ctx.systemPrompt.section({
      name: 'onco-lexicon-usage',
      order: 45,
      text: [
        '本环境装有一部离线肿瘤学术语词典（工具名 onco_term / onco_abbr / onco_browse / onco_translate）。',
        '当用户询问肿瘤学术语、缩写、生物标志物、抗肿瘤药物、临床试验终点的名称、释义或编码时：',
        '1. 必须先调用 onco_term（查术语）或 onco_abbr（查缩写），不要凭记忆作答。',
        '2. 工具返回「未收录」时，必须如实说明词典中未收录，禁止编造释义、别名、编码或文献出处。',
        '3. 缩写往往有多个义项（例如 OS、PD、MM）。工具返回多个义项时，必须先向用户确认所指或说明歧义，不要默认取第一条。',
        '4. 引用编码时注明来源词表；本词典的编码字段仅供线索，正式引用应以 NCIt / MeSH 官方版本核对。',
        '5. 涉及具体用药剂量、方案选择、诊断结论的问题，只做文献层面的名词解释，并提示用户以临床指南和医师意见为准。',
        '6. onco_translate 只做「术语级对照」，不是机器翻译：词典不提供语序调整与语法重组能力。',
        '   严禁把术语对照结果包装成流畅译文转述给用户；未被词典收录的部分必须原样保留，不得自行补译。',
        '   词典中带中文名的条目仅 106 条（人工整理），英译中时大量术语没有中文名，此时应如实说明，不要替它编一个中文名。',
      ].join('\n'),
    })
  } catch (error) {
    logInfo(ctx, `系统提示词注入失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // ---------- 工具层 ----------
  const textOutput = (fn) => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  })

  /** 出处取值：与面板 RPC 的 SOURCES 保持同一套字面量 */
  const SOURCE_VALUES = ['NCIt', '自建库']

  /** 工具层的类别 / 出处 / 语义类型筛查条件（语义与 RPC 的 makeFilter 一致） */
  function toolFilter(args) {
    const cat = CATEGORIES.includes(args && args.category) ? args.category : ''
    const src = SOURCE_VALUES.includes(args && args.source) ? args.source : ''
    const typ = args && typeof args.ncitType === 'string' ? args.ncitType.trim() : ''
    if (!cat && !src && !typ) return null
    return (entry) => {
      if (cat && entry.category !== cat) return false
      if (src) {
        const es = entry.sources && entry.sources.length ? entry.sources : ['NCIt']
        if (!es.includes(src)) return false
      }
      if (typ && !(entry.types ?? []).includes(typ)) return false
      return true
    }
  }

  /** 把生效的筛查条件回显给模型，避免它误以为结果被截断 */
  function describeScope(args) {
    const bits = []
    if (CATEGORIES.includes(args && args.category)) {
      bits.push(`类别=${CATEGORY_LABEL[args.category] ?? args.category}`)
    }
    if (SOURCE_VALUES.includes(args && args.source)) bits.push(`出处=${args.source}`)
    const typ = args && typeof args.ncitType === 'string' ? args.ncitType.trim() : ''
    if (typ) bits.push(`类型=${typ}`)
    return bits.length ? `【已按 ${bits.join('，')} 筛查】` : ''
  }

  ctx.tools.register(
    defineTool({
      name: 'onco_term',
      description:
        '在本地离线肿瘤学词典中查询术语。支持中文名、英文名、缩写、别名、' +
        '外部编码（如 MeSH 的 D002289，或带词表的 mesh:D002289）与中英混输，' +
        '返回标准名称、缩写、别名、类别、释义与外部编码。查询肿瘤学术语、药物、标志物、' +
        '临床试验终点、实验方法时优先使用本工具。',
      parameters: {
        term: {
          type: 'string',
          required: true,
          description: '要查询的术语，例如「非小细胞肺癌」「NSCLC」「奥希替尼」「PFS」',
        },
        topK: { type: 'number', description: '返回条数上限，默认 5' },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description:
            '可选：只在指定类别内检索。disease（疾病）、concept（基础概念）、' +
            'biomarker（标志物/靶点）、drug（药物）、endpoint（临床试验终点）、' +
            'method（实验方法）、treatment（治疗方式）。用于把结果收窄到某一类。',
        },
        source: {
          type: 'string',
          enum: ['NCIt', '自建库'],
          description:
            '可选：按术语出处筛查。NCIt = NCIt 本体；自建库 = 人工整理并合并进来的概念' +
            '（含中文名、中文释义与 MeSH 编码）。',
        },
        ncitType: {
          type: 'string',
          description:
            '可选：按 NCIt 权威语义类型精确筛查，比 category 更细。常用值：' +
            'Neoplastic Process（肿瘤过程）、Disease or Syndrome（疾病）、' +
            'Pharmacologic Substance（药物）、Gene or Genome（基因）、' +
            'Amino Acid, Peptide, or Protein（蛋白）、Enzyme（酶）、Receptor（受体）、' +
            'Laboratory Procedure（实验室方法）、Therapeutic or Preventive Procedure（治疗操作）。',
        },
      },
      output: textOutput(),
      execute(args) {
        if (!lex) return `肿瘤学词典不可用${dictNote}，无法查询，请勿据记忆作答。`
        const k = args.topK && args.topK > 0 ? Math.min(args.topK, 20) : topK
        const filter = toolFilter(args)
        const hits = lex.search(args.term, k, filter)
        const scope = describeScope(args)
        const body = renderHits(hits, args.term, dictLabel)
        return scope ? `${scope}\n\n${body}` : body
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'onco_abbr',
      description:
        '查询肿瘤学缩写的全部可能义项，用于消歧。缩写如 OS、PD、MM、CR 在肿瘤学中常有多个含义，' +
        '当用户只给出缩写或需要确认缩写所指时使用本工具。',
      parameters: {
        abbr: { type: 'string', required: true, description: '缩写本身，例如 OS、PFS、PD-L1、MM' },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: '可选：只在指定类别内消歧，避免把药物缩写和疾病缩写混在一起。',
        },
        source: {
          type: 'string',
          enum: ['NCIt', '自建库'],
          description: '可选：按术语出处筛查（NCIt 本体 / 人工整理合并进来的自建库）。',
        },
      },
      output: textOutput(),
      execute(args) {
        if (!lex) return `肿瘤学词典不可用${dictNote}，无法查询，请勿据记忆作答。`
        const filter = toolFilter(args)
        const body = renderAbbr(lex.lookupAbbr(args.abbr, 10, filter), args.abbr, dictLabel)
        const scope = describeScope(args)
        return scope ? `${scope}\n\n${body}` : body
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'onco_browse',
      description:
        '按类别浏览本地离线肿瘤学词典中的词条，也可用于确认词典覆盖范围。' +
        '当用户问「词典里有哪些 XX」或需要了解可用术语清单时使用。',
      parameters: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description:
            '类别：disease（疾病）、concept（基础概念）、biomarker（标志物/靶点）、' +
            'drug（药物）、endpoint（临床试验终点）、method（实验方法）、treatment（治疗方式）。' +
            '留空则浏览全部类别。',
        },
        source: {
          type: 'string',
          enum: ['NCIt', '自建库'],
          description: '可选：按术语出处筛查。自建库 = 人工整理、含中文名与 MeSH 编码的概念。',
        },
        ncitType: {
          type: 'string',
          description: '可选：按 NCIt 权威语义类型精确筛查（如 Neoplastic Process、Pharmacologic Substance）。',
        },
        keyword: { type: 'string', description: '可选关键词过滤，例如「肺」' },
        limit: { type: 'number', description: '返回条数上限，默认 30' },
      },
      output: textOutput(),
      execute(args) {
        if (!lex) return `肿瘤学词典不可用${dictNote}，无法查询，请勿据记忆作答。`
        const category = args.category ? CATEGORIES.find((c) => c === args.category) : undefined
        if (args.category && !category) {
          return `未知类别「${args.category}」。可选值：${CATEGORIES.join('、')}。`
        }
        const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 100) : 30
        const entries = lex.browse(category, args.keyword, limit, toolFilter(args))
        const stats = lex.stats()
        const head =
          `当前词典共 ${stats.total} 条词条${dictNote}。${describeScope(args)}\n\n` +
          renderBrowse(entries, category, dictLabel)
        return head
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'onco_translate',
      description:
        '用本地离线词典做「术语级」中英对照：给出术语的中文名与英文标准名，' +
        '或在一段文本里找出所有命中的术语并逐条列出对应名称。' +
        '重要：这不是机器翻译——词典只提供术语级对应，不做语序调整、语法重组与整句润色；' +
        '请勿把对照结果当作译文转述给用户。文本中未被词典收录的部分保持原样、不作翻译。',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: '要对照的术语或文本，中文、英文或混合均可',
        },
        direction: {
          type: 'string',
          enum: ['auto', 'zh2en', 'en2zh'],
          description:
            '对照方向：auto（按中文字符占比自动判定，默认）、zh2en（中→英，给出英文标准名）、' +
            'en2zh（英→中，给出中文名）。',
        },
      },
      output: textOutput(),
      execute(args) {
        if (!lex) return `肿瘤学词典不可用${dictNote}，无法翻译，请勿据记忆作答。`
        const text = String(args.text ?? '')
        if (!text.trim()) return '没有可对照的文本。'
        const r = lex.translate(text, { direction: args.direction })
        const parts = [renderTranslate(r, dictLabel)]
        // 短文本额外给一份逐词对照，保留原文语序，便于核对哪个词换成了什么
        if (text.length <= 400 && r.stats.spans > 0) {
          parts.push(renderTranslateSegments(r, dictLabel))
        }
        return parts.join('\n\n')
      },
    }),
  )

  // ---------- 浏览器面板的数据接口（同源 HTTP）----------
  try {
    const webServer = ctx.webServer
    if (webServer && typeof webServer.register === 'function') {
      const sendJson = (res, obj, status = 200) => {
        const body = JSON.stringify(obj)
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(body)
      }
      const readBody = (req) =>
        new Promise((resolve, reject) => {
          let data = ''
          req.setEncoding('utf8')
          req.on('data', (chunk) => {
            data += chunk
            if (data.length > 1e6) {
              reject(new Error('request body too large'))
              req.destroy()
            }
          })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })

      const serializeEntry = (e) => ({
        id: e.id,
        en: e.en ?? null,
        zh: e.zh ?? null,
        abbr: e.abbr ?? null,
        aliases: e.aliases ?? null,
        def: e.def ?? null,
        category: e.category ?? null,
        codes: e.codes ?? null,
        parents: e.parents ?? null,
        source: e.source ?? null,
        sources: e.sources ?? null,
        types: e.types ?? null,
      })
      const serializeHit = (hit) => ({
        ...serializeEntry(hit.entry),
        score: Math.round(hit.score),
        via: hit.via,
      })

      /** 出处取值：面板与工具共用，避免各处写死字符串 */
      const SOURCES = ['NCIt', '自建库']

      /**
       * 按类别 / 出处 / NCIt 语义类型构造筛查条件。
       *
       * 类别是 7 个粗桶（由语义类型汇总而来），types 才是权威的精确维度——
       * 两者可叠加使用。无有效条件时返回 null，避免给检索平白增加一次判断。
       */
      const makeFilter = (args) => {
        const categories = Array.isArray(args.categories)
          ? args.categories.filter((c) => CATEGORIES.includes(c))
          : CATEGORIES.includes(args.category)
            ? [args.category]
            : []
        const sources = Array.isArray(args.sources)
          ? args.sources.filter((s) => SOURCES.includes(s))
          : SOURCES.includes(args.source)
            ? [args.source]
            : []
        // 类型不校验白名单：取值来自数据本身，未知类型自然匹配不到任何条目
        const types = Array.isArray(args.types)
          ? args.types.filter((t) => typeof t === 'string' && t)
          : typeof args.type === 'string' && args.type
            ? [args.type]
            : []
        if (!categories.length && !sources.length && !types.length) return null
        const catSet = new Set(categories)
        const srcSet = new Set(sources)
        const typeSet = new Set(types)
        return (entry) => {
          if (catSet.size && !catSet.has(entry.category)) return false
          if (srcSet.size) {
            const es = entry.sources && entry.sources.length ? entry.sources : ['NCIt']
            if (!es.some((s) => srcSet.has(s))) return false
          }
          if (typeSet.size) {
            const et = entry.types ?? []
            if (!et.some((t) => typeSet.has(t))) return false
          }
          return true
        }
      }

      const respond = (payload) => {
        if (!lex) return { ok: false, error: `词典不可用：${loadError ?? 'unknown'}` }
        const op = payload && payload.op
        const args = (payload && payload.args) || {}
        const filter = makeFilter(args)
        if (op === 'stats') {
          const s = lex.stats()
          return {
            ok: true,
            dictLabel,
            total: s.total,
            byCategory: s.byCategory,
            bySource: s.bySource,
            byType: s.byType,
          }
        }
        if (op === 'search') {
          const q = String(args.q ?? '').trim()
          if (!q) return { ok: true, dictLabel, hits: [] }
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
          const hits = lex.search(q, limit, filter, { fuzzy: args.fuzzy === true })
          return { ok: true, dictLabel, hits: hits.map(serializeHit), fuzzy: args.fuzzy === true }
        }
        if (op === 'related') {
          const id = String(args.id ?? '').trim()
          if (!id) return { ok: false, error: '缺少 id' }
          const idx = lex.byId.get(normalize(id))
          if (idx === undefined) return { ok: false, error: `未找到词条 ${id}` }
          const entry = lex.docs[idx].entry
          const rel = lex.related(entry, Math.min(Math.max(Number(args.limit) || 10, 1), 30))
          return {
            ok: true,
            dictLabel,
            seed: serializeEntry(entry),
            parents: rel.parents.map(serializeEntry),
            children: rel.children.map(serializeEntry),
            similar: rel.similar.map((s) => ({ ...serializeEntry(s.entry), score: s.score, shared: s.shared })),
          }
        }
        if (op === 'perf') {
          const mem = process.memoryUsage()
          const s = lex ? lex.stats() : { total: 0, byCategory: {}, bySource: {}, byType: {} }
          const ix = lex ? lex.indexStats() : { docs: 0, terms: 0, postings: 0, childKeys: 0, ids: 0 }
          const sorted = [...queryStats.samples].sort((a, b) => a - b)
          const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0)
          return {
            ok: true,
            dictLabel,
            loadError,
            loadMs: Math.round(loadMs ?? 0),
            dictBytes,
            index: { ...ix, typeCount: Object.keys(s.byType).length },
            byCategory: s.byCategory,
            bySource: s.bySource,
            memory: {
              rss: mem.rss,
              heapUsed: mem.heapUsed,
              heapTotal: mem.heapTotal,
              external: mem.external,
              arrayBuffers: mem.arrayBuffers,
            },
            process: { uptimeSec: Math.round(process.uptime()), node: process.version, platform: process.platform },
            queries: {
              count: queryStats.count,
              lastMs: queryStats.lastMs,
              avgMs: queryStats.count ? queryStats.totalMs / queryStats.count : 0,
              maxMs: queryStats.maxMs,
              p50Ms: pct(0.5),
              p95Ms: pct(0.95),
              samples: sorted.length,
            },
          }
        }
        if (op === 'export') {
          const text = String(args.text ?? '')
          if (!text) return { ok: false, error: '没有可导出的内容' }
          // 文件名净化：先去掉路径分隔符与非法字符，再把开头的点串中和掉——
          // 否则 name=".." 会让 path.join(dir, '..') 直接跳到上级目录。
          const safe = String(args.name ?? 'onco-lexicon.txt')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^\.+/, '_')
          const home = os.homedir()
          const downloads = path.join(home, 'Downloads')
          // 导出目录：环境变量优先（便于测试 / 定制），否则 Downloads，再否则主目录。
          // 不接受 RPC 传入目录——那等于把任意路径写权限暴露给浏览器。
          const override = process.env.ONCO_LEXICON_EXPORT_DIR
          const dir = override || (existsSync(downloads) ? downloads : home)
          try {
            if (!existsSync(dir)) return { ok: false, error: `导出目录不存在：${dir}` }
          } catch { /* 忽略 */ }
          const file = path.join(dir, safe)
          // 兜底：确认最终路径确实落在导出目录内，不接受任何形式的越界
          if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
            return { ok: false, error: '导出文件名非法' }
          }
          // 带 UTF-8 BOM：Windows 记事本 / Excel 才不会把中文显示成乱码
          writeFileSync(file, '\uFEFF' + text, 'utf8')
          return { ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8') }
        }
        if (op === 'abbr') {
          const q = String(args.q ?? '').trim()
          if (!q) return { ok: true, dictLabel, hits: [] }
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
          return { ok: true, dictLabel, hits: lex.lookupAbbr(q, limit, filter).map(serializeHit) }
        }
        if (op === 'browse') {
          // 类别浏览：类别可为空（全部）
          const category = args.category ? CATEGORIES.find((c) => c === args.category) : undefined
          if (args.category && !category) return { ok: false, error: `未知类别「${args.category}」` }
          const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
          return {
            ok: true,
            dictLabel,
            entries: lex
              .browse(category, args.keyword, limit, filter)
              .map(serializeEntry),
          }
        }
        if (op === 'translate') {
          const text = String(args.text ?? '')
          if (!text.trim()) return { ok: false, error: '没有可翻译的文本' }
          if (text.length > 20000) {
            return { ok: false, error: `文本过长（${text.length} 字符），请控制在 20000 字符以内` }
          }
          const r = lex.translate(text, { direction: args.direction, limit: args.limit })
          const brief = (t) => ({
            id: t.entry.id,
            en: t.entry.en ?? null,
            zh: t.entry.zh ?? null,
            category: t.entry.category ?? null,
            key: t.key,
            missing: t.missing,
          })
          return {
            ok: true,
            dictLabel,
            direction: r.direction,
            autoDirection: r.autoDirection,
            zhRatio: r.zhRatio,
            truncated: r.truncated,
            notes: r.notes,
            stats: r.stats,
            primary: r.primary ? serializeEntry(r.primary) : null,
            primaryVia: r.primaryVia,
            // 术语表带上完整词条（含编码 / 释义），供面板展示与导出
            terms: r.terms.map((t) => ({
              ...serializeEntry(t.entry),
              key: t.key,
              surface: t.surface,
              length: t.length,
              count: t.count,
              missing: t.missing,
            })),
            // 标注用简版：长文本可能有上千段，完整词条会把 payload 撑大
            segments: r.segments.map((s) => ({
              text: s.text,
              term: s.term ? brief(s.term) : null,
            })),
          }
        }
        return { ok: false, error: `unknown op: ${String(op)}` }
      }

      ctx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: RPC_ROUTE,
            handler: async (req, res) => {
              // 统一过一遍 DSH 的浏览器信任栅栏
              try {
                const connection = ctx.get('connection')
                if (connection !== undefined && typeof connection.requestRejection === 'function') {
                  const code = connection.requestRejection(req)
                  if (code !== undefined && code !== null && code !== false) {
                    res.statusCode = typeof code === 'number' ? code : 403
                    res.end()
                    return
                  }
                }
              } catch {
                /* 栅栏不可用时放行，避免整个面板失效 */
              }
              try {
                if (req.method !== 'POST') {
                  sendJson(res, { ok: false, error: 'POST only' }, 405)
                  return
                }
                const payload = JSON.parse(await readBody(req))
                // 给检索类操作计时（perf/stats 本身很轻，计进去只会污染统计）
                const op = payload && payload.op
                const timing = op !== 'perf' && op !== 'stats'
                const t0 = timing ? performance.now() : 0
                const result = respond(payload)
                if (timing && result && result.ok) recordQuery(performance.now() - t0)
                sendJson(res, result)
              } catch (error) {
                sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
              }
            },
          }),
        'onco-lexicon: panel rpc route',
      )
      logInfo(ctx, `面板数据路由已注册：${RPC_ROUTE}`)

      // 图标路由：客户端在内嵌 data URI 失效时回退到这里
      ctx.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: ICON_ROUTE,
            handler: async (req, res) => {
              try {
                const png = readFileSync(ICON_FILE)
                res.statusCode = 200
                res.setHeader('content-type', 'image/png')
                res.setHeader('cache-control', 'public, max-age=86400')
                res.end(png)
              } catch (error) {
                logInfo(ctx, `图标读取失败：${error instanceof Error ? error.message : String(error)}`)
                res.statusCode = 404
                res.end()
              }
            },
          }),
        'onco-lexicon: icon route',
      )
      logInfo(ctx, `图标路由已注册：${ICON_ROUTE}`)
    } else {
      logInfo(ctx, '未拿到 webServer，面板数据路由未注册（工具仍可用）')
    }
  } catch (error) {
    logInfo(ctx, `面板路由注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
