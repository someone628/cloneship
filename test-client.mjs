/**
 * dsh-onco-lexicon —— 客户端组件渲染测试。
 *
 * 为什么要写这个：初版只测了 host 侧的 RPC，从未真正渲染过客户端组件，
 * 于是 search 结果的形状不匹配（host 返回扁平对象，客户端却取 hit.entry）
 * 一路漏到界面上，表现为面板显示"渲染出错"。
 *
 * 这里用一个极小的 React 替身（createElement / useState / useEffect / Component）
 * 把组件真正跑起来，因此这类渲染期错误会被直接抓到。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}

// --------------------------------------------------------------------------
// 极小 React 替身
// --------------------------------------------------------------------------
function makeReact() {
  function createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, { children: kids }) }
  }
  // hook 状态必须**按组件**隔离。早先用一个全局数组，导致 SearchPanel（9 个 hook）
  // 跑过之后，PanelIcon 的 useState 拿到的是别人的槽位（值是 'search'），
  // 于是 ICON_SOURCES['search'] 为 undefined —— 测出来的"回退失效"其实是测试自身的 bug。
  const store = new Map() // Comp -> { hooks: [], deps: [] }
  let current = null
  let pendingEffects = []
  let dirty = false

  function slot(Comp) {
    let s = store.get(Comp)
    if (!s) {
      s = { hooks: [], deps: [], cursor: 0 }
      store.set(Comp, s)
    }
    return s
  }

  function createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, { children: kids }) }
  }
  function useState(init) {
    if (!current) throw new Error('useState 在组件之外被调用')
    const s = current // 捕获本组件的槽位：setter 会在渲染之外（事件回调里）被调用
    const i = s.cursor++
    if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(s.hooks[i]) : v
      if (next !== s.hooks[i]) {
        s.hooks[i] = next
        dirty = true
      }
    }
    return [s.hooks[i], set]
  }
  function useEffect(fn, deps) {
    if (!current) throw new Error('useEffect 在组件之外被调用')
    const i = current.cursor++
    const prev = current.deps[i]
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, k) => d !== prev[k])
    if (changed) {
      current.deps[i] = deps ? deps.slice() : null
      pendingEffects.push(fn)
    }
  }
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(o) { this.state = Object.assign({}, this.state, o); dirty = true }
  }
  Component.prototype.isReactComponent = true

  return {
    React: { createElement, useState, useEffect, Component },
    /** 进入某个函数组件的渲染（重置它自己的 hook 游标） */
    enter(Comp) {
      const prev = current
      current = slot(Comp)
      current.cursor = 0
      return prev
    },
    exit(prev) { current = prev },
    /** 把某组件的 hook 状态清空（测试里需要从零开始时用） */
    reset(Comp) { store.delete(Comp) },
    beginPass() { pendingEffects = []; dirty = false; for (const s of store.values()) s.cursor = 0 },
    runEffects() { const fns = pendingEffects; pendingEffects = []; for (const fn of fns) fn(); return fns.length },
    isDirty() { return dirty },
  }
}

/** 递归渲染成文本，并把所有元素收集到 els（便于找到事件处理器） */
function render(el, els) {
  if (el === null || el === undefined || el === false || el === true) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map((c) => render(c, els)).join('')
  if (typeof el !== 'object') return ''
  const { type, props } = el
  els.push(el)
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const inst = new type(props)
      inst.props = props
      return render(inst.render(), els)
    }
    const prev = fake.enter(type)
    try {
      return render(type(props), els)
    } finally {
      fake.exit(prev)
    }
  }
  if (typeof type === 'string') return render(props.children, els)
  return ''
}

// --------------------------------------------------------------------------
// 载入客户端 bundle
// --------------------------------------------------------------------------
const root = fileURLToPath(new URL('./dsh-onco-lexicon/', import.meta.url))
const src = readFileSync(root + 'lib/client.js', 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (def) => { captured = def } },
}
// 该 bundle 通过 window.__ModuleLoader__.load 注册自己
new Function('window', src)(globalThis.window)
check(captured !== null, 'bundle 未调用 window.__ModuleLoader__.load')
check(captured && captured.id === 'dsh-onco-lexicon', `bundle id 应为 dsh-onco-lexicon，实际 ${captured && captured.id}`)

const fake = makeReact()
const exportsObj = captured.factory((name) => {
  if (name === 'react') return fake.React
  throw new Error('意外 require：' + name)
})

console.log('[1] 模块导出')
check(exportsObj.inject && exportsObj.inject.includes('slots'), 'exports.inject 缺少 slots')
check(exportsObj.inject && exportsObj.inject.includes('layout'), 'exports.inject 缺少 layout')
check(typeof exportsObj.apply === 'function', 'exports.apply 不是函数')
check(exportsObj.__test && typeof exportsObj.__test.Card === 'function', '__test.Card 未导出')

// --------------------------------------------------------------------------
// 渲染 Card：两种形状都不能崩
// --------------------------------------------------------------------------
console.log('[2] Card —— host 的两种返回形状')
const { Card, SearchPanel, Boundary, normalizeHit } = exportsObj.__test

