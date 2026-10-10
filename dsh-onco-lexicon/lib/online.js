/**
 * dsh-onco-lexicon —— 联网兜底层（本地优先）
 *
 * 本模块**只在本词典检索不到时**被调用：本地命中时一个网络请求都不发，
 * 因此离线可用性与查询延迟都不受影响。
 *
 * 四条设计约束（都是为了不违背词典「未收录时如实说明、不许编造」的立场）：
 *
 *   1. 有界延迟：整次兜底共用一个 AbortController 与一份总预算，最坏情况也只是
 *      等到预算耗尽，不会把工具调用无限期挂住。
 *   2. 失败即如实说明：超时 / 断网 / HTTP 错误 / 非 JSON 响应 / 运行时无 fetch，
 *      全部转成一句可读的说明，**绝不退化成「猜一个答案」**。
 *   3. 来源可追溯：输出里写明查的是哪个 API、NCIt 的版本号，以及「未经本地人工整理」。
 *   4. 中英边界说清楚：NCIt 与 MeSH 都是英文词表，纯中文查询拿不到任何东西
 *      （实测 `term=肺癌` 在 NCIt 返回 total=0），此时不硬查，直接说明原因。
 *
 * 两个上游（均实测可用；基线为 NCIt 26.09d）：
 *
 *   - NCI EVS REST：https://api-evsrest.nci.nih.gov/api/v1
 *     **老域名 evsrestapi.nci.nih.gov 已退役**——它对任意路径都返回一张 HTML 门户页
 *     （HTTP 200 + text/html）。只按状态码判断就会把这张网页当成成功响应，
 *     再去 JSON.parse 一个 `<html>`。本模块因此对 content-type 与 parse 都做显式校验。
 *     另：`/concept/ncit/search` 的 `include=summary` 一次就带回 synonyms + definitions，
 *     比「先 search 再逐个取 concept」少 N 次往返，是这里刻意选用的取数口径。
 *
 *   - NLM MeSH Lookup：https://id.nlm.nih.gov/mesh
 *     `/lookup/descriptor` 按标签查主题词，`/lookup/details` 按 D 编码取主题词及其入口词。
 *
 * 关于缩写：NCIt 的 search 是按字符串排序的（`term=MM` 的前 10 条里没有 Multiple Myeloma，
 * 放宽到 pageSize=50 也没有）。所以缩写兜底只认「该缩写确实出现在候选条目的同义词里」，
 * 并在输出里明确写出**召回不保证完整**——不把一个残缺列表包装成「全部义项」。
 */

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------

/** 汉字的码点范围（与 lib/index.js 保持同一套判定） */
const CJK_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const CJK_TEST = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** NCIt C-code 与 MeSH D-code 的形态。命中时走精确的按码取数，不走检索。 */
export const NCIT_CODE_RE = /^[Cc]\d{2,7}$/
export const MESH_CODE_RE = /^[Dd]\d{6}$/

export const ONLINE_DEFAULTS = {
  enabled: true,
  /** 整次兜底的总预算（含所有上游），毫秒 */
  timeoutMs: 6000,
  /** 成功结果的缓存时长：术语表更新很慢，6 小时足够 */
  cacheTtlMs: 6 * 60 * 60 * 1000,
  /** 失败结果的缓存时长：短一点，避免网络恢复后还在吃旧结论，又不会每次查询都重打 */
  errorTtlMs: 60 * 1000,
  cacheMax: 200,
  ncitBase: 'https://api-evsrest.nci.nih.gov/api/v1',
  meshBase: 'https://id.nlm.nih.gov/mesh',
  /** 释义截断长度，与本地词条的 400 字符口径一致 */
  defMax: 400,
  /** 同义词最多展示几个 */
  synMax: 12,
  userAgent: 'dsh-onco-lexicon/0.7.0 (local-first terminology fallback)',
}

/**
 * 归一化配置。同时接受三种写法，便于 cordis.patch.yml 里怎么填都行：
 *
 *   online: true | false          只开关
 *   online: { timeoutMs: 8000 }   对象
 *   onlineEnabled / onlineTimeoutMs  扁平字段（覆盖上面的同名项）
 */
