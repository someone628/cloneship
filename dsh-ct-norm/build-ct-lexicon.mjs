#!/usr/bin/env node
/**
 * dsh-ct-norm —— 词表构建脚本
 *
 * 把 `data/src/` 下人工整理的中文 CT 报告别名词表（源文件里只写 **MeSH 英文规范名**），
 * 拿去 NLM 的 MeSH 2026 索引里逐条反解，产出插件运行时真正读取的三份文件：
 *
 *   data/ct.lexicon.jsonl    别名词表（含反解出的 MeSH 编号 / 规范名 / 树号）
 *   data/mesh.subset.jsonl   只含词表引用到的 MeSH 概念（规范名 / 释义 / 树号）
 *   data/ct.manifest.json    构建清单（输入文件的 sha256、条数、MeSH 版本与索引指纹）
 *
 * ## 为什么源文件不写 MeSH 编号
 *
 * 编号一旦由人写，就有编造的可能；而规范名由机器去 NLM 索引反解，反解不到就**构建失败**。
 * 于是「归一化输出里的每一个 MeSH 编号都来自 NLM 索引」成了构建期的不变量，
 * 而不是一句口头承诺。运行时插件只读 mesh.subset.jsonl，它在物理上就产不出子集之外的编号。
 *
 * ## 用法
 *
 *   node build-ct-lexicon.mjs                 # 校验 + 写产物
 *   node build-ct-lexicon.mjs --check         # 只校验，不写产物
 *   node build-ct-lexicon.mjs --mesh <路径>   # 指定 MeSH 索引（默认 ../mesh_out/mesh_index.bin）
 *   node build-ct-lexicon.mjs --quiet         # 只输出结论行
 *
 * MeSH 索引由工作区的 `mesh_build.py build` 从 NLM 的 desc2026.xml / supp2026.xml 生成，
 * 格式见 dsh-lit-translate/lib/mesh.js 顶部注释。本脚本自带一个只读的极简解析器
 * （只需要「按术语查记录」与「按下标取记录」两件事），以免重新构建时还依赖另一个插件目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, 'data', 'src')
const OUT_DIR = path.join(HERE, 'data')
const RULES_FILE = path.join(OUT_DIR, 'ct.rules.json')

const DEFAULT_MESH = path.join(HERE, '..', 'mesh_out', 'mesh_index.bin')

const FIELD_SEP = '\x1f'
const HEADER_BYTES = 68
const MAGIC = 'MESHIDX1'

const KINDS = new Set(['anatomy', 'finding', 'neoplasm', 'assessment', 'imaging', 'morphology'])
const ACTIONS = new Set(['metastasis', 'neoplasm', 'mass', 'nodule', 'lesion', 'recurrence'])
/** 这些 action 必须带一个「无部位时」的基础概念；mass/lesion 是刻意不映射的 */
const ACTION_NEEDS_MESH = new Set(['metastasis', 'neoplasm', 'recurrence'])
const REGIONS = new Set([
  'chest', 'abdomen', 'pelvis', 'head-neck', 'msk', 'neuro', 'vascular', 'systemic', 'imaging',
])

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const CHECK_ONLY = flag('check')
const QUIET = flag('quiet')
const MESH_FILE = opt('mesh', DEFAULT_MESH)

const say = (msg) => { if (!QUIET) console.log(msg) }

