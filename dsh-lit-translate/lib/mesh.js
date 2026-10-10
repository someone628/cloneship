/**
 * dsh-lit-translate —— MeSH 2026 离线术语层（host 半）
 *
 * 这一层解决的是**术语口径**，不是翻译：MeSH（Medical Subject Headings）只有英文，
 * 没有中文名。它能在翻译里起作用的地方是——
 *   1. 把原文里五花八门的写法收敛到 MeSH 规范词（`progression-free survival`
 *      → `Progression-Free Survival`），同一篇文献里前后译法更容易一致；
 *   2. 用 ScopeNote 给同形词消歧（`discharge`、`PD` 这类词靠定义才能定夺）；
 *   3. 给出 MeSH 编号与树号，便于核对与回查（如 `mesh:D000077982`）。
 *
 * 因此本模块产出的是一段**给模型的术语约束**，绝不产出中文译名——
 * MeSH 里没有中文，任何「MeSH 官方中文名」都是编的。
 *
 * 数据来源：NLM 公开的 MeSH 2026 XML（desc2026 / supp2026 / 限定词），
 * 由工作区的 mesh_build.py 解析成 data/mesh_index.bin。索引格式：
 *   - 头 68 字节 <8s15I>：magic "MESHIDX1" + 15 个 uint32
 *   - 之后依次是：术语字节块 / 术语偏移表 / 引用偏移表 / 引用数组 /
 *     记录偏移表 / 记录块 / meta JSON
 *   - 记录块每行 6 个字段用 \x1f 分隔：id|name|def|cat|tree|map
 * 读取时整文件一次读进 Buffer，术语二分查找直接在 Buffer 上比字节，
 * 不预先构造 84 万个 JS 字符串（那会是几百 MB 常驻内存）。
 *
 * normalizeText 必须与 mesh_build.py 的 normalize() 完全一致，否则查不到；
 * 两边一致性由 test-mesh.mjs 用 Python 产出的 mesh_fixtures.json 逐条校验。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 随包分发的索引；可用配置 meshDataDir 覆盖 */
export const DEFAULT_MESH_FILE = path.join(HERE, '..', 'data', 'mesh_index.bin')
export const MAGIC = 'MESHIDX1'
export const HEADER_BYTES = 68
const FIELD_SEP = '\x1f'

/** 单字泛化词表：这些词在 MeSH 里确实能命中，但对统一术语口径没有帮助，
 *  只会挤占提示词预算、把真正的专业术语挤掉。多词短语不受此表限制。 */
export const STOPWORDS = new Set(
  [
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
    'onto', 'to', 'with', 'within', 'without', 'via', 'per', 'than', 'then', 'that', 'this', 'these', 'those',
    'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done', 'have', 'has',
    'had', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would', 'not', 'no', 'nor', 'all',
    'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'also', 'both', 'very',
    'we', 'our', 'us', 'they', 'their', 'them', 'he', 'she', 'his', 'her', 'you', 'your', 'i', 'who', 'whom',
    'which', 'when', 'where', 'while', 'how', 'why', 'there', 'here', 'about', 'above', 'after', 'again',
    'against', 'before', 'below', 'between', 'during', 'over', 'under', 'up', 'down', 'out', 'off', 'further',
    'however', 'therefore', 'thus', 'hence', 'moreover', 'meanwhile', 'et', 'al', 'eg', 'ie', 'vs', 'versus',
    // 高频通用医学词：单用它们做约束几乎不增加信息
    'patient', 'patients', 'human', 'humans', 'people', 'person', 'male', 'males', 'female', 'females',
    'adult', 'adults', 'child', 'children', 'infant', 'infants', 'animal', 'animals', 'mice', 'rats',
    'study', 'studies', 'trial', 'trials', 'group', 'groups', 'arm', 'arms', 'case', 'cases', 'cohort',
    'method', 'methods', 'result', 'results', 'data', 'analysis', 'analyses', 'level', 'levels', 'time',
    'times', 'year', 'years', 'day', 'days', 'week', 'weeks', 'month', 'months', 'age', 'sex', 'body',
    'blood', 'cell', 'cells', 'tissue', 'tissues', 'gene', 'genes', 'protein', 'proteins', 'drug', 'drugs',
    'disease', 'diseases', 'cancer', 'tumor', 'tumors', 'tumour', 'tumours', 'neoplasm', 'neoplasms',
    'treatment', 'treatments', 'therapy', 'therapies', 'diagnosis', 'prognosis', 'risk', 'risks', 'health',
    'care', 'death', 'deaths', 'mortality', 'survival', 'response', 'effect', 'effects', 'change', 'changes',
    'increase', 'decrease', 'high', 'low', 'normal', 'clinical', 'primary', 'secondary', 'severe', 'mild',
    'chronic', 'acute', 'total', 'mean', 'median', 'rate', 'rates', 'ratio', 'value', 'values', 'score',
    'scores', 'test', 'tests', 'sample', 'samples', 'measure', 'measures', 'significant', 'significance',
    // 通用英文词，且 MeSH 里的同形条目是出版物类型（Overall, D016424）——见
    // isPublicationCharacteristic，这里再加一道，防的是「多词短语里也夹着它」的情形
    'overall',
  ].map((w) => w),
)