export function resolveOnlineConfig(config = {}) {
  const raw = config.online
  let src = {}
  if (raw && typeof raw === 'object') src = { ...raw }
  else if (typeof raw === 'boolean') src = { enabled: raw }
  if (config.onlineEnabled !== undefined) src.enabled = config.onlineEnabled
  if (config.onlineTimeoutMs !== undefined) src.timeoutMs = config.onlineTimeoutMs

  const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return {
    enabled: src.enabled === undefined ? ONLINE_DEFAULTS.enabled : src.enabled !== false,
    timeoutMs: pos(src.timeoutMs, ONLINE_DEFAULTS.timeoutMs),
    cacheTtlMs: pos(src.cacheTtlMs, ONLINE_DEFAULTS.cacheTtlMs),
    errorTtlMs: pos(src.errorTtlMs, ONLINE_DEFAULTS.errorTtlMs),
    cacheMax: pos(src.cacheMax, ONLINE_DEFAULTS.cacheMax),
    ncitBase: String(src.ncitBase || ONLINE_DEFAULTS.ncitBase).replace(/\/+$/, ''),
    meshBase: String(src.meshBase || ONLINE_DEFAULTS.meshBase).replace(/\/+$/, ''),
    defMax: pos(src.defMax, ONLINE_DEFAULTS.defMax),
    synMax: pos(src.synMax, ONLINE_DEFAULTS.synMax),
    userAgent: String(src.userAgent || ONLINE_DEFAULTS.userAgent),
  }
}

export function hasCJK(text) {
  return CJK_TEST.test(String(text ?? ''))
}

/** 取一段文本里的拉丁部分：中文查询里常夹着英文缩写（「PD-L1 表达」→「PD-L1」） */
function stripCJK(text) {
  return String(text ?? '').replace(CJK_G, ' ').replace(/\s+/g, ' ').trim()
}

/** 比较用的归一化键：小写、非字母数字转空格。空格两侧对齐用，与检索无关。 */
export function normKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * 缓存键：用**实际发起查询的那串文本**，只做 NFKC / 大小写 / 空白归一。
 *
 * 这里**不能**用 normKey()。它把非 `[a-z0-9]` 一律抹成空格，于是
 *   - 所有纯中文查询都塌成同一个空键：「高血压」与「糖尿病」共用 `term||5`，
 *     第二次查询会拿到第一次的结果，输出里还回显着上一个词（缓存命中了别人的答案，
 *     比不缓存危险得多）；
 *   - `ER+` 与 `ER` 撞键：雌激素受体与 ER 阳性是两个不同检索口径。
 * normKey 仍然用于「查询词 vs 概念名」的语义比较，只是不该拿来当缓存键。
 */
export function cacheKeyOf(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// 带 TTL 的小缓存
// ---------------------------------------------------------------------------
/**
 * 缓存整个兜底结果（而不是缓存单个 HTTP 响应），因为一次兜底要打两个上游，
 * 缓存原子结果才能既省 NCIt 的往返又省 MeSH 的往返。
 *
 * 顺带做了 LRU：超出容量时淘汰最久未使用的键。失败结果用更短的 TTL 单独记，
 * 免得一次超时把「查不到」钉死 6 小时。
 */
export class OnlineCache {
  constructor({ ttlMs, errorTtlMs, max }) {
    this.ttlMs = ttlMs
    this.errorTtlMs = errorTtlMs
    this.max = max
    this.map = new Map()
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() >= hit.expireAt) {
      this.map.delete(key)
      return undefined
    }
    // 命中即刷新次序，让 Map 的插入顺序充当 LRU 序
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value, { failed = false } = {}) {
    this.map.delete(key)
    this.map.set(key, { value, expireAt: Date.now() + (failed ? this.errorTtlMs : this.ttlMs) })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  get size() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }
}

// ---------------------------------------------------------------------------
// HTTP 取数
// ---------------------------------------------------------------------------
/**
 * 取一份 JSON，并且**只**在确认是 JSON 时才当成成功。
 *
 * 这里刻意不写 `if (!res.ok) throw`：真正的失败形态比状态码多——
 * 退役域名会给 200 + HTML，网关会给 200 + 空体，代理会给 200 + 一张登录页。
 * 三种都必须落到「失败并且说明原因」，而不是让后续代码读到 undefined。
 *
 * @returns {Promise<{ok:boolean, data?:any, status?:number, bytes?:number,
 *                    errorKind?:string, error?:string, ms:number}>}
 */