const flatEntry = {
  id: 'ncit:c2926', en: 'Lung Non-Small Cell Carcinoma', zh: '非小细胞肺癌',
  abbr: ['NSCLC'], aliases: ['Non-Small Cell Lung Cancer'], def: '一组肺癌亚型。',
  category: 'disease', codes: { mesh: 'D002289' }, parents: ['Lung Carcinoma'],
  sources: ['NCIt', '自建库'], types: ['Neoplastic Process', 'Disease or Syndrome'],
  source: 'NCIt OBO Edition + 人工整理', score: 1000, via: '精确命中「非小细胞肺癌」',
}
{
  const els = []
  const text = render(fake.React.createElement(Card, { entry: flatEntry, score: 1000, via: flatEntry.via }), els)
  check(text.includes('非小细胞肺癌'), 'Card 未渲染中文名')
  check(text.includes('NSCLC'), 'Card 未渲染缩写')
  check(text.includes('MESH:D002289'), 'Card 未渲染编码')
  check(text.includes('NCIt OBO Edition + 人工整理'), 'Card 未渲染来源（出处）')
  check(text.includes('Neoplastic Process'), 'Card 未显示 NCIt 权威语义类型')

  // 出处标识徽标
  const badgeBox = els.find((e) => e.props && e.props.className === 'onco-badges')
  check(!!badgeBox, 'Card 未渲染出处徽标容器')
  const tags = els.filter((e) => e.props && typeof e.props.className === 'string' && e.props.className.startsWith('onco-tag'))
  const tagText = tags.map((t) => t.props.children)
  console.log('  徽标:', JSON.stringify(tagText))
  check(tagText.includes('NCIt'), '缺少 NCIt 出处徽标')
  check(tagText.includes('自建库'), '缺少 自建库 出处徽标')
  check(tagText.includes('中文'), '缺少 中文 徽标')
  check(tagText.includes('MESH'), '缺少 MESH 编码徽标')
  check(tags.some((t) => String(t.props.className).includes('onco-tag-seed')), '自建库徽标未用强调样式')
}
{
  // 纯 NCIt 条目（无中文、无编码）只应有一个出处徽标，且不该出现「中文」徽标
  const pure = { id: 'ncit:c999', en: 'Some NCIt Term', category: 'concept', sources: ['NCIt'] }
  const els = []
  const text = render(fake.React.createElement(Card, { entry: pure }), els)
  const tags = els.filter((e) => e.props && typeof e.props.className === 'string' && e.props.className.startsWith('onco-tag'))
  const tagText = tags.map((t) => t.props.children)
  console.log('  纯 NCIt 徽标:', JSON.stringify(tagText))
  check(tagText.length === 1 && tagText[0] === 'NCIt', `纯 NCIt 条目徽标应只有 NCIt，实际 ${JSON.stringify(tagText)}`)
  check(text.includes('Some NCIt Term'), '纯 NCIt 条目未渲染')
}
{
  // browse 形状：包了一层 { entry }
  const els = []
  const text = render(fake.React.createElement(Card, { entry: flatEntry }), els)
  check(text.includes('非小细胞肺癌'), 'Card（包装形状）未渲染中文名')
}
{
  const els = []
  const text = render(fake.React.createElement(Card, { entry: undefined }), els)
  check(text === '', 'Card 对缺 entry 应渲染空而不是抛错')
}
{
  const n = normalizeHit(flatEntry)
  check(n.entry === flatEntry && n.score === 1000, 'normalizeHit 未正确处理扁平结构')
  const w = normalizeHit({ entry: flatEntry, score: 5 })
  check(w.entry === flatEntry && w.score === 5, 'normalizeHit 未正确处理包装结构')
}

// --------------------------------------------------------------------------
// 端到端渲染 SearchPanel：stub fetch，走真实交互
// --------------------------------------------------------------------------
console.log('[3] SearchPanel 端到端渲染')
const STATS = {
  ok: true,
  dictLabel: 'NCIt 全量词典（本地构建）',
  total: 185885,
  byCategory: { disease: 26814, drug: 22786 },
  bySource: { NCIt: 185880, 自建库: 106 },
  byType: { 'Neoplastic Process': 15806, 'Pharmacologic Substance': 22823 },
}
const SEARCH = { ok: true, dictLabel: STATS.dictLabel, hits: [flatEntry] }
// 性能统计：字段与 host 侧 rpc('perf') 的返回保持一致，客户端排版依赖这些嵌套层级
const PERF = {
  ok: true,
  dictLabel: STATS.dictLabel,
  loadError: null,
  loadMs: 2611,
  dictBytes: 13526630,
  index: { docs: 185885, keys: 517753, terms: 141471, postings: 1337378, typeCount: 122, childKeys: 4120, ids: 185885 },
  memory: { rss: 861234567, heapUsed: 231234567, heapTotal: 300000000, external: 12345678 },
  process: { uptimeSec: 321, node: 'v22.14.0', platform: 'win32' },
  queries: { count: 28, lastMs: 6.2, avgMs: 7.62, maxMs: 24, p50Ms: 6.1, p95Ms: 19.33, samples: 28 },
}
// 关联推荐：种子 + 上位 / 下位 / 名称近似
const RELATED = {
  ok: true,
  dictLabel: STATS.dictLabel,
  seed: flatEntry,
  parents: [
    { id: 'ncit:c4878', en: 'Lung Carcinoma', zh: '肺癌', category: 'disease' },
    { id: 'ncit:c2991', en: 'Thoracic Neoplasm', category: 'disease' },
  ],
  children: [
    { id: 'ncit:c1', en: 'Lung Adenocarcinoma', zh: '肺腺癌', category: 'disease' },
    { id: 'ncit:c2', en: 'Squamous Cell Lung Carcinoma', category: 'disease' },
  ],
  similar: [
    { id: 'ncit:c3', en: 'Non-Small Cell Lung Cancer', score: 812, shared: ['NSCLC'], category: 'disease' },
    { id: 'ncit:c4', en: 'Small Cell Lung Carcinoma', score: 640, shared: [], category: 'disease' },
  ],
}
// 翻译对照：与 host 返回同构。故意混入一个 missing 术语（With），用来验证
// 「无译名的命中不进对照表、也不在原文里高亮」这条取舍。
const TRANSLATE = {
  ok: true,
  dictLabel: STATS.dictLabel,
  direction: 'en2zh',
  autoDirection: 'en2zh',
  zhRatio: 0,
  truncated: false,
  notes: [
    '本结果为离线词典的逐词对照，不是机器翻译：不做语序调整、语法重组与整句润色。',
    '命中的 3 个术语中有 1 个没有中文名——词典里带中文名的条目只有 106 条（人工整理）。',
  ],
  stats: { chars: 87, spans: 3, distinctTerms: 3, translatedTerms: 2, missingTerms: 1, matchedChars: 48, coverage: 0.5517 },
  primary: flatEntry,
  primaryVia: '精确命中「非小细胞肺癌」',
  terms: [
    { ...flatEntry, key: 'non-small cell lung cancer', surface: 'non-small cell lung cancer', length: 26, count: 1, missing: false },
    { id: 'ncit:c4917', en: 'Cisplatin', zh: '顺铂', category: 'drug', codes: { mesh: 'D002945' },
      types: ['Pharmacologic Substance'], abbr: null, aliases: null, sources: ['NCIt', '自建库'],
      key: 'cisplatin', surface: 'cisplatin', length: 9, count: 2, missing: false },
    { id: 'ncit:c1234', en: 'With', zh: null, category: 'concept', codes: null, types: ['Idea or Concept'],
      abbr: null, aliases: null, sources: ['NCIt'], key: 'with', surface: 'with', length: 4, count: 1, missing: true },
  ],
  segments: [
    { text: 'Patients ', term: null },
    { text: 'with', term: { id: 'ncit:c1234', en: 'With', zh: null, category: 'concept', key: 'with', missing: true } },
    { text: ' advanced ', term: null },
    { text: 'non-small cell lung cancer', term: { id: 'ncit:c2926', en: 'Lung Non-Small Cell Carcinoma', zh: '非小细胞肺癌', category: 'disease', key: 'non-small cell lung cancer', missing: false } },
    { text: ' received ', term: null },
    { text: 'cisplatin', term: { id: 'ncit:c4917', en: 'Cisplatin', zh: '顺铂', category: 'drug', key: 'cisplatin', missing: false } },
    { text: '.', term: null },
  ],
}
const calls = []
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  let body
  if (payload.op === 'stats') body = STATS
  else if (payload.op === 'search') body = SEARCH
  else if (payload.op === 'abbr') body = { ok: true, dictLabel: STATS.dictLabel, hits: [] }
  else if (payload.op === 'perf') body = PERF
  else if (payload.op === 'related') body = RELATED
  else if (payload.op === 'translate') body = TRANSLATE
  else if (payload.op === 'export') body = { ok: true, path: 'C:\\Users\\example\\Downloads\\onco-lexicon-2026-01-01-00-00-00.txt', bytes: Buffer.byteLength(payload.args.text, 'utf8') }
  else body = { ok: true, entries: [flatEntry] }
  return { json: async () => body }
}