// ---------------------------------------------------------------------------
// 归一化 / 分词（与 mesh_build.py 同源）
// ---------------------------------------------------------------------------

/** NFKD → 去组合字符 → 删撇号 → 小写 → 非字/数/下划线变空格 → 压缩空格 */
export function normalizeText(input) {
  if (input === null || input === undefined) return ''
  const s0 = String(input)
  if (s0.length === 0) return ''
  let s = s0.normalize('NFKD')
  s = s.replace(/\p{M}+/gu, '')
  s = s.replace(/['\u2019\u02bc]/g, '')
  s = s.toLowerCase()
  s = s.replace(/[^\p{L}\p{N}_]+/gu, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 切词。撇号按「词内」处理（`Crohn's` 是一个词，归一化后 `crohns`），
 * 这样才和索引里由 `Crohn's Disease` 生成的 `crohns disease` 对得上。
 */
export function tokenize(text) {
  const s = text === null || text === undefined ? '' : String(text)
  const out = []
  const re = /[\p{L}\p{N}_]+(?:['\u2019\u02bc][\p{L}\p{N}_]+)*/gu
  let m
  while ((m = re.exec(s)) !== null) {
    out.push({ raw: m[0], norm: normalizeText(m[0]), start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * 按句读切成互不跨界的片段，避免 n-gram 拼出「跨句子」的假短语。
 *
 * 逗号必须在边界里：英文文献的并列清单写成 "age, sex, education, income"，
 * 逗号不作边界时 n-gram 会把相邻两项拼成一个 MeSH 词——实测
 * "sex, education" 命中 Sex Education（D012736）、"insulin, resistance" 命中
 * Insulin Resistance（D007333），于是提示词里出现原文根本没有的术语。
 * 代价是 MeSH 的倒置词条（"Anemia, Sickle Cell" 这类写法）不再匹配，
 * 但它们的规范名（Sickle Cell Anemia）照旧能命中。
 */
export function splitMatchSegments(text) {
  const s = text === null || text === undefined ? '' : String(text)
  const out = []
  const re = /[^.;:!?()[\]{}"“”,，\n\r\t]+/g
  let m
  while ((m = re.exec(s)) !== null) {
    if (m[0].trim().length === 0) continue
    out.push({ text: m[0], offset: m.index })
  }
  return out
}

// ---------------------------------------------------------------------------
// 索引读取
// ---------------------------------------------------------------------------

export function kindOfId(id) {
  const prefix = String(id || '').slice(5, 6).toUpperCase()
  if (prefix === 'D') return 'descriptor'
  if (prefix === 'Q') return 'qualifier'
  if (prefix === 'C') return 'supplemental'
  return 'unknown'
}

export const KIND_LABEL = {
  descriptor: '主题词',
  qualifier: '限定词',
  supplemental: '补充概念',
  unknown: '未知',
}

/**
 * 索引各段是否都落在文件内。
 *
 * 头部合法、正文却被截断时（74 MiB 的文件复制 / 构建中断），偏移表本身就越界了，
 * 直到真正读某个术语才抛 RangeError——那时翻译已经走到一半，面板只能显示一句
 * Node 的报错。构造函数与 `status()` 共用这一份判定，免得出现
 * 「status 说健康、一翻译就 500」这种自相矛盾。
 *
 * `f.len` 是文件长度：构造函数传 Buffer 长度，status() 传 statSync 的大小（不整份读入）。
 */
export function indexBoundsError(f) {
  const within = (start, bytes, what) => {
    if (!Number.isInteger(start) || start < HEADER_BYTES || start + bytes > f.len) {
      return `MeSH 索引文件不完整（${what}越界：需 ${start + bytes} 字节，实为 ${f.len}）`
    }
    return null
  }
  return (
    within(f.termOffStart, 4 * (f.termCount + 1), '术语偏移表') ||
    within(f.refOffStart, 4 * (f.termCount + 1), '引用偏移表') ||
    within(f.refArrStart, 4 * f.refCount, '引用数组') ||
    within(f.recOffStart, 4 * (f.recordCount + 1), '记录偏移表') ||
    within(f.recBlobStart, 0, '记录块') ||
    within(f.metaStart, f.metaLen, '元数据') ||
    null
  )
}

export class MeshIndex {
  constructor(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) throw new Error('MeSH 索引文件不完整')
    if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error(`MeSH 索引 magic 不符（读到 ${JSON.stringify(buf.toString('latin1', 0, 8))}）`)
    this.buf = buf
    this.version = buf.readUInt32LE(8)
    this.termCount = buf.readUInt32LE(12)
    this.recordCount = buf.readUInt32LE(16)
    this.refCount = buf.readUInt32LE(20)
    this.defLimit = buf.readUInt32LE(24)
    this.builtEpoch = buf.readUInt32LE(28)
    this.termsStart = buf.readUInt32LE(32)
    this.termOffStart = buf.readUInt32LE(36)
    this.refOffStart = buf.readUInt32LE(40)
    this.refArrStart = buf.readUInt32LE(44)
    this.recOffStart = buf.readUInt32LE(48)
    this.recBlobStart = buf.readUInt32LE(52)
    this.metaStart = buf.readUInt32LE(56)
    this.metaLen = buf.readUInt32LE(60)
    if (this.termCount === 0 || this.recordCount === 0) throw new Error('MeSH 索引是空的')
    const bounds = indexBoundsError({
      len: buf.length,
      termCount: this.termCount,
      recordCount: this.recordCount,
      refCount: this.refCount,
      termOffStart: this.termOffStart,
      refOffStart: this.refOffStart,
      refArrStart: this.refArrStart,
      recOffStart: this.recOffStart,
      recBlobStart: this.recBlobStart,
      metaStart: this.metaStart,
      metaLen: this.metaLen,
    })
    if (bounds !== null) throw new Error(bounds)
    const within = (start, bytes, what) => {
      if (!Number.isInteger(start) || start < HEADER_BYTES || start + bytes > buf.length) {
        throw new Error(`MeSH 索引文件不完整（${what}越界：需 ${start + bytes} 字节，实为 ${buf.length}）`)
      }
    }
    within(this.termOffStart, 4 * (this.termCount + 1), '术语偏移表')
    within(this.refOffStart, 4 * (this.termCount + 1), '引用偏移表')
    within(this.refArrStart, 4 * this.refCount, '引用数组')
    within(this.recOffStart, 4 * (this.recordCount + 1), '记录偏移表')
    within(this.recBlobStart, 0, '记录块')
    within(this.metaStart, this.metaLen, '元数据')
    const lastOffset = (offStart, i) => buf.readUInt32LE(offStart + 4 * i)
    if (this.termsStart + lastOffset(this.termOffStart, this.termCount) > buf.length) {
      throw new Error('MeSH 索引文件不完整（术语块被截断）')
    }
    if (this.refArrStart + lastOffset(this.refOffStart, this.termCount) > buf.length) {
      throw new Error('MeSH 索引文件不完整（引用数组被截断）')
    }
    if (this.recBlobStart + lastOffset(this.recOffStart, this.recordCount) > buf.length) {
      throw new Error('MeSH 索引文件不完整（记录块被截断）')
    }
  }

  static load(file) {
    return new MeshIndex(fs.readFileSync(file))
  }

  termAt(i) {
    const a = this.buf.readUInt32LE(this.termOffStart + 4 * i)
    const b = this.buf.readUInt32LE(this.termOffStart + 4 * (i + 1))
    return this.buf.toString('utf8', this.termsStart + a, this.termsStart + b)
  }

  refsAt(i) {
    const a = this.buf.readUInt32LE(this.refOffStart + 4 * i)
    const b = this.buf.readUInt32LE(this.refOffStart + 4 * (i + 1))
    const out = []
    for (let k = a; k < b; k++) out.push(this.buf.readUInt32LE(this.refArrStart + 4 * k))
    return out
  }

  /** 归一化术语（已 normalizeText）→ 记录下标数组；命中不了返回空数组 */
  lookup(normalized) {
    const norm = normalized === null || normalized === undefined ? '' : String(normalized)
    if (norm.length === 0) return []
    const q = Buffer.from(norm, 'utf8')
    let lo = 0
    let hi = this.termCount - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const a = this.buf.readUInt32LE(this.termOffStart + 4 * mid)
      const b = this.buf.readUInt32LE(this.termOffStart + 4 * (mid + 1))
      const cmp = this.buf.compare(q, 0, q.length, this.termsStart + a, this.termsStart + b)
      if (cmp === 0) return this.refsAt(mid)
      if (cmp < 0) lo = mid + 1
      else hi = mid - 1
    }
    return []
  }

  recordAt(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.recordCount) return null
    const a = this.buf.readUInt32LE(this.recOffStart + 4 * i)
    const b = this.buf.readUInt32LE(this.recOffStart + 4 * (i + 1))
    const parts = this.buf.toString('utf8', this.recBlobStart + a, this.recBlobStart + b).split(FIELD_SEP)
    const [id, name, def, cat, tree, map] = parts
    return {
      id: id || '',
      ui: (id || '').replace(/^mesh:/, ''),
      kind: kindOfId(id),
      name: name || '',
      def: def || '',
      cat: cat || '',
      tree: tree || '',
      map: map || '',
    }
  }

  meta() {
    try {
      return JSON.parse(this.buf.toString('utf8', this.metaStart, this.metaStart + this.metaLen))
    } catch {
      return null
    }
  }
}

/**
 * 索引来源：既支持「先廉价看状态、第一次真要翻译时才整份加载」，
 * 也支持加载失败后不再反复重试。
 */
export function createMeshSource(file) {
  const target = file && String(file).trim().length > 0 ? String(file).trim() : DEFAULT_MESH_FILE
  let index = null
  let loadError = null
  return {
    file: target,
    loaded() {
      return index !== null
    },
    status() {
      let bytes = 0
      try {
        bytes = fs.statSync(target).size
      } catch (error) {
        return { ok: false, file: target, bytes: 0, error: '读不到 MeSH 索引：' + String((error && error.message) || error) }
      }
      try {
        const fd = fs.openSync(target, 'r')
        try {
          const head = Buffer.alloc(HEADER_BYTES)
          const n = fs.readSync(fd, head, 0, HEADER_BYTES, 0)
          if (n < HEADER_BYTES) return { ok: false, file: target, bytes, error: 'MeSH 索引头部不完整' }
          if (head.toString('latin1', 0, 8) !== MAGIC) return { ok: false, file: target, bytes, error: 'MeSH 索引格式不符' }
          // 只用头部 68 字节 + 文件大小就能判出「正文被截断」：
          // 否则 ping 会报一份健康的状态，真正翻译时才炸（见 indexBoundsError 的说明）。
          const bounds = indexBoundsError({
            len: bytes,
            termCount: head.readUInt32LE(12),
            recordCount: head.readUInt32LE(16),
            refCount: head.readUInt32LE(20),
            termOffStart: head.readUInt32LE(36),
            refOffStart: head.readUInt32LE(40),
            refArrStart: head.readUInt32LE(44),
            recOffStart: head.readUInt32LE(48),
            recBlobStart: head.readUInt32LE(52),
            metaStart: head.readUInt32LE(56),
            metaLen: head.readUInt32LE(60),
          })
          if (bounds !== null) return { ok: false, file: target, bytes, error: bounds }
          return {
            ok: true,
            file: target,
            bytes,
            termCount: head.readUInt32LE(12),
            recordCount: head.readUInt32LE(16),
            refCount: head.readUInt32LE(20),
            defLimit: head.readUInt32LE(24),
            builtEpoch: head.readUInt32LE(28),
            loaded: index !== null,
          }
        } finally {
          fs.closeSync(fd)
        }
      } catch (error) {
        return { ok: false, file: target, bytes, error: '读 MeSH 索引头失败：' + String((error && error.message) || error) }
      }
    },
    get() {
      if (index !== null) return { ok: true, index }
      if (loadError !== null) return { ok: false, error: loadError }
      try {
        index = MeshIndex.load(target)
        return { ok: true, index }
      } catch (error) {
        loadError = '加载 MeSH 索引失败：' + String((error && error.message) || error)
        return { ok: false, error: loadError }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 术语匹配
// ---------------------------------------------------------------------------

export const DEFAULT_MESH_OPTIONS = {
  /** 单次最多注入多少个术语（按词长 / 特异性挑选） */
  maxTerms: 40,
  /** n-gram 最长几个词 */
  maxGram: 6,
  /** 单字命中允许的最大候选记录数（越大越泛化） */
  maxSingleRefs: 3,
  /** 单字命中要求的最短归一化长度 */
  minSingleLength: 5,
}

/**
 * 记录是否属于 MeSH 的**出版物特征**（Publication Characteristics，树号 V*）。
 *
 * V 树里装的是「文献是什么体裁」而不是医学概念：Overall（D016424）的定义是
 * 「会议摘要汇编」，Comment / Editorial / Letter / News / Review / Map 同理。
 * 它们的名字恰好都是普通英文词，单词命中时几乎必然是正文里的普通词——实测
 * "Median overall survival was 38.6 months" 会把 Overall 当成术语约束注入提示词。
 * 多词短语不受此限（Randomized Controlled Trial 这类研究设计名照旧可用）。
 */
export function isPublicationCharacteristic(tree) {
  const parts = String(tree ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (parts.length === 0) return false
  return parts.every((t) => t.startsWith('V'))
}

/**
 * 单字命中是否「名副其实」。
 *
 * `acceptSingleToken` 只看词长与候选数，挡不住这类错配（都在真实语料里实测过）：
 *
 *   `adjustment` → Adaptation, Psychological（D000223，心理适应）
 *   `association` → Association（D001244，讲的是心理现象之间的功能联系）
 *   `compliance` → Compliance（D003187，讲的是肺这类腔隙的可扩张性）
 *   `sensitivity` → Sensitivity and Specificity；`supervision` → Organization and Administration
 *
 * 这些词在正文里就是普通英文词。它们一旦被当成术语约束注入提示词，就等于让模型把
 * 统计学的「校正 / 关联 / 依从性」往心理学、生理学概念上靠——而术语约束这条通道的
 * 全部价值在于**准**，宁可少给。
 *
 * 判据两条，都来自数据本身：
 *   1. 该写法必须**就是** MeSH 的规范名（同义词到概念的映射交给多词短语去认——
 *      「drug therapy」「body mass index」这类短语照旧命中）；
 *   2. 记录不能落在 `concept` 这个抽象桶里：单字的抽象概念名（Overall、Association、
 *      Compliance）几乎全是普通英文词。
 * 全大写缩写（HR、GWAS、EGFR）不受这两条限制——缩写的信息量恰恰在于缩写本身。
 */
export function singleTokenIsFaithful(token, refs, index) {
  const raw = String((token && token.raw) || '')
  if (raw.length >= 2 && raw.length <= 12 && /^[A-Z][A-Z0-9-]*$/.test(raw)) return true
  if (!index || typeof index.recordAt !== 'function') return true
  const rec = index.recordAt(refs[0])
  if (rec === null) return false
  if (normalizeText(rec.name) !== String((token && token.norm) || '')) return false
  if (rec.cat === 'concept') return false
  return true
}

/** 单字是否值得作为术语约束（多词短语一律接受） */
export function acceptSingleToken(token, refs, options = {}) {
  const opts = { ...DEFAULT_MESH_OPTIONS, ...options }
  const norm = token && typeof token.norm === 'string' ? token.norm : ''
  const raw = token && typeof token.raw === 'string' ? token.raw : ''
  if (norm.length < 2) return false
  if (!/\p{L}/u.test(norm)) return false
  if (STOPWORDS.has(norm)) return false
  // 全大写缩写（HR、GWAS、EGFR、IL-6）信息量高，放行
  if (raw.length >= 2 && raw.length <= 12 && /^[A-Z][A-Z0-9-]*$/.test(raw)) return true
  if (norm.length < opts.minSingleLength) return false
  return refs.length <= opts.maxSingleRefs
}

/**
 * 在原文里找出 MeSH 收录的术语。
 * 返回 { matches, total, truncated, options }；matches 按出现顺序排列。
 */
export function findMeshTerms(index, text, options = {}) {
  const opts = { ...DEFAULT_MESH_OPTIONS, ...options }
  const s = text === null || text === undefined ? '' : String(text)
  const found = []
  if (index === null || index === undefined || s.length === 0) {
    return { matches: [], total: 0, truncated: false, options: opts }
  }
  for (const seg of splitMatchSegments(s)) {
    const tokens = tokenize(seg.text)
    let i = 0
    while (i < tokens.length) {
      const maxN = Math.min(opts.maxGram, tokens.length - i)
      let hit = null
      for (let n = maxN; n >= 1; n--) {
        const parts = []
        let bad = false
        for (let k = 0; k < n; k++) {
          const norm = tokens[i + k].norm
          if (norm.length === 0) {
            bad = true
            break
          }
          parts.push(norm)
        }
        if (bad) continue
        const phrase = parts.join(' ')
        if (phrase.length < 2) continue
        const refs = index.lookup(phrase)
        if (refs.length === 0) continue
        if (n === 1) {
          // 限定词的缩写（CI=chemically induced、AD=administration & dosage、AE=adverse effects…）
          // 是检索用的副主题词缩写，在正文里几乎全是噪音——「95% CI」会被当成 CI 命中，
          // 所以单字命中一律不接受限定词；多词短语（如 adverse effects）仍然放行。
          const rec0 = index.recordAt(refs[0])
          if (rec0 !== null && rec0.kind === 'qualifier') continue
          // 出版物特征（树号 V*）的单词名几乎全是普通英文词，见 isPublicationCharacteristic
          if (rec0 !== null && isPublicationCharacteristic(rec0.tree)) continue
          if (!acceptSingleToken(tokens[i], refs, opts)) continue
          if (!singleTokenIsFaithful(tokens[i], refs, index)) continue
        }
        hit = { n, refs, phrase }
        break
      }
      if (hit === null) {
        i += 1
        continue
      }
      const rec = index.recordAt(hit.refs[0])
      const start = seg.offset + tokens[i].start
      const end = seg.offset + tokens[i + hit.n - 1].end
      if (rec !== null) {
        found.push({
          surface: s.slice(start, end),
          norm: hit.phrase,
          tokens: hit.n,
          candidates: hit.refs.length,
          id: rec.id,
          ui: rec.ui,
          kind: rec.kind,
          name: rec.name,
          def: rec.def,
          cat: rec.cat,
          tree: rec.tree,
          map: rec.map,
          start,
          end,
        })
      }
      i += hit.n
    }
  }

  // 同一概念只留第一次出现；超出上限时按「词更长、更少见」优先，再回到原文顺序
  const deduped = []
  const seen = new Set()
  for (const m of found) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    deduped.push(m)
  }
  let list = deduped
  if (list.length > opts.maxTerms) {
    const ranked = deduped
      .slice()
      .sort((a, b) => b.tokens - a.tokens || a.candidates - b.candidates || a.start - b.start)
    const keep = new Set(ranked.slice(0, opts.maxTerms).map((m) => m.id))
    list = deduped.filter((m) => keep.has(m.id))
  }
  return { matches: list, total: deduped.length, truncated: deduped.length > list.length, options: opts }
}

/**
 * 组装注入系统提示词的术语约束块。
 *
 * 措辞上刻意把边界写死：MeSH 只有英文，**没有**中文名。
 * 这一段是提示词，不是译文；不要在这里出现任何中文术语译名。
 */
export function renderMeshBlock(result, options = {}) {
  const opts = { defChars: 120, maxChars: 3600, ...options }
  const matches = result && Array.isArray(result.matches) ? result.matches : []
  if (matches.length === 0) return ''
  const head =
    '【MeSH 2026 术语约束（机器自动匹配，只用于统一英文术语口径，不是译文）】'
  const lines = [head]
  let used = head.length
  for (const m of matches) {
    const tag = `${m.name}（${m.id}，${KIND_LABEL[m.kind] || m.kind}）`
    let line = `- ${tag}`
    if (m.surface && normalizeText(m.surface) !== normalizeText(m.name) && m.name.length > 0) {
      line += ` ← 原文写作「${m.surface}」`
    }
    if (m.def) {
      const def = m.def.length > opts.defChars ? m.def.slice(0, opts.defChars - 1).trimEnd() + '…' : m.def
      line += `：${def}`
    }
    if (used + line.length + 1 > opts.maxChars) {
      lines.push(`- （还有 ${matches.length - (lines.length - 1)} 个术语因长度限制未列出）`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  lines.push(
    '约束：' +
      // annotate=false 时系统提示词里写着「全文只用中文表达，专业术语不要附英文原文」。
      // 这一条若还要求「按 MeSH 规范名书写」，等于把两条相反的指令塞给模型，
      // 结果就是纯中文模式里仍然漏出英文括号。所以措辞随 annotate 走。
      (opts.annotate === false
        ? '① 上述术语只用来说明概念口径：译文中一律用中文表达，不要把英文原名或缩写写进译文；'
        : '① 上述英文术语按 MeSH 规范名书写（原文若有不同写法，中文译文对应同一概念）；') +
      '② 中文译名由你按医学文献翻译规范给出——MeSH 只有英文，没有中文名，不要声称存在「官方中文名」；' +
      '③ 同一术语在本段、上文参考与后续段落之间必须保持同一译法；' +
      '④ 这一段只是术语提示，不要翻译它，也不要出现在译文里。',
  )
  return lines.join('\n')
}

/** 工具输出里的一行摘要（让人一眼看到这次到底约束了什么） */
export function renderMeshSummary(matches, options = {}) {
  const list = Array.isArray(matches) ? matches : []
  const maxNames = options.maxNames || 5
  if (list.length === 0) return 'MeSH 术语约束：本段没有命中 MeSH 收录的术语'
  const names = list.slice(0, maxNames).map((m) => m.name).filter((n) => n && n.length > 0)
  const more = list.length > names.length ? ` 等 ${list.length} 个` : ''
  return `MeSH 术语约束：命中 ${list.length} 个术语（${names.join('、')}${more}）`
}

/** 把 MeSH 命中压缩成面板能存的小结构（只留展示需要的字段） */
export function meshBrief(matches, options = {}) {
  const list = Array.isArray(matches) ? matches : []
  const maxNames = options.maxNames || 6
  return {
    count: list.length,
    names: list.slice(0, maxNames).map((m) => `${m.name}（${m.ui}）`),
    terms: list.map((m) => ({ name: m.name, ui: m.ui, kind: m.kind, cat: m.cat, tree: m.tree })),
  }
}