async function fetchJson(url, { signal, userAgent, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
  const started = Date.now()
  const done = (extra) => ({ ms: Date.now() - started, ...extra })
  if (!doFetch) {
    return done({ ok: false, errorKind: 'unavailable', error: '当前运行时没有可用的 fetch' })
  }
  try {
    const res = await doFetch(url, {
      method: 'GET',
      signal,
      headers: { accept: 'application/json', 'user-agent': userAgent },
    })
    const text = await res.text()
    if (!res.ok) {
      return done({
        ok: false,
        status: res.status,
        bytes: text.length,
        errorKind: 'http',
        error: `HTTP ${res.status}`,
      })
    }
    const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '')
    if (ctype && !/json/i.test(ctype)) {
      return done({
        ok: false,
        status: res.status,
        bytes: text.length,
        errorKind: 'non-json',
        error: `响应不是 JSON（content-type: ${ctype.slice(0, 60)}）`,
      })
    }
    try {
      return done({ ok: true, status: res.status, bytes: text.length, data: JSON.parse(text) })
    } catch {
      return done({
        ok: false,
        status: res.status,
        bytes: text.length,
        errorKind: 'non-json',
        error: '响应无法解析为 JSON',
      })
    }
  } catch (error) {
    // 超时与「被调用方取消」都会表现为 AbortError，靠 abortInfo 区分：
    // 前者是我们自己的预算耗尽，后者是上层（工具调用超时策略 / 用户中断）撤回了调用。
    const aborted = (error && error.name === 'AbortError') || (signal && signal.aborted)
    const kind = aborted ? abortReasonOf(signal) || 'timeout' : 'network'
    return done({
      ok: false,
      errorKind: kind,
      error: aborted ? '请求超时或已被取消' : String((error && error.message) || error),
    })
  }
}

/**
 * 取信号的取消原因。
 *
 * AbortSignal 本身不告诉我们「为什么被取消」，所以 onlineLookup 在 abort 前把原因
 * 挂在 signal 上。拿不到时按超时处理——那是我们自己会主动触发的唯一路径。
 */
function abortReasonOf(signal) {
  return signal && signal.__oncoAbortReason ? signal.__oncoAbortReason : null
}

/** 把 errorKind 翻成给读者看的话 */
function explainErrorKind(kind) {
  switch (kind) {
    case 'timeout':
      return '请求超时'
    case 'network':
      return '网络不可达'
    case 'http':
      return '上游返回了错误状态码'
    case 'non-json':
      return '上游返回的不是 JSON（域名可能已迁移或退役）'
    case 'unavailable':
      return '运行时没有 fetch'
    case 'empty':
      return '上游没有返回条目'
    case 'cancelled':
      return '调用已被取消'
    default:
      return '未知错误'
  }
}

/**
 * 多口径检索（先 exact 后 contains 之类）全失败时，该报哪一个错。
 *
 * 一开始这里直接报 'empty'（「没有匹配条目」），于是超时和断网都被渲染成
 * 「上游没有返回条目」——把一次没查成说成了「不存在」，正是本模块最不该犯的错。
 * 所以按「信息量」排序，取最能说明问题的那一个：连不上 > 超时 > 网络错 > 非 JSON > HTTP 错 > 空结果。
 */
const ERROR_SEVERITY = { unavailable: 6, cancelled: 5, timeout: 5, network: 4, 'non-json': 3, http: 2, empty: 0 }
function worstErrorKind(attempts, fallback = 'empty') {
  let best = fallback
  let bestRank = -1
  for (const a of attempts || []) {
    if (!a || a.ok) continue
    const kind = a.errorKind || fallback
    const rank = ERROR_SEVERITY[kind] ?? 1
    if (rank > bestRank) {
      bestRank = rank
      best = kind
    }
  }
  return best
}

/** 全失败时，把最有信息量那条 attempt 的原文错误也带出来 */
function worstError(attempts) {
  for (const a of attempts || []) {
    if (a && !a.ok && a.error) return a.error
  }
  return ''
}

// ---------------------------------------------------------------------------
// NCIt（NCI EVS REST）
// ---------------------------------------------------------------------------
function uniqStrings(list) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const v = String(raw ?? '').trim()
    if (!v) continue
    const k = v.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