/** 渲染若干轮，每轮都让出事件循环，好让 effects 里的异步请求完成 */
async function settle(Comp, passes = 10) {
  let els = []
  let text = ''
  for (let i = 0; i < passes; i++) {
    fake.beginPass()
    els = []
    text = render(fake.React.createElement(Comp, {}), els)
    fake.runEffects()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { text, els }
}

const first = await settle(SearchPanel)
check(first.text.includes('NCIt 全量词典'), '面板未显示词典名')
check(first.text.includes('185885'), '面板未显示词条总数')
check(!first.text.includes('渲染出错'), '面板初始渲染进入错误边界')

// 先在输入框里填词（模拟真实交互），再点「查询」
const input = first.els.find((e) => e.props && e.props.className === 'onco-input' && typeof e.props.onChange === 'function')
check(!!input, '未找到搜索输入框')
if (input) input.props.onChange({ target: { value: '非小细胞肺癌' } })
const typed = await settle(SearchPanel, 3)
// 注意：输入框的 value 是 prop 不是子文本，渲染文本里看不到，要直接查 props.value
const typedInput = typed.els.find((e) => e.props && e.props.className === 'onco-input')
check(typedInput && typedInput.props.value === '非小细胞肺癌', '输入框未回显关键词')

// 注意：激活态的模式按钮 className 也是 "onco-btn on"，不能只按类名找，
// 否则会点到「术语检索」模式按钮而不是「查询」按钮（这正是本测试踩过的坑）。
const btn = typed.els.find(
  (e) => e.props && typeof e.props.onClick === 'function' && (e.props.children === '查询' || e.props.children === '查询中…'),
)
check(!!btn, '未找到查询按钮')
if (btn) {
  try {
    const r = btn.props.onClick()
    if (r && typeof r.then === 'function') r.catch((e) => console.log('  [onClick 异步异常]', e && e.message))
  } catch (e) {
    console.log('  [onClick 同步异常]', e && e.message)
  }
  console.log('  点击后 calls =', JSON.stringify(calls.map((c) => c.op)))
  const after = await settle(SearchPanel)
  console.log('  查询后 calls =', JSON.stringify(calls.map((c) => c.op)))
  console.log('  查询后文本片段:', after.text.replace(/\s+/g, ' ').slice(0, 160))
  check(calls.some((c) => c.op === 'search'), '点击查询未发出 search 请求')
  check(after.text.includes('Lung Non-Small Cell Carcinoma'), '查询结果未渲染词条（形状不匹配会走到这里）')
  check(after.text.includes('NSCLC'), '查询结果未渲染缩写')
  check(!after.text.includes('渲染出错'), '查询结果渲染进入错误边界 —— 形状不匹配回归')
}

// 顺带验证「类别浏览」这条路径（host 返回的是 entries 数组）
if (btn) {
  const browseBtn = typed.els.find((e) => e.props && e.props.className === 'onco-btn' && e.props.children === '类别浏览')
  check(!!browseBtn, '未找到类别浏览按钮')
  if (browseBtn) {
    browseBtn.props.onClick()
    const afterBrowse = await settle(SearchPanel)
    check(calls.some((c) => c.op === 'browse'), '切换到类别浏览未发出 browse 请求')
    check(!afterBrowse.text.includes('渲染出错'), '类别浏览渲染进入错误边界')
  }
}

// --------------------------------------------------------------------------
// 分类 / 出处筛查
// --------------------------------------------------------------------------
console.log('[3c] 分类与出处筛查控件')
{
  // 切回术语检索模式，再操作筛查条。
  // 注意不能按 className==='onco-btn' 找按钮 —— 激活态是 'onco-btn on'，会漏掉，
  // 于是"点了模式切换"其实没点中，后续断言全跟着错。这里只按文案找。
  let view = await settle(SearchPanel, 2)
  const searchBtn = view.els.find(
    (e) => e.props && e.props.children === '术语检索' && typeof e.props.onClick === 'function',
  )
  check(!!searchBtn, '未找到术语检索按钮')
  if (searchBtn) searchBtn.props.onClick()
  view = await settle(SearchPanel, 3)

  const selects = view.els.filter((e) => e.type === 'select')
  console.log(`  筛查下拉框 ${selects.length} 个`)
  check(selects.length === 3, `应有类别 / 出处 / NCIt 类型三个下拉框，实际 ${selects.length}`)

  const catSel = selects[0]
  const srcSel = selects[1]
  const typeSel = selects[2]
  if (catSel && srcSel && typeSel) {
    const catOpts = catSel.props.children.map((o) => o.props.children)
    const srcOpts = srcSel.props.children.map((o) => o.props.children)
    const typeOpts = typeSel.props.children.map((o) => o.props.children)
    console.log('  类别选项:', JSON.stringify(catOpts))
    console.log('  出处选项:', JSON.stringify(srcOpts))
    console.log(`  类型选项 ${typeOpts.length} 项，前 4:`, JSON.stringify(typeOpts.slice(0, 4)))
    check(catOpts[0] === '全部类别', '类别下拉首项应为「全部类别」')
    check(catOpts.length === 8, `类别应有 1+7 项，实际 ${catOpts.length}`)
    check(srcOpts[0] === '全部出处', '出处下拉首项应为「全部出处」')
    check(srcOpts.includes('NCIt 本体') && srcOpts.includes('自建库（人工整理）'),
      '出处下拉缺少 NCIt / 自建库 选项')
    check(typeOpts[0] === '全部 NCIt 类型', '类型下拉首项应为「全部 NCIt 类型」')
    // 语义类型来自 stats.byType（测试里 stub 成 2 种），选项应带上计数
    check(typeOpts.length === 3, `类型下拉应有 1+2 项，实际 ${typeOpts.length}`)
    check(typeOpts.some((t) => String(t).startsWith('Neoplastic Process')),
      '类型下拉缺少 Neoplastic Process')
    check(catSel.props.value === '', '类别默认应为空（全部）')
    check(srcSel.props.value === '', '出处默认应为空（全部）')
    check(typeSel.props.value === '', '类型默认应为空（全部）')

    // 选类别 -> RPC 应带上 category
    calls.length = 0
    catSel.props.onChange({ target: { value: 'drug' } })
    const afterCat = await settle(SearchPanel, 3)
    const catCall = calls.find((c) => c.op === 'search')
    console.log('  选类别后 search 参数:', JSON.stringify(catCall && catCall.args))
    check(!!catCall, '改类别后未发出 search')
    check(catCall && catCall.args.category === 'drug', '类别筛查未随请求发出')

    // 选出处 -> RPC 应带上 source
    const srcSel2 = afterCat.els.filter((e) => e.type === 'select')[1]
    calls.length = 0
    srcSel2.props.onChange({ target: { value: '自建库' } })
    const afterSrc = await settle(SearchPanel, 3)
    const srcCall = calls.find((c) => c.op === 'search')
    console.log('  选出处后 search 参数:', JSON.stringify(srcCall && srcCall.args))
    check(!!srcCall, '改出处后未发出 search')
    check(srcCall && srcCall.args.source === '自建库', '出处筛查未随请求发出')
    check(srcCall && srcCall.args.category === 'drug', '改出处时不应丢掉已选的类别')

    // 选 NCIt 语义类型 -> RPC 应带上 type，且不影响已选条件
    const typeSel2 = afterSrc.els.filter((e) => e.type === 'select')[2]
    check(!!typeSel2, '未找到 NCIt 类型下拉')
    calls.length = 0
    typeSel2.props.onChange({ target: { value: 'Neoplastic Process' } })
    const afterType = await settle(SearchPanel, 3)
    const typeCall = calls.find((c) => c.op === 'search')
    console.log('  选类型后 search 参数:', JSON.stringify(typeCall && typeCall.args))
    check(!!typeCall, '改类型后未发出 search')
    check(typeCall && typeCall.args.type === 'Neoplastic Process', '语义类型筛查未随请求发出')
    check(typeCall && typeCall.args.category === 'drug' && typeCall.args.source === '自建库',
      '改类型时不应丢掉已选的类别 / 出处')

    // 清除筛查
    const clearBtn = afterSrc.els.find((e) => e.props && e.props.children === '清除筛查')
    check(!!clearBtn, '有条件时未出现「清除筛查」按钮')
    if (clearBtn) {
      calls.length = 0
      clearBtn.props.onClick()
      const afterClear = await settle(SearchPanel, 3)
      const clearCall = calls.find((c) => c.op === 'search')
      console.log('  清除后 search 参数:', JSON.stringify(clearCall && clearCall.args))
      check(clearCall && !clearCall.args.category && !clearCall.args.source && !clearCall.args.type,
        '清除后不应再带筛查条件')
      const selNow = afterClear.els.filter((e) => e.type === 'select')
      check(selNow.length === 3 && selNow.every((s) => s.props.value === ''), '清除后三个下拉都应复位')
    }
  }
}

// --------------------------------------------------------------------------
// 0.5.0 四项新功能：性能统计 / 模糊检索 / 关联推荐 / 导出 TXT
// --------------------------------------------------------------------------
console.log('[3d] 性能统计面板')
{
  let view = await settle(SearchPanel, 2)
  const perfBtn = view.els.find(
    (e) => e.props && e.props.children === '性能统计' && typeof e.props.onClick === 'function',
  )
  check(!!perfBtn, '未找到「性能统计」模式按钮')
  if (perfBtn) {
    calls.length = 0
    perfBtn.props.onClick()
    const after = await settle(SearchPanel, 4)
    console.log('  进入性能统计后 calls =', JSON.stringify(calls.map((c) => c.op)))
    check(calls.some((c) => c.op === 'perf'), '切到性能统计未发出 perf 请求')
    check(!after.text.includes('渲染出错'), '性能统计渲染进入错误边界')
    for (const label of [
      '索引 / 词典', '内存 / 进程', '查询耗时（本次会话）',
      '加载耗时', '词典体积', '词条数', '检索键数', '词项数', '倒排项数',
      'NCIt 类型数', '下位索引键数', '常驻内存 RSS', 'p50 / p95', '样本数',
    ]) {
      check(after.text.includes(label), `性能面板缺少「${label}」`)
    }
    // 数字要按人类可读单位格式化，而不是甩出裸字节数
    check(after.text.includes('12.9 MB'), `词典体积未格式化成 MB（应含 12.9 MB）`)
    check(after.text.includes('821.3 MB'), '常驻内存未格式化成 MB')
    check(after.text.includes('2611.00 ms'), '加载耗时未格式化成 ms')
    check(after.text.includes('7.62 ms'), '平均查询耗时未渲染')
    check(!after.text.includes('13526630'), '仍在显示裸字节数')
    // 性能统计模式下筛查条与导出按钮都不该出现
    check(after.els.filter((e) => e.type === 'select').length === 0, '性能统计模式不应出现筛查下拉框')
    check(!after.text.includes('导出 TXT'), '性能统计模式不应出现导出按钮')
    // 回到术语检索，给后面的用例准备结果集
    const back = after.els.find((e) => e.props && e.props.children === '术语检索' && typeof e.props.onClick === 'function')
    check(!!back, '未找到「术语检索」按钮')
    if (back) back.props.onClick()
    view = await settle(SearchPanel, 3)
  }
}

console.log('[3e] 模糊检索开关')
{
  // 先真正查一次，拿到结果（导出用例也要用）
  let view = await settle(SearchPanel, 2)
  const input = view.els.find((e) => e.props && e.props.className === 'onco-input')
  check(!!input, '未找到搜索输入框（模糊检索用例）')
  if (input) input.props.onChange({ target: { value: '非小细胞肺癌' } })
  view = await settle(SearchPanel, 2)
  const go = view.els.find((e) => e.props && typeof e.props.onClick === 'function' && e.props.children === '查询')
  check(!!go, '未找到查询按钮（模糊检索用例）')
  if (go) go.props.onClick()
  view = await settle(SearchPanel, 4)

  const fuzzyBtn = () => view.els.find((e) => e.props && e.props.children === '模糊检索' && typeof e.props.onClick === 'function')
  check(!!fuzzyBtn(), '未找到「模糊检索」开关')
  check(fuzzyBtn() && fuzzyBtn().props.className === 'onco-btn', '模糊检索默认不应是开启态')
  calls.length = 0
  if (fuzzyBtn()) fuzzyBtn().props.onClick()
  const on = await settle(SearchPanel, 4)
  const onCall = calls.find((c) => c.op === 'search')
  console.log('  开启模糊检索后 search 参数:', JSON.stringify(onCall && onCall.args))
  check(!!onCall, '开启模糊检索后未重新发起 search')
  check(onCall && onCall.args.fuzzy === true, '模糊检索开关未随请求发出')
  const fuzzyOn = on.els.find((e) => e.props && e.props.children === '模糊检索')
  check(fuzzyOn && fuzzyOn.props.className === 'onco-btn on', '开启后模糊检索按钮未变为激活态')

  calls.length = 0
  if (fuzzyOn) fuzzyOn.props.onClick()
  const off = await settle(SearchPanel, 4)
  const offCall = calls.find((c) => c.op === 'search')
  console.log('  关闭模糊检索后 search 参数:', JSON.stringify(offCall && offCall.args))
  check(!!offCall, '关闭模糊检索后未重新发起 search')
  check(offCall && offCall.args.fuzzy === undefined, '关闭模糊检索后仍带 fuzzy 参数')
  const fuzzyOff = off.els.find((e) => e.props && e.props.children === '模糊检索')
  check(fuzzyOff && fuzzyOff.props.className === 'onco-btn', '关闭后模糊检索按钮未回到普通态')
}

console.log('[3f] 关联推荐')
{
  let view = await settle(SearchPanel, 2)
  const relBtn = view.els.find((e) => e.props && e.props.className === 'onco-rel-btn')
  check(!!relBtn, '词条卡片上未找到「关联」按钮')
  check(relBtn && relBtn.props.children === '关联', '关联按钮文案应为「关联」')
  if (relBtn) {
    calls.length = 0
    relBtn.props.onClick()
    const after = await settle(SearchPanel, 4)
    const relCall = calls.find((c) => c.op === 'related')
    console.log('  关联请求参数:', JSON.stringify(relCall && relCall.args))
    check(!!relCall, '点击关联未发出 related 请求')
    check(relCall && relCall.args.id === 'ncit:c2926', '关联请求未带上词条 id')
    check(!after.text.includes('渲染出错'), '关联推荐渲染进入错误边界')
    check(after.text.includes('关联推荐：'), '未渲染关联推荐标题')
    check(after.text.includes('非小细胞肺癌'), '关联推荐未显示种子词条')
    // 三组都要有，且带条数
    check(after.text.includes('上位概念（2）'), '未渲染上位概念分组（含条数）')
    check(after.text.includes('下位概念（2）'), '未渲染下位概念分组（含条数）')
    check(after.text.includes('名称近似（2）'), '未渲染名称近似分组（含条数）')
    check(after.text.includes('相似度 812'), '名称近似未显示相似度')
    check(after.text.includes('关闭关联'), '未渲染关闭关联按钮')
    const items = after.els.filter((e) => e.props && e.props.className === 'onco-rel-item')
    check(items.length === 6, `关联项应有 2+2+2=6 个，实际 ${items.length}`)
    check(after.text.includes('肺癌'), '关联项未渲染中文名')

    // 点关联项应以该项为中心继续外扩
    if (items.length) {
      calls.length = 0
      items[0].props.onClick()
      const deeper = await settle(SearchPanel, 4)
      const deepCall = calls.find((c) => c.op === 'related')
      console.log('  二级关联参数:', JSON.stringify(deepCall && deepCall.args))
      check(!!deepCall, '点击关联项未发出 related 请求')
      check(deepCall && deepCall.args.id === 'ncit:c4878', '二级关联未以被点词条为中心')
      check(deeper.text.includes('关联推荐：'), '二级关联后关联视图消失')
    }

    // 关闭关联视图：结果列表应保留
    const closeBtn = after.els.find((e) => e.props && e.props.children === '关闭关联')
    check(!!closeBtn, '未找到关闭关联按钮（用于点击）')
    if (closeBtn) {
      closeBtn.props.onClick()
      const closed = await settle(SearchPanel, 3)
      check(!closed.text.includes('关联推荐：'), '关闭后关联视图仍在')
      check(closed.text.includes('Lung Non-Small Cell Carcinoma'), '关闭关联不应清掉检索结果')
    }
  }
}

console.log('[3g] 导出 TXT')
{
  let view = await settle(SearchPanel, 2)
  const expBtn = view.els.find((e) => e.props && e.props.children === '导出 TXT')
  check(!!expBtn, '未找到「导出 TXT」按钮')
  check(expBtn && expBtn.props.disabled === false, '有结果时导出按钮不应被禁用')
  if (expBtn) {
    calls.length = 0
    expBtn.props.onClick()
    const after = await settle(SearchPanel, 4)
    const expCall = calls.find((c) => c.op === 'export')
    check(!!expCall, '点击导出未发出 export 请求')
    if (expCall) {
      const text = expCall.args.text
      console.log('  导出文本前 3 行:', JSON.stringify(text.split('\r\n').slice(0, 3)))
      check(/^onco-lexicon-.*\.txt$/.test(expCall.args.name), `导出文件名不规范：${expCall.args.name}`)
      check(text.includes('\r\n'), '导出文本未使用 CRLF（Windows 记事本会吃掉换行）')
      check(!/(?<!\r)\n/.test(text), '导出文本里混入了裸 LF 换行')
      for (const s of [
        '# 肿瘤学术语词典 导出', '# 词典：NCIt 全量词典（本地构建）', '# 模式：search',
        '1. 非小细胞肺癌（Lung Non-Small Cell Carcinoma）', '相关度：1000',
        '类别：疾病', 'NCIt 类型：Neoplastic Process；Disease or Syndrome',
        '缩写：NSCLC', '编码：MESH:D002289', '出处：NCIt + 自建库', 'ID：ncit:c2926',
        '不构成诊疗建议',
      ]) {
        check(text.includes(s), `导出文本缺少「${s}」`)
      }
    }
    check(!after.text.includes('渲染出错'), '导出后渲染进入错误边界')
    check(after.text.includes('已导出 1 条到'), `未显示导出结果提示，实际文本片段：${after.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    console.log('  导出提示:', (after.text.match(/已导出[^\r\n]{0,60}/) || [''])[0])
  }

  // 没有结果时导出按钮应禁用
  const abbrBtn = view.els.find((e) => e.props && e.props.children === '缩写消歧' && typeof e.props.onClick === 'function')
  check(!!abbrBtn, '未找到「缩写消歧」按钮')
  if (abbrBtn) {
    abbrBtn.props.onClick()
    const empty = await settle(SearchPanel, 3)
    const exp2 = empty.els.find((e) => e.props && e.props.children === '导出 TXT')
    check(!!exp2, '空结果时导出按钮消失（应保留但禁用）')
    check(exp2 && exp2.props.disabled === true, '无结果时导出按钮应被禁用')
  }
}

console.log('[3h] 翻译模式（词典式对照）')
{
  let view = await settle(SearchPanel, 2)
  const modeBtn = (els, label) =>
    els.find((e) => e.props && e.props.children === label && typeof e.props.onClick === 'function')
  // 模式栏应有 5 个模式
  const modeLabels = view.els
    .filter((e) => e.props && typeof e.props.onClick === 'function' &&
      ['术语检索', '翻译', '缩写消歧', '类别浏览', '性能统计'].includes(String(e.props.children)))
    .map((e) => e.props.children)
  console.log('  模式栏:', JSON.stringify(modeLabels))
  check(modeLabels.length === 5, `模式栏应有 5 个模式，实际 ${modeLabels.length}`)
  check(modeLabels.includes('翻译'), '模式栏缺少「翻译」')

  const trBtn = modeBtn(view.els, '翻译')
  check(!!trBtn, '未找到「翻译」模式按钮')
  if (trBtn) {
    trBtn.props.onClick()
    view = await settle(SearchPanel, 3)

    // 多行输入 + 方向下拉；翻译模式不该有筛查条
    const ta = view.els.find((e) => e.type === 'textarea')
    check(!!ta, '翻译模式未渲染多行输入框')
    check(ta && ta.props.rows >= 3, '原文输入框太扁')
    check(ta && String(ta.props.placeholder).includes('不是机器翻译'), '输入框未提示这不是机器翻译')
    const selects = view.els.filter((e) => e.type === 'select')
    console.log(`  翻译模式下拉框 ${selects.length} 个`)
    check(selects.length === 1, `翻译模式应只有「方向」一个下拉框，实际 ${selects.length}`)
    const dirSel = selects[0]
    if (dirSel) {
      const dirOpts = dirSel.props.children.map((o) => o.props.children)
      check(dirOpts.length === 3, `方向应有 3 个选项，实际 ${dirOpts.length}`)
      check(dirOpts.includes('中 → 英') && dirOpts.includes('英 → 中'), '方向选项缺少中英两个方向')
      check(dirSel.props.value === 'auto', '方向默认应为 auto')
    }
    check(!!modeBtn(view.els, '翻译对照'), '未找到「翻译对照」按钮')
    check(!view.els.some((e) => e.props && e.props.children === '模糊检索'), '翻译模式不该出现「模糊检索」')
    const exp0 = view.els.find((e) => e.props && e.props.children === '导出 TXT')
    check(exp0 && exp0.props.disabled === true, '没有对照结果时导出按钮应禁用')
    check(view.text.includes('粘贴术语或整段文本'), '未渲染翻译模式的空状态提示')
    check(!view.text.includes('渲染出错'), '翻译模式渲染进入错误边界')

    // 填入原文
    const TEXT = 'Patients with advanced non-small cell lung cancer received cisplatin.'
    if (ta) ta.props.onChange({ target: { value: TEXT } })
    view = await settle(SearchPanel, 2)
    const ta2 = view.els.find((e) => e.type === 'textarea')
    check(ta2 && ta2.props.value === TEXT, '输入框未回显原文')

    // 点「翻译对照」
    calls.length = 0
    const runBtn = modeBtn(view.els, '翻译对照')
    check(!!runBtn, '未找到「翻译对照」按钮（用于点击）')
    if (runBtn) {
      runBtn.props.onClick()
      const after = await settle(SearchPanel, 4)
      const trCall = calls.find((c) => c.op === 'translate')
      console.log('  对照请求参数:', JSON.stringify(trCall && trCall.args))
      check(!!trCall, '点击翻译对照未发出 translate 请求')
      check(trCall && trCall.args.text === TEXT, '未把原文发给 host')
      check(trCall && trCall.args.direction === 'auto', '默认方向应为 auto')
      check(!after.text.includes('渲染出错'), '翻译结果渲染进入错误边界')

      // 概览
      check(after.text.includes('方向 英→中（自动判定）'), '未渲染方向概览')
      check(after.text.includes('命中术语 3 个（可对照 2）'), '未渲染命中统计')
      check(after.text.includes('覆盖原文字符 55.2%'), '未渲染覆盖率')
      // 说明段落：必须声明这不是机器翻译
      const notes = after.els.filter((e) => e.props && e.props.className === 'onco-note')
      check(notes.length === 2, `说明条目应为 2 条，实际 ${notes.length}`)
      check(notes.some((n) => String(n.props.children).includes('不是机器翻译')), '缺少「不是机器翻译」说明')
      // 最相近词条：复用 Card
      check(after.text.includes('最相近词条'), '未渲染最相近词条')
      // 术语对照：只列可对照的 2 个
      check(after.text.includes('术语对照（2）'), '未渲染术语对照标题（应为 2）')
      const rows = after.els.filter((e) => e.props && e.props.className === 'onco-tr-row')
      check(rows.length === 2, `术语对照行应为 2 行（无译名的不进表），实际 ${rows.length}`)
      check(after.text.includes('非小细胞肺癌'), '对照表未给出中文名')
      check(after.text.includes('顺铂'), '对照表未给出顺铂的中文名')
      // 原文标注：只有可对照的 2 处高亮，missing 的 with 保持纯文本
      const hits = after.els.filter((e) => e.props && e.props.className === 'onco-tr-hit')
      console.log('  原文标注高亮:', JSON.stringify(hits.map((x) => x.props.children)))
      check(hits.length === 2, `原文高亮处应为 2（missing 不高亮），实际 ${hits.length}`)
      check(hits.every((x) => x.props.children !== 'with'), '无译名的 with 不该被高亮')
      check(hits.some((x) => x.props.children === 'cisplatin'), 'cisplatin 未被高亮')
      check(hits.every((x) => typeof x.props.title === 'string' && x.props.title.includes('→')),
        '高亮片段缺少「原文 → 对照名」的悬停提示')
      const annot = after.els.find((e) => e.props && e.props.className === 'onco-tr-annot')
      check(!!annot, '未渲染原文标注区')
      // 无译名命中收在可展开的清单里
      const expand = after.els.find((e) => e.props && String(e.props.children).includes('个无译名命中'))
      check(!!expand, '未提供「无译名命中」的展开入口')
      check(String(expand && expand.props.children).includes('展开 1'), '展开按钮文案不对')

      // 展开后应多出 1 行
      if (expand) {
        expand.props.onClick()
        const opened = await settle(SearchPanel, 3)
        const rows2 = opened.els.filter((e) => e.props && e.props.className === 'onco-tr-row')
        check(rows2.length === 3, `展开后对照行应为 3，实际 ${rows2.length}`)
        check(!!opened.els.find((e) => e.props && e.props.className === 'onco-tr-missing'), '未渲染无译名清单')
        check(String(opened.els.find((e) => e.props && String(e.props.children).includes('个无译名命中')).props.children).includes('收起'),
          '展开后按钮未变为「收起」')
        // 收回去，别影响后面的断言
        opened.els.find((e) => e.props && String(e.props.children).includes('个无译名命中')).props.onClick()
        await settle(SearchPanel, 2)
      }

      // 手动换方向应重新对照
      const dir2 = (await settle(SearchPanel, 2)).els.filter((e) => e.type === 'select')[0]
      check(!!dir2, '未找到方向下拉框（用于切换）')
      if (dir2) {
        calls.length = 0
        dir2.props.onChange({ target: { value: 'zh2en' } })
        const re = await settle(SearchPanel, 4)
        const reCall = calls.find((c) => c.op === 'translate')
        console.log('  换方向后参数:', JSON.stringify(reCall && reCall.args))
        check(!!reCall, '换方向后未重新对照')
        check(reCall && reCall.args.direction === 'zh2en', '换方向后未把新方向发给 host')
        check(!re.text.includes('渲染出错'), '换方向后渲染出错')
      }

      // 对照表里的「关联」按钮
      const relBtn = (await settle(SearchPanel, 2)).els.find(
        (e) => e.props && e.props.className === 'onco-rel-btn' && typeof e.props.onClick === 'function',
      )
      check(!!relBtn, '对照表行内未提供「关联」入口')
      if (relBtn) {
        calls.length = 0
        relBtn.props.onClick()
        const rel = await settle(SearchPanel, 4)
        check(calls.some((c) => c.op === 'related'), '对照表里的关联按钮未发出 related 请求')
        check(rel.text.includes('关联推荐：'), '关联视图未渲染')
      }

      // 导出对照结果
      const expBtn = (await settle(SearchPanel, 2)).els.find((e) => e.props && e.props.children === '导出 TXT')
      check(expBtn && expBtn.props.disabled === false, '有对照结果时导出按钮应可用')
      if (expBtn) {
        calls.length = 0
        expBtn.props.onClick()
        const ex = await settle(SearchPanel, 4)
        const expCall = calls.find((c) => c.op === 'export')
        check(!!expCall, '导出未发出 export 请求')
        if (expCall) {
          const body = expCall.args.text
          check(/^onco-lexicon-translate-.*\.txt$/.test(expCall.args.name), `对照导出的文件名不对：${expCall.args.name}`)
          check(body.includes('# 肿瘤学术语词典 翻译对照导出'), '导出文件缺少标题')
          check(body.includes('不是机器翻译'), '导出文件未声明这不是机器翻译')
          check(body.includes('术语对照（2）'), '导出文件未分「可对照」与「无译名」两组')
          check(body.includes('cisplatin → 顺铂'), `导出内容缺少对照行，实际片段：${body.slice(0, 120)}`)
          check(body.includes('non-small cell lung cancer → 非小细胞肺癌'), '导出内容缺少长术语对照行')
          check(body.includes('[[非小细胞肺癌]]'), '导出文件未在原文中标注对照名')
          check(!body.includes('[[（词典未收录'), '无译名的命中不该被标成对照名')
          check(body.includes('\r\n'), '导出文件未使用 CRLF')
          check(body.includes('不构成诊疗建议'), '导出文件缺少免责声明')
        }
        check(ex.text.includes('已导出 3 个术语对照到'), `未显示导出提示：${ex.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
  }
}

// 侧边栏图标：点击应切到本栏目
console.log('[4] 侧边栏图标')
let selected = null
const ctxCapture = { layout: { selectPanel: (k) => { selected = k } }, effect: (fn) => fn() }
const slots = []
const mockCtx = {
  effect: (fn) => fn(),
  slots: { inject: (name, fn) => { slots.push(name); return fn() }, register: (meta, comp) => ({ meta, comp }) },
  layout: ctxCapture.layout,
  logger: { info: () => {} },
}
let registered = []
mockCtx.slots.register = (meta, comp) => { registered.push({ meta, comp }); return { meta, comp } }
exportsObj.apply(mockCtx)
check(registered.length === 2, `应注册 2 个 slot，实际 ${registered.length}`)
check(registered.some((r) => r.meta.name === 'main' && r.meta.key === 'onco-lexicon'), '未注册 main 栏目')
check(registered.some((r) => r.meta.name === 'sidebar.panellist' && r.meta.label === '术语词典'), '未注册侧边栏入口')

const icon = registered.find((r) => r.meta.name === 'sidebar.panellist')
if (icon) {
  const els = []
  render(fake.React.createElement(icon.comp, {}), els)
  const b = els.find((e) => e.props && typeof e.props.onClick === 'function')
  check(!!b, '侧边栏图标没有 onClick')
  if (b) {
    b.props.onClick()
    check(selected === 'onco-lexicon', `点击图标未切换到 onco-lexicon，实际 ${selected}`)
  }
  // 图标应渲染成图片，而不是退回文字占位
  const img = els.find((e) => e.type === 'img')
  check(!!img, '侧边栏图标未渲染 <img>（图标来源全为空）')
  if (img) {
    check(/^data:image\/png;base64,iVBOR/.test(img.props.src), '图标首选来源应是内嵌 PNG data URI')
    check(img.props.alt === '术语词典', '图标缺少 alt')
    check(img.props.draggable === false, '图标应禁用拖拽')
    check(typeof img.props.onError === 'function', '图标缺少 onError 回退')
  }
  const badge = els.find((e) => e.props && e.props.className === 'onco-icon-badge')
  check(!!badge, '图标缺少外层容器（白底与边框放在外层）')

  // 回退链：data URI 加载失败 -> 静态路由 -> 文字
  console.log('[4b] 图标来源回退链')
  if (img && typeof img.props.onError === 'function') {
    img.props.onError()
    const second = await settle(icon.comp, 3)
    const img2 = second.els.find((e) => e.type === 'img')
    console.log('  第一级失败后 src =', img2 && img2.props.src)
    check(!!img2, 'data URI 失败后未回退到第二来源（应为静态路由）')
    check(img2 && img2.props.src === '/dsh-onco-lexicon/icon.png',
      `第二来源应为 /dsh-onco-lexicon/icon.png，实际 ${img2 && img2.props.src}`)
    if (img2 && typeof img2.props.onError === 'function') {
      img2.props.onError()
      const third = await settle(icon.comp, 3)
      const img3 = third.els.find((e) => e.type === 'img')
      console.log('  第二级失败后是否还有 img =', !!img3, ' 文字回退 =', third.text.includes('词典'))
      check(!img3, '两个来源都失败后不应再渲染 <img>（会显示裂图）')
      check(third.text.includes('词典'), '两个来源都失败后应回退成文字')
    }
  }
}

// --------------------------------------------------------------------------
// CSS 配色
// --------------------------------------------------------------------------
console.log('[5] CSS 配色')
// DSH 主题变量的前缀是 --dsw-alias-*，下面这些 --dsh-* 名字**并不存在**；
// 用了就会静默落到 fallback（早先正是这样把浅色主题下的文字写成近白色）。
const bogus = ['--dsh-text', '--dsh-border', '--dsh-accent', '--dsh-card-bg', '--dsh-input-bg', '--dsh-btn-bg', '--dsh-btn-hover']
for (const b of bogus) check(!src.includes(b), `仍在使用不存在的变量 ${b}`)
check(src.includes('--dsw-alias-'), '未使用 DSH 真实主题变量 --dsw-alias-*')
for (const hex of ['#4c1d95', '#5b21b6', '#6d28d9', '#7c3aed']) {
  check(src.includes(hex), `缺少紫色 ${hex}`)
}
check(/@media \(prefers-color-scheme: dark\)/.test(src), '缺少深色主题适配')
// 图标：尺寸、圆形裁切、深色反相
check(/\.onco-icon-badge\{[^}]*border-radius:50%/.test(src), '图标未做圆形裁切')
check(/\.onco-icon-img\{[^}]*object-fit:cover/.test(src), '图标未设置 object-fit')
// 深色主题下**不应**对图片做反相：源图是浅灰线稿+白底，反相后是浅灰线+黑底，
// 在深色侧边栏上会糊成一片，看起来就像图标没加载。
check(!/filter:invert\(1\)/.test(src), '图标仍在对图片做反相（深色主题下会看不清）')
check(/\.onco-icon-badge\{[^}]*background:#fff/.test(src), '图标外层缺少白底')
// 双来源 + 回退
check(/const ICON_URL = '\/dsh-onco-lexicon\/icon\.png'/.test(src), '缺少图标回退 URL')
check(/ICON_SOURCES/.test(src), '缺少图标来源列表')
check(/onError: \(\) => setIdx/.test(src), '缺少图标加载失败的回退处理')
// 图标 base64 不能把 data URI 写空（脚本注入失败的典型表现）
const iconUri = /const ICON_DATA_URI = '([^']*)'/.exec(src)
check(!!iconUri, '未找到 ICON_DATA_URI 常量')
check(!!iconUri && iconUri[1].length > 1000, `ICON_DATA_URI 过短（${iconUri ? iconUri[1].length : 0}），可能未注入 base64`)
// 新增功能（性能统计 / 关联推荐 / 导出提示）的样式必须真的存在，
// 否则类名挂上去了却没有规则，界面会退化成无边框、挤成一坨的裸文本。
for (const sel of ['.onco-notice{', '.onco-rel-btn{', '.onco-related{', '.onco-rel-head{',
  '.onco-rel-group{', '.onco-rel-title{', '.onco-rel-items{', '.onco-rel-item{', '.onco-rel-empty{',
  '.onco-perf-group{', '.onco-perf-title{', '.onco-perf-row{', '.onco-perf-k{', '.onco-perf-v{',
  '.onco-perf-hint{', '.onco-ta{', '.onco-tr{', '.onco-tr-row{', '.onco-tr-src{', '.onco-tr-dst{',
  '.onco-tr-ghead{', '.onco-tr-annot{', '.onco-tr-hit{', '.onco-tr-missing{', '.onco-tr-none{',
  '.onco-note{', '.onco-hint{']) {
  check(src.includes(sel), `缺少新功能样式 ${sel}`)
}
// 次级文字必须用显式深紫，不能再靠 opacity 淡化（"颜色太浅"的根因）
for (const sel of ['.onco-meta{', '.onco-k{', '.onco-score{', '.onco-def{', '.onco-empty{', '.onco-row{',
  '.onco-rel-title{', '.onco-rel-item{', '.onco-perf-k{', '.onco-perf-hint{',
  '.onco-note{', '.onco-tr-meta{', '.onco-hint{']) {
  const i = src.indexOf(sel)
  check(i >= 0, `未找到样式 ${sel}`)
  if (i >= 0) {
    const block = src.slice(i, src.indexOf('}', i))
    check(!block.includes('opacity'), `${sel} 仍靠 opacity 淡化文字`)
  }
}

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
