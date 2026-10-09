/**
 * dsh-ct-norm —— 文本层
 *
 * 这一层只做确定性的事：全角折半角、大小写折叠、切分句读、屏蔽修饰词、抽取属性。
 * 不含任何模型推断、不联网。
 *
 * ## 为什么要「屏蔽修饰词」再匹配
 *
 * 中文报告写的是「右侧胸腔少量积液」，而词表里的概念写法是「胸腔积液」——
 * 中间插了「侧」「少量」，直接子串匹配是**匹配不上**的。于是先把
 * 程度/数量/侧别/变化 这四类修饰词从匹配用的骨架文本里摘掉，得到「胸腔积液」，
 * 概念就能接上；而侧别、多少这些信息在属性层单独抽取，一个字都不丢。
 *
 * 关键点：屏蔽**只作用于匹配用的骨架文本**，属性判定一律读原文。
 * 所以「未见胸腔积液」里的「未见」不会被屏蔽掉，否定照样判得出来。
 */

/** 侧别 / 程度 / 数量 / 变化 四类修饰词所属的组名 */
export const FILLER_GROUPS = ['severity', 'count', 'laterality', 'change', 'fillerAux']

/**
 * 从规则文件里编出「最长优先」的屏蔽正则，并保留 词 -> 组名 的映射。
 *
 * 默认还会把**否定与不确定的提示词**一并屏蔽（`includePolarity`）。
 * 这一步不做的话，中文报告里极常见的「胸腔见积液」「胸膜未见明显增厚」
 * 都会因为中间插了「见」「未见」而接不上词表里的「胸腔积液」「胸膜增厚」——
 * 而这两个词携带的极性信息本来就要从**原文**单独抽取，屏蔽掉不会丢任何东西。
 */
export function buildFillerMatcher(rules, options = {}) {
  const includePolarity = options.includePolarity !== false
  const group = new Map()
  const words = []
  const addWord = (w, g) => {
    if (typeof w !== 'string' || !w) return
    if (group.has(w)) return
    group.set(w, g)
    words.push(w)
  }
  for (const g of FILLER_GROUPS) {
    const list = rules?.filler?.[g]
    if (!Array.isArray(list)) continue
    for (const w of list) addWord(w, g)
  }
  if (includePolarity) {
    for (const g of ['negation', 'uncertainty']) {
      const list = rules?.attributes?.[g]?.cues
      if (!Array.isArray(list)) continue
      for (const w of list) addWord(w, 'polarity')
    }
  }
  words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  const re = words.length
    ? new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g')
    : null
  return { re, groupOf: (w) => group.get(w) ?? null, words, maxLen: words.reduce((a, w) => Math.max(a, w.length), 0) }
}

/**
 * 逐字符折叠：NFKC（全角→半角、兼容字符归一）+ 小写。
 * 逐字符做而不是整串做，是为了保住「折叠后第 i 个字符 → 原文下标」的映射；
 * 整串 NFKC 会改变长度（如 ㍿ → 株式会社），映射就断了。
 */
export function foldChars(raw) {
  const chars = []
  const rawStart = []
  const rawEnd = []
  const rawLen = raw.length
  let i = 0
  for (const ch of raw) {
    const w = ch.length
    let f
    try { f = ch.normalize('NFKC') } catch { f = ch }
    f = f.toLowerCase()
    for (const c of f) {
      chars.push(c)
      rawStart.push(i)
      rawEnd.push(i + w)
    }
    i += w
    if (i > rawLen) break
  }
  return { chars, rawStart, rawEnd }
}

/**
 * 准备文本：折叠 → 找修饰词区间 → 造骨架文本。
 * 骨架文本（compact）与原文之间靠 `compactRaw[·]` 双向对应，因此匹配到的
 * 位置可以精确映射回原文，用于高亮与人工复核。
 */
export function prepare(raw, filler) {
  const { chars, rawStart, rawEnd } = foldChars(raw)
  const folded = chars.join('')

  // 修饰词区间（按折叠后下标）
  const spans = []
  if (filler.re) {
    filler.re.lastIndex = 0
    let m
    while ((m = filler.re.exec(folded)) !== null) {
      if (m[0].length === 0) { filler.re.lastIndex += 1; continue }
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0], group: filler.groupOf(m[0]) })
    }
  }

  const masked = new Uint8Array(chars.length)
  for (const s of spans) for (let k = s.start; k < s.end; k++) masked[k] = 1

  let compact = ''
  const compactFold = []
  const compactRawStart = []
  const compactRawEnd = []
  for (let k = 0; k < chars.length; k++) {
    if (masked[k]) continue
    compact += chars[k]
    compactFold.push(k)
    compactRawStart.push(rawStart[k])
    compactRawEnd.push(rawEnd[k])
  }

  return { raw, chars, rawStart, rawEnd, folded, compact, compactFold, compactRawStart, compactRawEnd, fillers: spans }
}

/**
 * 切分：先按句末标点切「句」，再按逗号切「小句」。
 * 小句是属性（尤其否定）的作用域——「未见胸腔积液，肝内见转移灶」两个小句极性相反。
 * 顿号「、」刻意不作切分点，否则「未见胸腔积液、腹水」会让「腹水」丢掉否定。
 */