/** 把 EVS 的 concept 对象压成我们展示用的形状 */
function shapeNcitConcept(c, cfg) {
  if (!c || typeof c !== 'object') return null
  const synonyms = Array.isArray(c.synonyms) ? c.synonyms : []
  const definitions = Array.isArray(c.definitions) ? c.definitions : []
  const def = definitions.map((d) => (d && d.definition) || '').find(Boolean) || ''
  return {
    code: c.code ? String(c.code) : '',
    name: c.name ? String(c.name) : '',
    version: c.version ? String(c.version) : '',
    active: c.active !== false,
    leaf: c.leaf === true,
    conceptStatus: c.conceptStatus ? String(c.conceptStatus) : '',
    /** 全部同义词名（去重），缩写形态混在其中 */
    synonyms: uniqStrings(synonyms.map((s) => s && s.name)),
    /** 只取 NCIt 标注为缩写（termType=AB）的那些，用于说明「这确实是官方缩写」 */
    abbrTerms: uniqStrings(synonyms.filter((s) => /^AB$/i.test(String((s && s.termType) || ''))).map((s) => s.name)),
    /** termType → 来源，形如 "AB/NCI"、"SY/CDISC-GLOSS"；供缩写消歧显示依据 */
    synonymTags: synonyms
      .map((s) => `${String((s && s.termType) || '?')}/${String((s && s.source) || '?')}`)
      .filter(Boolean),
    def: def.length > cfg.defMax ? `${def.slice(0, cfg.defMax)}…` : def,
    defTruncated: def.length > cfg.defMax,
  }
}

/** 按 C-code 直取（最精确的一条路径） */
async function ncitByCode(code, cfg, ctx) {
  const url = `${cfg.ncitBase}/concept/ncit/${encodeURIComponent(code.toUpperCase())}`
  const r = await fetchJson(url, { ...ctx, userAgent: cfg.userAgent })
  if (!r.ok) return { ...r, url }
  const concept = shapeNcitConcept(r.data, cfg)
  if (!concept || !concept.code) return { ...r, ok: false, errorKind: 'empty', error: '未返回条目', url }
  return { ...r, concepts: [concept], total: 1, url, mode: 'code' }
}

/**
 * 按术语检索。
 *
 * 先用 `type=match`（NCIt 自身的匹配算法，返回集小、精度高），结果为空时再退回
 * `type=contains`（召回更宽）。只有真的空手而归时才付第二次往返。
 * 两个口径都带 `include=summary`，一次把 synonyms + definitions 全拿回来。
 */
async function ncitSearch(term, cfg, ctx, { pageSize = 3 } = {}) {
  const attempts = []
  for (const type of ['match', 'contains']) {
    const url =
      `${cfg.ncitBase}/concept/ncit/search?term=${encodeURIComponent(term)}` +
      `&type=${type}&pageSize=${pageSize}&include=summary`
    const r = await fetchJson(url, { ...ctx, userAgent: cfg.userAgent })
    attempts.push({ type, url, ok: r.ok, errorKind: r.errorKind, error: r.error, status: r.status, ms: r.ms })
    if (!r.ok) {
      // 预算耗尽就没必要再试下一个口径了
      if (ctx.signal && ctx.signal.aborted) break
      continue
    }
    const concepts = Array.isArray(r.data && r.data.concepts) ? r.data.concepts : []
    if (concepts.length) {
      return {
        ok: true,
        url,
        mode: type,
        total: Number(r.data.total) || concepts.length,
        version: concepts[0] && concepts[0].version ? String(concepts[0].version) : '',
        concepts: concepts.map((c) => shapeNcitConcept(c, cfg)).filter(Boolean),
        ms: r.ms,
        attempts,
      }
    }
    // 有响应但零结果：换 contains 再试一次，除非已经就是 contains
    if (ctx.signal && ctx.signal.aborted) break
  }
  return {
    ok: false,
    mode: null,
    concepts: [],
    total: 0,
    attempts,
    errorKind: worstErrorKind(attempts),
    error: worstError(attempts) || 'NCIt 中没有匹配条目',
  }
}