// ---------------------------------------------------------------------------
// 归一化（必须与 mesh_build.py 的 normalize()、dsh-lit-translate/lib/mesh.js 完全一致）
// ---------------------------------------------------------------------------
function normalizeText(input) {
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

// ---------------------------------------------------------------------------
// MeSH 索引的极简只读解析（只需 lookup / recordAt）
// ---------------------------------------------------------------------------
class MeshReader {
  constructor(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) throw new Error('MeSH 索引文件不完整')
    if (buf.toString('latin1', 0, 8) !== MAGIC) {
      throw new Error(`MeSH 索引 magic 不符（读到 ${JSON.stringify(buf.toString('latin1', 0, 8))}）`)
    }
    this.buf = buf
    this.termCount = buf.readUInt32LE(12)
    this.recordCount = buf.readUInt32LE(16)
    this.termsStart = buf.readUInt32LE(32)
    this.termOffStart = buf.readUInt32LE(36)
    this.refOffStart = buf.readUInt32LE(40)
    this.refArrStart = buf.readUInt32LE(44)
    this.recOffStart = buf.readUInt32LE(48)
    this.recBlobStart = buf.readUInt32LE(52)
    this.metaStart = buf.readUInt32LE(56)
    this.metaLen = buf.readUInt32LE(60)
    if (this.termCount === 0 || this.recordCount === 0) throw new Error('MeSH 索引是空的')
  }

  static load(file) { return new MeshReader(fs.readFileSync(file)) }

  termAt(i) {
    const a = this.buf.readUInt32LE(this.termOffStart + 4 * i)
    const b = this.buf.readUInt32LE(this.termOffStart + 4 * (i + 1))
    return this.buf.toString('utf8', this.termsStart + a, this.termsStart + b)
  }

  lookup(normalized) {
    if (!normalized) return []
    const q = Buffer.from(normalized, 'utf8')
    let lo = 0
    let hi = this.termCount - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const a = this.buf.readUInt32LE(this.termOffStart + 4 * mid)
      const b = this.buf.readUInt32LE(this.termOffStart + 4 * (mid + 1))
      const cmp = this.buf.compare(q, 0, q.length, this.termsStart + a, this.termsStart + b)
      if (cmp === 0) {
        const ra = this.buf.readUInt32LE(this.refOffStart + 4 * mid)
        const rb = this.buf.readUInt32LE(this.refOffStart + 4 * (mid + 1))
        const out = []
        for (let k = ra; k < rb; k++) out.push(this.buf.readUInt32LE(this.refArrStart + 4 * k))
        return out
      }
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
    const prefix = String(id || '').slice(5, 6).toUpperCase()
    return {
      id: id || '',
      ui: (id || '').replace(/^mesh:/, ''),
      kind: prefix === 'D' ? 'descriptor' : prefix === 'Q' ? 'qualifier' : prefix === 'C' ? 'supplemental' : 'unknown',
      name: name || '',
      def: def || '',
      cat: cat || '',
      tree: tree || '',
      map: map || '',
    }
  }

  meta() {
    try { return JSON.parse(this.buf.toString('utf8', this.metaStart, this.metaStart + this.metaLen)) } catch { return null }
  }

  /** 把一个人写的 MeSH 名字反解成唯一的描述符记录；不确定就返回 {error} */
  resolve(name) {
    const refs = this.lookup(normalizeText(name))
    if (refs.length === 0) return { error: `MeSH 索引里查不到这个名字（连入口词都没有）` }
    const recs = refs.map((i) => this.recordAt(i))
    const descriptors = recs.filter((r) => r.kind === 'descriptor')
    if (descriptors.length === 1) return { record: descriptors[0] }
    if (descriptors.length === 0) {
      return { error: `只命中非描述符记录（${recs.map((r) => `${r.kind}:${r.name}`).join(' / ')}）——请改用对应的描述符规范名` }
    }
    return { error: `命中 ${descriptors.length} 条描述符记录（${descriptors.map((r) => `${r.ui}:${r.name}`).join(' / ')}），有歧义` }
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
const FORBIDDEN_CHARS_RE = /[，。、；：（）()\[\]{}"'“”‘’·／/\\<>\s]/
const DIGITS_RE = /[0-9０-９]/

/** 规则文件里「修饰词」四组的全部词（不含极性词） */
function fillerWordsOf(rules) {
  const words = []
  for (const list of Object.values(rules.filler || {})) {
    if (Array.isArray(list)) words.push(...list)
  }
  return words.filter((w) => typeof w === 'string' && w)
}

function buildFillerRegex(rules) {
  const words = fillerWordsOf(rules)
  // 最长优先，避免「双侧」被「双」抢先
  words.sort((a, b) => b.length - a.length)
  return new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')
}

function normApprox(entry, errors) {
  const raw = entry.approx
  if (raw === undefined || raw === false || raw === null) return []
  const all = [...(entry.zh || []), ...(entry.en || [])]
  if (raw === true) return all
  if (!Array.isArray(raw)) {
    errors.push(`approx 必须是 true / false / 字符串数组，实际是 ${typeof raw}`)
    return []
  }
  const out = []
  for (const a of raw) {
    if (!all.includes(a)) errors.push(`approx 里列了「${a}」，但它不在本条的 zh/en 别名里`)
    else out.push(a)
  }
  return out
}

function main() {
  const errors = []
  const warnings = []

  // ---- 索引 ----
  if (!fs.existsSync(MESH_FILE)) {
    console.error(`[x] 找不到 MeSH 索引：${MESH_FILE}`)
    console.error('    先用工作区的 python mesh_build.py build 生成，或用 --mesh 指定路径。')
    process.exit(1)
  }
  const meshBuf = fs.readFileSync(MESH_FILE)
  const mesh = new MeshReader(meshBuf)
  const meshMeta = mesh.meta() || {}
  say(`[i] MeSH 索引：${MESH_FILE}`)
  say(`    ${meshMeta.mesh_release || '(未知版本)'}，${mesh.recordCount.toLocaleString()} 条记录 / ${mesh.termCount.toLocaleString()} 条术语`)

  // ---- 规则文件 ----
  if (!fs.existsSync(RULES_FILE)) {
    console.error(`[x] 找不到规则文件：${RULES_FILE}`)
    process.exit(1)
  }
  const rulesRaw = fs.readFileSync(RULES_FILE, 'utf8')
  let rules
  try { rules = JSON.parse(rulesRaw) } catch (e) {
    console.error(`[x] ct.rules.json 不是合法 JSON：${e.message}`)
    process.exit(1)
  }
  const fillerRe = buildFillerRegex(rules)
  /**
   * 运行时会从「骨架文本」里屏蔽掉的词：程度/数量/侧别/变化（filler）+ 否定/不确定提示词。
   *
   * 注意：**别名里出现这些词并不算错**。有些写法没有别的形式可选，例如
   * 「无病生存」「无进展生存」含「无」，「多发性骨髓瘤」含「多发」。
   * 这类别名由 lib/lexicon.js 的「原文匹配」通道处理，照常能命中。
   * 这里只拦一种情况：整条别名全部由这些词组成（等于没写内容）。
   */
  const polarityWords = [
    ...(rules?.attributes?.negation?.cues ?? []),
    ...(rules?.attributes?.uncertainty?.cues ?? []),
  ].filter((w) => typeof w === 'string' && w)
  const allMaskWords = [...new Set([...fillerWordsOf(rules), ...polarityWords])].sort((a, b) => b.length - a.length)
  const stripMaskWords = (s) => {
    let out = s
    for (const w of allMaskWords) out = out.split(w).join('')
    return out
  }
  const usesMaskChannel = (s) => allMaskWords.some((w) => s.includes(w))

  // ---- 源文件 ----
  const srcFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.json')).sort()
  if (srcFiles.length === 0) {
    console.error(`[x] ${SRC_DIR} 下没有任何 .json 源文件`)
    process.exit(1)
  }

  const entries = []
  const srcHashes = {}
  for (const f of srcFiles) {
    const full = path.join(SRC_DIR, f)
    const text = fs.readFileSync(full, 'utf8')
    srcHashes[f] = { sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }
    let arr
    try { arr = JSON.parse(text) } catch (e) {
      errors.push(`${f}: 不是合法 JSON —— ${e.message}`)
      continue
    }
    if (!Array.isArray(arr)) { errors.push(`${f}: 顶层必须是数组`); continue }
    srcHashes[f].entries = arr.length
    for (const e of arr) entries.push({ ...e, __file: f })
  }

  say(`[i] 源文件 ${srcFiles.length} 个，共 ${entries.length} 条`)

  // ---- 逐条校验 ----
  const conceptCache = new Map()
  const resolveMesh = (name, where) => {
    if (conceptCache.has(name)) {
      const c = conceptCache.get(name)
      if (c.error) errors.push(`${where}: 「${name}」—— ${c.error}`)
      return c.record || null
    }
    const r = mesh.resolve(name)
    conceptCache.set(name, r)
    if (r.error) errors.push(`${where}: 「${name}」—— ${r.error}`)
    return r.record || null
  }

  const idSeen = new Map()
  const aliasSeen = new Map()
  const usedConcepts = new Map() // ui -> record
  let maskedAliasCount = 0

  const built = []
  for (const e of entries) {
    const where = `${e.__file}${e.id ? `:${e.id}` : ''}`
    if (typeof e.id !== 'string' || !e.id.trim()) { errors.push(`${where}: 缺少 id`); continue }
    const id = e.id.trim()
    if (idSeen.has(id)) errors.push(`${where}: id 重复（另一处在 ${idSeen.get(id)}）`)
    else idSeen.set(id, where)

    if (!KINDS.has(e.kind)) { errors.push(`${where}: kind 非法（${e.kind}）`); continue }
    if (e.region !== undefined && !REGIONS.has(e.region)) errors.push(`${where}: region 非法（${e.region}）`)

    // 别名
    const zh = Array.isArray(e.zh) ? e.zh : []
    const en = Array.isArray(e.en) ? e.en : []
    if (zh.length === 0) errors.push(`${where}: zh 为空`)
    const minZh = e.kind === 'anatomy' ? 1 : 3
    if (zh.length > 0 && zh.length < minZh) warnings.push(`${where}: zh 只有 ${zh.length} 个（${e.kind} 建议至少 ${minZh} 个）`)
    for (const a of zh) {
      if (typeof a !== 'string' || !a.trim()) { errors.push(`${where}: 中文别名里有空值`); continue }
      if (FORBIDDEN_CHARS_RE.test(a)) errors.push(`${where}: 中文别名「${a}」含标点/空格（是否误把修饰词或标点写进来了？）`)
      if (DIGITS_RE.test(a)) errors.push(`${where}: 中文别名「${a}」含数字（数字属于属性层，不要进别名）`)
      if (a.length > 12) errors.push(`${where}: 中文别名「${a}」超过 12 字`)
      const m = a.match(fillerRe)
      if (m) warnings.push(`${where}: 中文别名「${a}」含修饰词「${m[1]}」，将由「原文匹配」通道处理；若能改用不含修饰词的等价写法（如去掉「右侧」「多发」）建议改掉`)
      if (!stripMaskWords(a)) errors.push(`${where}: 中文别名「${a}」整条都由修饰词/极性词组成，没有实质内容`)
      if (usesMaskChannel(a)) maskedAliasCount += 1
    }
    for (const a of en) {
      if (typeof a !== 'string' || !a.trim()) { errors.push(`${where}: 英文别名里有空值`); continue }
      // 英文别名允许空格与连字符（non-small-cell），但不允许中文标点
      if (/[，。、；：（）""''“”·／/\\]/.test(a)) errors.push(`${where}: 英文别名「${a}」含中文标点`)
      if (a.length > 48) errors.push(`${where}: 英文别名「${a}」超过 48 字符`)
      if (a !== a.toLowerCase()) errors.push(`${where}: 英文别名「${a}」请用小写`)
    }
    const nkey = new Map()
    for (const a of [...zh, ...en]) {
      const n = normalizeText(a)
      if (!n) { errors.push(`${where}: 别名「${a}」归一化后为空`); continue }
      if (nkey.has(n)) errors.push(`${where}: 本条内别名重复（${a}）`)
      nkey.set(n, a)
      if (aliasSeen.has(n)) {
        errors.push(`${where}: 别名「${a}」与 ${aliasSeen.get(n).where} 的「${aliasSeen.get(n).alias}」重复（归一化后相同）`)
      } else {
        aliasSeen.set(n, { where, alias: a })
      }
    }
    const localErrors = []
    const approx = normApprox(e, localErrors)
    for (const m of localErrors) errors.push(`${where}: ${m}`)

    // 概念
    const out = { id, kind: e.kind, region: e.region ?? null, zh, en, approx, note: e.note ?? null }

    if (e.kind === 'morphology') {
      if (!ACTIONS.has(e.action)) { errors.push(`${where}: morphology 条目的 action 非法（${e.action}）`); continue }
      out.action = e.action
      if (ACTION_NEEDS_MESH.has(e.action) && !e.mesh) {
        errors.push(`${where}: action=${e.action} 必须提供 mesh（无部位时的基础概念）`)
      }
    } else if (!e.mesh) {
      errors.push(`${where}: 缺少 mesh`)
      continue
    }

    if (e.mesh) {
      const rec = resolveMesh(e.mesh, where)
      if (rec) {
        usedConcepts.set(rec.ui, rec)
        out.mesh = { ui: rec.ui, name: rec.name, cat: rec.cat, tree: rec.tree }
      }
    }
    if (e.neoplasm) {
      if (e.kind !== 'anatomy') errors.push(`${where}: 只有 anatomy 条目才能写 neoplasm`)
      const rec = resolveMesh(e.neoplasm, where)
      if (rec) {
        usedConcepts.set(rec.ui, rec)
        out.neoplasm = { ui: rec.ui, name: rec.name, cat: rec.cat, tree: rec.tree }
      }
    }
    // morphology 的隐含概念：淋巴转移特例 / 结节的两个候选
    if (e.lymphaticMesh) {
      const rec = resolveMesh(e.lymphaticMesh, where)
      if (rec) { usedConcepts.set(rec.ui, rec); out.lymphaticMesh = { ui: rec.ui, name: rec.name, cat: rec.cat, tree: rec.tree } }
    }
    if (e.candidates) {
      if (typeof e.candidates !== 'object' || Array.isArray(e.candidates)) {
        errors.push(`${where}: candidates 必须是对象`)
      } else {
        out.candidates = {}
        for (const [k, v] of Object.entries(e.candidates)) {
          const rec = resolveMesh(v, `${where}:candidates.${k}`)
          if (rec) {
            usedConcepts.set(rec.ui, rec)
            out.candidates[k] = { ui: rec.ui, name: rec.name, cat: rec.cat, tree: rec.tree }
          }
        }
      }
    }
    // 按部位决定结果的候选（如「结节」+ 甲状腺 → Thyroid Nodule）。
    // 键是解剖部位的 MeSH 规范名，值是候选概念名；运行期按部位 UI 直接查表，不猜。
    if (e.siteCandidates) {
      if (typeof e.siteCandidates !== 'object' || Array.isArray(e.siteCandidates)) {
        errors.push(`${where}: siteCandidates 必须是「部位 MeSH 名 -> 概念 MeSH 名」的对象`)
      } else {
        out.siteCandidates = {}
        for (const [siteName, conceptName] of Object.entries(e.siteCandidates)) {
          const srec = resolveMesh(siteName, `${where}:siteCandidates 键「${siteName}」`)
          const crec = resolveMesh(conceptName, `${where}:siteCandidates 值「${conceptName}」`)
          if (srec && crec) {
            usedConcepts.set(srec.ui, srec)
            usedConcepts.set(crec.ui, crec)
            out.siteCandidates[srec.ui] = { ui: crec.ui, name: crec.name, cat: crec.cat, tree: crec.tree }
          }
        }
      }
    }
    built.push(out)
  }

  // ---- 与规则文件的一致性 ----
  const unmapped = (rules.unmapped && Array.isArray(rules.unmapped.terms)) ? rules.unmapped.terms : []
  for (const t of unmapped) {
    // 未归一化征象可以声明自己的解剖部位（「胸膜增厚」→ Pleura）：它把部位信息也一并进子集，
    // 于是运行时不靠「就近绑定」去猜——猜出来的部位可能是隔壁小句的。
    if (t.site) {
      const rec = resolveMesh(t.site, `ct.rules.json unmapped「${t.term}」的 site`)
      if (rec) usedConcepts.set(rec.ui, rec)
    }
    for (const a of [...(t.aliases || []), t.term]) {
      if (!a) continue
      const n = normalizeText(a)
      if (aliasSeen.has(n)) {
        errors.push(`ct.rules.json 的 unmapped「${t.term}」里的写法「${a}」与词表条目 ${aliasSeen.get(n).where} 的「${aliasSeen.get(n).alias}」冲突：同一个写法不能既归一化又标记为未归一化`)
      }
    }
  }
  // ---- 结论 ----
  const byKind = {}
  for (const e of built) byKind[e.kind] = (byKind[e.kind] || 0) + 1
  const zhCount = built.reduce((a, e) => a + e.zh.length, 0)
  const enCount = built.reduce((a, e) => a + e.en.length, 0)

  if (errors.length) {
    console.error(`\n[x] 校验未通过，共 ${errors.length} 个问题：\n`)
    for (const e of errors.slice(0, 120)) console.error(`  - ${e}`)
    if (errors.length > 120) console.error(`  … 还有 ${errors.length - 120} 个`)
    process.exit(1)
  }

  say('')
  say(`[+] 校验通过：${built.length} 条词表条目，中文别名 ${zhCount} 个，英文别名 ${enCount} 个`)
  say(`    by kind: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  say(`    引用 MeSH 概念 ${usedConcepts.size} 个（全部反解自 NLM 索引，构建期即确定）`)
  say(`    未归一化征象词 ${unmapped.length} 组`)
  say(`    其中 ${maskedAliasCount} 个中文别名含修饰词/极性词，走「原文匹配」通道（如「无病生存」「多发性骨髓瘤」）`)
  if (warnings.length) {
    say(`    [!] ${warnings.length} 条提醒：`)
    for (const w of warnings.slice(0, 20)) say(`        - ${w}`)
  }

  if (CHECK_ONLY) {
    say('\n[i] --check：只校验，未写产物。')
    return
  }

  // ---- 写产物 ----
  const lexiconLines = built
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => JSON.stringify(e))

  const subsetLines = [...usedConcepts.values()]
    .sort((a, b) => (a.ui < b.ui ? -1 : a.ui > b.ui ? 1 : 0))
    .map((r) => JSON.stringify({
      ui: r.ui, id: r.id, name: r.name, def: r.def, cat: r.cat, tree: r.tree, kind: r.kind,
    }))

  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
  const manifest = {
    format: 'CTNORM1',
    version: pkg.version,
    built_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    mesh_release: meshMeta.mesh_release || null,
    mesh_index: {
      file: path.basename(MESH_FILE),
      bytes: meshBuf.length,
      sha256: crypto.createHash('sha256').update(meshBuf).digest('hex'),
      built_utc: meshMeta.built_utc || null,
      records: mesh.recordCount,
      terms: mesh.termCount,
    },
    counts: {
      entries: built.length,
      byKind,
      aliasesZh: zhCount,
      aliasesEn: enCount,
      meshConcepts: usedConcepts.size,
      unmappedGroups: unmapped.length,
    },
    sources: srcHashes,
    rules: {
      file: 'ct.rules.json',
      sha256: crypto.createHash('sha256').update(rulesRaw).digest('hex'),
      bytes: Buffer.byteLength(rulesRaw),
    },
    note: '本清单记录构建期输入与其指纹，用于复现与审计。mesh.subset.jsonl 只含词表引用到的 MeSH 概念，插件在物理上产不出该子集之外的 MeSH 编号。',
  }

  fs.writeFileSync(path.join(OUT_DIR, 'ct.lexicon.jsonl'), lexiconLines.join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'mesh.subset.jsonl'), subsetLines.join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, 'ct.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  say('')
  say(`[+] 已写出：`)
  say(`    data/ct.lexicon.jsonl   ${lexiconLines.length} 行  ${(fs.statSync(path.join(OUT_DIR, 'ct.lexicon.jsonl')).size / 1024).toFixed(1)} KiB`)
  say(`    data/mesh.subset.jsonl  ${subsetLines.length} 行  ${(fs.statSync(path.join(OUT_DIR, 'mesh.subset.jsonl')).size / 1024).toFixed(1)} KiB`)
  say(`    data/ct.manifest.json`)
}

main()