export function buildSegments(raw, rules) {
  const sentenceBreaks = new Set(rules?.segmentation?.sentenceBreaks ?? ['。', '；', ';', '！', '!', '？', '?', '\n', '\r'])
  const clauseBreaks = new Set(rules?.segmentation?.clauseBreaks ?? ['，', ',', '：', ':'])
  const segs = []
  const segOfRaw = new Int32Array(raw.length).fill(-1)

  let start = 0
  let clauseIndex = 0
  let sentenceIndex = 0
  const push = (end) => {
    const text = raw.slice(start, end)
    // 空片段（连续的分隔符、换行后紧跟句号等）不占小句编号，也不该把「句数」顶上去
    if (text.trim().length === 0) return false
    const idx = segs.length
    segs.push({ index: idx, start, end, text, sentenceIndex, clauseIndex })
    for (let k = start; k < end; k++) segOfRaw[k] = idx
    return true
  }
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (sentenceBreaks.has(ch)) {
      if (push(i)) { sentenceIndex += 1; clauseIndex = 0 }
      start = i + 1
    } else if (clauseBreaks.has(ch)) {
      if (push(i)) clauseIndex += 1
      start = i + 1
    }
  }
  if (start < raw.length) push(raw.length)

  // 落在分隔符上的位置没有归属，就近归到前一个小句（便于按 offset 查小句）
  let last = 0
  for (let k = 0; k < raw.length; k++) {
    if (segOfRaw[k] === -1) segOfRaw[k] = last
    else last = segOfRaw[k]
  }
  return { segments: segs, segOfRaw }
}

/** 段落小标题识别：只用于标注「该提及落在哪一段」，不改变归一化结果 */
export function detectSections(raw, rules) {
  const labels = rules?.reportSections?.sections ?? []
  const marks = []
  for (const s of labels) {
    for (const l of s.labels) {
      let from = 0
      for (;;) {
        const i = raw.indexOf(l, from)
        if (i < 0) break
        marks.push({ at: i, end: i + l.length, key: s.key, label: l })
        from = i + l.length
      }
    }
  }
  marks.sort((a, b) => a.at - b.at)
  return marks
}

/** 某个原文偏移落在哪一段（取最近的前置小标题） */
export function sectionAt(marks, offset) {
  let key = null
  for (const m of marks) {
    if (m.at <= offset) key = m.key
    else break
  }
  return key
}

const ALL_ATTRIBUTE_GROUPS = ['negation', 'uncertainty', 'severity', 'count', 'laterality', 'change']

/**
 * 属性抽取。规则：
 *   1. `uncertainty` 优先于 `negation` —— 因为中文的「不除外」里含「除外」，
 *      若不先判不确定，就会出现「不除外转移」被读成「排除转移」这种**语义反转**。
 *   2. 值原样回显（cue），便于人工复核是哪个词触发的判定。
 *   3. 只在小句内生效，不跨句读。
 */
export function extractAttributes(clauseText, rules) {
  const out = {
    negated: false,
    uncertain: false,
    cues: {},
    severity: null,
    count: null,
    laterality: null,
    change: null,
  }
  const attrs = rules?.attributes ?? {}
  const firstOf = (cues) => {
    if (!Array.isArray(cues)) return null
    let best = null
    for (const c of cues) {
      if (typeof c !== 'string' || !c) continue
      const i = clauseText.indexOf(c)
      if (i < 0) continue
      // 命中位置最早者优先；同位置取更长的（更具体）
      if (best === null || i < best.at || (i === best.at && c.length > best.cue.length)) best = { cue: c, at: i }
    }
    return best
  }
  const unc = firstOf(attrs.uncertainty?.cues)
  const neg = firstOf(attrs.negation?.cues)
  if (unc) { out.uncertain = true; out.cues.uncertainty = unc.cue }
  else if (neg) { out.negated = true; out.cues.negation = neg.cue }

  out.severity = firstOf(attrs.severity?.cues)?.cue ?? null
  out.count = firstOf(attrs.count?.cues)?.cue ?? null
  out.laterality = firstOf(attrs.laterality?.cues)?.cue ?? null
  out.change = firstOf(attrs.change?.cues)?.cue ?? null
  return out
}

/** 该属性组是否在规则里存在（用于自检） */
export function attributeGroupsPresent(rules) {
  return ALL_ATTRIBUTE_GROUPS.filter((g) => rules?.attributes?.[g])
}

/**
 * 数值 + 单位的尺寸提取。
 *
 * `range` 是搜索范围（一般是提及所在的小句；找不到时由调用方放宽到整句）。
 * 不限制范围会出事：报告里每个数字都挨得近，上一句的「最大短径约1.5cm」
 * 会被算到下一句的「胸腔积液」头上——冒烟测试里正是这么错的。
 */
export function extractSize(raw, center, rules, range) {
  const cfg = rules?.sizePattern
  if (!cfg || typeof cfg.regex !== 'string') return null
  const win = Number.isFinite(cfg.window) ? cfg.window : 24
  let from = Math.max(0, center - win)
  let to = Math.min(raw.length, center + win)
  if (range) {
    from = Math.max(from, range.from)
    to = Math.min(to, range.to)
  }
  if (to <= from) return null
  const slice = raw.slice(from, to)
  let re
  try { re = new RegExp(cfg.regex, cfg.flags ?? 'i') } catch { return null }
  const m = re.exec(slice)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  const unit = String(m[2] ?? '').toLowerCase()
  const mm = unit === 'cm' || unit === '厘米' || unit === '公分' ? value * 10 : value
  return {
    text: m[0],
    value,
    unit,
    mm: Math.round(mm * 100) / 100,
    at: from + m.index,
  }
}