// ---------------------------------------------------------------------------
// MeSH（NLM Lookup）
// ---------------------------------------------------------------------------
/**
 * contains 匹配下的相关性闸门。
 *
 * MeSH 的 contains 是子串匹配，对缩写极不友好：查 HER2 会返回
 * `(111)In-Benzyl-DTPA-Z(HER2:342)`、`(99m)Tc-Z(HER2:2395)-Cys` 这类化学名。
 * 闸门要求「查询的每个词都出现在标签里」且「标签词数不超过查询词数 + 3」——
 * 前者滤掉无关词，后者滤掉那些把缩写埋在一长串修饰里的条目。
 * 「non-small cell lung」→「Carcinoma, Non-Small-Cell Lung」(5 词 vs 4 词) 仍能通过。
 */
function meshRelevant(query, label, match) {
  if (match === 'exact') return true
  const q = normKey(query)
  const l = normKey(label)
  if (!q || !l) return false
  if (l === q) return true
  const qt = q.split(' ').filter(Boolean)
  const lt = l.split(' ').filter(Boolean)
  if (!qt.length || !lt.length) return false
  if (!qt.every((t) => lt.includes(t))) return false
  return lt.length <= qt.length + 3
}

/** 按标签查 MeSH 主题词：先 exact，无果再 contains（过相关性闸门） */
async function meshByLabel(term, cfg, ctx, { limit = 3 } = {}) {
  const attempts = []
  for (const match of ['exact', 'contains']) {
    const url = `${cfg.meshBase}/lookup/descriptor?label=${encodeURIComponent(term)}&match=${match}&limit=${limit}`
    const r = await fetchJson(url, { ...ctx, userAgent: cfg.userAgent })
    attempts.push({ match, url, ok: r.ok, errorKind: r.errorKind, error: r.error, status: r.status, ms: r.ms })
    if (!r.ok) {
      if (ctx.signal && ctx.signal.aborted) break
      continue
    }
    const list = Array.isArray(r.data) ? r.data : []
    const descriptors = list
      .map((d) => {
        const label = d && d.label ? String(d.label) : ''
        const resource = d && d.resource ? String(d.resource) : ''
        const code = (resource.match(/\/([DT]\d+)$/) || [])[1] || ''
        return { code, label, resource }
      })
      .filter((d) => d.label && meshRelevant(term, d.label, match))
    if (descriptors.length) {
      return { ok: true, url, mode: match, descriptors, attempts, ms: r.ms }
    }
    if (ctx.signal && ctx.signal.aborted) break
  }
  return {
    ok: false,
    descriptors: [],
    attempts,
    errorKind: worstErrorKind(attempts),
    error: worstError(attempts) || 'MeSH 中没有匹配主题词',
  }
}

/** 按 D-code 取主题词及其入口词 */
async function meshByCode(code, cfg, ctx) {
  const url = `${cfg.meshBase}/lookup/details?descriptor=${encodeURIComponent(code.toUpperCase())}`
  const r = await fetchJson(url, { ...ctx, userAgent: cfg.userAgent })
  if (!r.ok) return { ...r, url }
  const terms = Array.isArray(r.data && r.data.terms) ? r.data.terms : []
  const preferred = terms.find((t) => t && t.preferred) || terms[0]
  if (!preferred || !preferred.label) {
    return { ...r, ok: false, errorKind: 'empty', error: '未返回主题词', url }
  }
  return {
    ...r,
    ok: true,
    url,
    mode: 'code',
    descriptors: [
      {
        code: code.toUpperCase(),
        label: String(preferred.label),
        resource: `http://id.nlm.nih.gov/mesh/${code.toUpperCase()}`,
        entryTerms: uniqStrings(terms.filter((t) => t && t.preferred !== true).map((t) => t.label)),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 兜底主流程
// ---------------------------------------------------------------------------
/**
 * 本地未命中后调用的唯一入口。
 *
 * @param {string} query  原始查询词
 * @param {object} options
 *   - kind: 'term' | 'abbr'   查询意图，决定 NCIt 侧的候选筛选方式
 *   - topK: 最多展示几条
 *   - config: resolveOnlineConfig() 的结果
 *   - cache:  OnlineCache 实例（可选）
 *   - fetchImpl / now: 测试注入点
 * @returns {Promise<object>} 可直接 JSON 序列化的结果对象（面板与工具共用）
 */
export async function onlineLookup(query, options = {}) {
  const cfg = options.config || resolveOnlineConfig({})
  const kind = options.kind === 'abbr' ? 'abbr' : 'term'
  const topK = Math.min(Math.max(Number(options.topK) || 3, 1), 10)
  const cache = options.cache || null
  const started = Date.now()

  const result = {
    query: String(query ?? '').trim(),
    kind,
    ok: false,
    mode: null,
    skipped: null,
    ncit: null,
    mesh: null,
    errors: [],
    notes: [],
    ms: 0,
    cached: false,
  }

  if (!cfg.enabled) {
    result.skipped = { reason: 'disabled', message: '联网兜底已在配置里关闭。' }
    result.ms = Date.now() - started
    return result
  }

  const q = result.query
  if (!q) {
    result.skipped = { reason: 'empty', message: '查询词为空。' }
    result.ms = Date.now() - started
    return result
  }

  const cacheKey = `${kind}|${cacheKeyOf(q)}|${topK}`
  if (cache) {
    const hit = cache.get(cacheKey)
    if (hit) return { ...hit, cached: true, ms: Date.now() - started }
  }

  // ---- 中文边界：两个上游都是英文词表，纯中文不做无谓往返 ----
  const latin = stripCJK(q)
  const isCJKOnly = hasCJK(q) && !latin
  if (isCJKOnly) {
    result.skipped = {
      reason: 'cjk-only',
      message:
        '联网兜底只用 NCIt 与 MeSH 两个英文词表，无法用纯中文检索（实测 NCIt 对中文查询返回 0 条）。',
    }
    result.ms = Date.now() - started
    if (cache) cache.set(cacheKey, result, { failed: true })
    return result
  }
  const ncitTerm = isCJKOnly ? q : latin || q
  if (ncitTerm !== q) {
    result.notes.push(`查询词含中文，联网部分只用其中的英文片段「${ncitTerm}」检索。`)
  }

  // ---- 一份总预算，两个上游并行 ----
  const timeoutMs = cfg.timeoutMs
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  let detachExternal = null
  if (controller) {
    // 这里**不能** unref()：这个定时器正是「有界延迟」的实现手段，
    // unref 之后事件循环可能在它触发前就空了，于是整个兜底既不会超时也不会返回。
    // 生命周期由下面的 finally 里 clearTimeout 负责。
    controller.signal.__oncoAbortReason = 'timeout'
    timer = setTimeout(() => controller.abort(), timeoutMs)

    // 上层信号（工具调用的 exec.signal：超时策略的截止时间、或用户中断）一并接入，
    // 这样取消能立刻传导到正在飞的 fetch，而不是等我们自己的预算耗尽。
    const external = options.signal
    if (external && typeof external.addEventListener === 'function') {
      if (external.aborted) {
        controller.signal.__oncoAbortReason = 'cancelled'
        controller.abort()
      } else {
        const onAbort = () => {
          controller.signal.__oncoAbortReason = 'cancelled'
          controller.abort()
        }
        external.addEventListener('abort', onAbort, { once: true })
        detachExternal = () => external.removeEventListener('abort', onAbort)
      }
    }
  }
  const ctx = { signal: controller ? controller.signal : undefined, fetchImpl: options.fetchImpl }

  const byCode = NCIT_CODE_RE.test(q.trim())
  const meshCode = MESH_CODE_RE.test(q.trim())

  try {
    const jobs = []

    if (byCode) {
      result.mode = 'ncit-code'
      jobs.push(
        ncitByCode(q.trim(), cfg, ctx).then((r) => {
          if (r.ok) result.ncit = { version: r.concepts[0].version, mode: 'code', url: r.url, total: 1, concepts: r.concepts }
          else result.errors.push({ source: 'NCIt', kind: r.errorKind, message: r.error, status: r.status })
        }),
      )
    } else if (meshCode) {
      result.mode = 'mesh-code'
      jobs.push(
        meshByCode(q.trim(), cfg, ctx).then((r) => {
          if (r.ok) result.mesh = { mode: 'code', url: r.url, descriptors: r.descriptors }
          else result.errors.push({ source: 'MeSH', kind: r.errorKind, message: r.error, status: r.status })
        }),
      )
    } else {
      result.mode = kind
      // NCIt：pageSize 略大于 topK，留出被缩写筛选掉的空间
      const ncitPage = kind === 'abbr' ? Math.min(topK * 4 + 8, 40) : topK
      jobs.push(
        ncitSearch(ncitTerm, cfg, ctx, { pageSize: ncitPage }).then((r) => {
          if (!r.ok) {
            result.errors.push({ source: 'NCIt', kind: r.errorKind, message: r.error, attempts: r.attempts })
            return
          }
          let concepts = r.concepts
          if (kind === 'abbr') {
            const want = normKey(q)
            concepts = concepts.filter(
              (c) => normKey(c.name) === want || c.synonyms.some((s) => normKey(s) === want),
            )
            // 命中缩写的那些，把匹配依据留在条目上，供输出显示
            for (const c of concepts) {
              c.matchedAs = normKey(c.name) === want ? '规范名即为该缩写' : '该缩写是其同义词'
            }
          }
          result.ncit = {
            version: r.version,
            mode: r.mode,
            url: r.url,
            total: r.total,
            concepts: concepts.slice(0, topK),
            filteredFrom: kind === 'abbr' ? r.concepts.length : undefined,
          }
        }),
      )
      // MeSH：只在术语模式下查标签；缩写模式下 MeSH 的标签检索基本只会返回化学名噪声
      if (kind === 'term') {
        jobs.push(
          meshByLabel(ncitTerm, cfg, ctx, { limit: topK }).then(async (r) => {
            if (!r.ok) {
              result.errors.push({ source: 'MeSH', kind: r.errorKind, message: r.error, attempts: r.attempts })
              return
            }
            const descriptors = r.descriptors.slice(0, topK)
            // 只给第一条补入口词：多一次往返，但只在预算内且并行，收益（同义词）划算
            if (descriptors[0] && descriptors[0].code) {
              const detail = await meshByCode(descriptors[0].code, cfg, ctx)
              if (detail.ok && detail.descriptors[0]) descriptors[0] = detail.descriptors[0]
            }
            result.mesh = { mode: r.mode, url: r.url, descriptors }
          }),
        )
      }
    }

    await Promise.all(jobs)
  } finally {
    if (timer) clearTimeout(timer)
    if (detachExternal) detachExternal()
  }

  const ncitCount = result.ncit ? result.ncit.concepts.length : 0
  const meshCount = result.mesh ? result.mesh.descriptors.length : 0
  result.ok = ncitCount > 0 || meshCount > 0

  // ---- 面向读者的说明 ----
  if (result.skipped && result.skipped.reason === 'cjk-only') {
    result.notes.push(result.skipped.message)
  }
  if (!result.ok && result.errors.length) {
    const uniq = [...new Set(result.errors.map((e) => `${e.source}：${explainErrorKind(e.kind)}`))]
    result.notes.push(`联网查询未拿到结果（${uniq.join('；')}）。这不代表该术语不存在，只说明这次没查成。`)
  }
  if (!result.ok && !result.errors.length && !result.skipped) {
    result.notes.push('联网查询没有返回任何条目。')
  }
  if (ncitCount && result.ncit.mode === 'contains') {
    result.notes.push('NCIt 侧用的是 contains（子串）检索，命中范围偏宽，请按规范名核对后再引用。')
  }
  if (kind === 'abbr') {
    result.notes.push(
      'NCIt 的检索按字符串排序，前若干条候选中命中该缩写并不等于「该缩写的全部义项」——' +
        '例如 MM 在 NCIt 前 50 条候选里都检索不到 Multiple Myeloma。此列表仅供补充线索。',
    )
  }
  result.notes.push(
    '联网结果都是英文词表内容，不提供中文名；本词典的中文名仅 106 条人工整理词条，不得据此推造中文译名。',
  )

  result.ms = Date.now() - started
  if (cache) cache.set(cacheKey, result, { failed: !result.ok && !result.skipped })
  return result
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 把兜底结果渲染成工具文本输出。
 *
 * 措辞上的两条底线：
 *   - 明确区分「本地词典」与「联网实时查询」，不让模型把联网内容当成词典词条引用；
 *   - 失败时说明「没查成」，而不是「不存在」——后者是我们无法从一次超时得出的结论。
 */
export function renderOnline(result, options = {}) {
  const src = options.ncitHost || 'api-evsrest.nci.nih.gov'
  const meshHost = options.meshHost || 'id.nlm.nih.gov'
  const head = '【联网兜底】'

  if (result.skipped && !result.ok) {
    return [
      `${head}本地词典未收录「${result.query}」，且本次没有进行联网查询。`,
      '',
      `原因：${result.skipped.message}`,
      '',
      '请改为提供该术语的英文名或缩写后再查；不要据中文名推测英文名，也不要编造释义、别名或编码。',
    ].join('\n')
  }

  const lines = []
  const status = result.ok ? '已查到内容' : '没有查到内容'
  lines.push(
    `${head}本地词典未收录「${result.query}」，已向线上权威词表查询（${status}），` +
      `耗时 ${result.ms} ms${result.cached ? '（缓存命中）' : ''}。`,
  )
  lines.push('以下内容来自联网实时查询，未经本地人工整理，与本地词典词条分开看待，不要当成本词典的词条引用。')

  if (result.ncit && result.ncit.concepts.length) {
    lines.push('')
    lines.push(`◇ NCIt（${src}${result.ncit.version ? `，版本 ${result.ncit.version}` : ''}，检索口径 ${result.ncit.mode}）`)
    result.ncit.concepts.forEach((c, i) => {
      const flag = c.active === false ? '  [已停用]' : ''
      lines.push(`${i + 1}. ${c.code}  ${c.name}${flag}`)
      if (c.matchedAs) lines.push(`   为何算作该缩写：${c.matchedAs}`)
      if (c.abbrTerms.length) lines.push(`   NCIt 标注的缩写：${c.abbrTerms.join('、')}`)
      if (c.synonyms.length) {
        const shown = c.synonyms.slice(0, 12)
        const more = c.synonyms.length > shown.length ? ` …（共 ${c.synonyms.length} 个）` : ''
        lines.push(`   同义词：${shown.join('；')}${more}`)
      }
      if (c.def) lines.push(`   释义：${clip(c.def, 400)}${c.defTruncated ? '（已截断）' : ''}`)
    })
  }

  if (result.mesh && result.mesh.descriptors.length) {
    lines.push('')
    lines.push(`◇ MeSH 主题词（${meshHost}）`)
    result.mesh.descriptors.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.code || '（无编码）'}  ${d.label}`)
      if (d.entryTerms && d.entryTerms.length) {
        lines.push(`   入口词：${clip(d.entryTerms.join('；'), 300)}`)
      }
    })
  }

  if (!result.ok) {
    lines.push('')
    lines.push('▸ NCIt：无结果' + (result.ncit ? '（0 条）' : ''))
    lines.push('▸ MeSH：无结果' + (result.mesh ? '（0 条）' : ''))
  }

  lines.push('')
  lines.push('【说明】')
  for (const n of result.notes) lines.push(`- ${n}`)
  if (result.errors.length) {
    for (const e of result.errors) {
      lines.push(`- ${e.source} 请求异常：${explainErrorKind(e.kind)}${e.message ? `（${clip(e.message, 120)}）` : ''}`)
    }
  }
  lines.push('- 本词典未收录该术语，以上联网内容也不构成完整释义；引用编码时请以 NCIt / MeSH 官方最新版本核对。')
  if (options.privacy !== false) {
    lines.push('- 本次查询词已发送至上述 NCI / NLM 公共服务，查询本身不经过本词典作者的任何服务器。')
  }
  return lines.join('\n')
}

/** 面板用的一句话摘要 */
export function summarizeOnline(result) {
  if (result.skipped && !result.ok) {
    return { ok: false, skipped: result.skipped.reason, text: result.skipped.message, ms: result.ms }
  }
  const bits = []
  if (result.ncit && result.ncit.concepts.length) {
    bits.push(`NCIt ${result.ncit.concepts.length} 条${result.ncit.version ? `（v${result.ncit.version}）` : ''}`)
  }
  if (result.mesh && result.mesh.descriptors.length) bits.push(`MeSH ${result.mesh.descriptors.length} 条`)
  if (!bits.length && result.errors.length) {
    bits.push(...[...new Set(result.errors.map((e) => `${e.source} ${explainErrorKind(e.kind)}`))])
  }
  return {
    ok: result.ok,
    skipped: null,
    text: bits.join(' · ') || '无结果',
    ms: result.ms,
    cached: result.cached,
  }
}
