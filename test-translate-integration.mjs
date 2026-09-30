/**
 * dsh-onco-lexicon —— 翻译功能的「真实 payload × 客户端组件」集成测试。
 *
 * 为什么单独写一个：本插件 0.2.1 的故障正是**两半对数据形状的约定不一致**——
 * host 返回扁平对象、客户端按 hit.entry 取值，一路漏到界面上才暴露。
 * 之后 host 侧测试用真实词典、client 侧测试用 stub，两边各自都对，
 * 但**没人验过「host 真实返回的翻译结果能否被客户端组件渲染」**。
 * 这个文件就补这一环：真词典 → 真 RPC → 真 payload → 真组件渲染。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply } from './dsh-onco-lexicon/lib/index.js'

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}

// ---------------------------------------------------------------------------
// 极简 React 替身：TranslateResult 用到 useState，Card 是纯函数组件
// ---------------------------------------------------------------------------
function makeReact() {
  const store = new Map()
  let current = null
  function createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, { children: kids }) }
  }
  function useState(init) {
    if (!current) throw new Error('useState 在组件之外被调用')
    const s = current
    const i = s.cursor++
    if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init
    return [s.hooks[i], (v) => { s.hooks[i] = typeof v === 'function' ? v(s.hooks[i]) : v }]
  }
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(o) { this.state = Object.assign({}, this.state, o) }
  }
  Component.prototype.isReactComponent = true
  return {
    React: { createElement, useState, Component },
    enter(Comp) {
      const prev = current
      let s = store.get(Comp)
      if (!s) { s = { hooks: [], cursor: 0 }; store.set(Comp, s) }
      current = s
      current.cursor = 0
      return prev
    },
    exit(prev) { current = prev },
  }
}

const fake = makeReact()
function render(el, els) {
  if (el === null || el === undefined || el === false || el === true) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map((c) => render(c, els)).join('')
  if (typeof el !== 'object') return ''
  const { type, props } = el
  els.push(el)
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) return render(new type(props).render(), els)
    const prev = fake.enter(type)
    try { return render(type(props), els) } finally { fake.exit(prev) }
  }
  if (typeof type === 'string') return render(props.children, els)
  return ''
}

// ---------------------------------------------------------------------------
// 客户端 bundle
// ---------------------------------------------------------------------------
const root = fileURLToPath(new URL('./dsh-onco-lexicon/', import.meta.url))
const src = readFileSync(root + 'lib/client.js', 'utf8')
let captured = null
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
new Function('window', src)(globalThis.window)
const client = captured.factory((n) => {
  if (n === 'react') return fake.React
  throw new Error('意外 require：' + n)
})
const { TranslateResult, translationToText } = client.__test
check(typeof TranslateResult === 'function', '客户端未导出 TranslateResult')
check(typeof translationToText === 'function', '客户端未导出 translationToText')

// ---------------------------------------------------------------------------
// host 半：真词典 + 真 RPC
// ---------------------------------------------------------------------------
console.log('[1] 启动 host 半（加载真实词典）')
const routes = []
const tools = []
const mockCtx = {
  logger: { info: () => {} },
  tools: { register: (t) => tools.push(t) },
  systemPrompt: { section: () => {} },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get: () => undefined,
  effect: (fn) => fn(),
}
apply(mockCtx, {})
const route = routes.find((r) => r.path === '/dsh-onco-lexicon/rpc')
check(!!route, 'RPC 路由未注册')

function call(payload) {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = { method: 'POST', setEncoding() {}, destroy() {}, on(ev, cb) { handlers[ev] = cb; return this } }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
      end(body) { resolve(JSON.parse(body)) },
    }
    route.handler(req, res).catch(reject)
    handlers.data(JSON.stringify(payload))
    handlers.end()
  })
}

// ---------------------------------------------------------------------------
// 集成：真实 payload 必须能被真实组件渲染出来
// ---------------------------------------------------------------------------
const CASES = [
  { label: '中文句子', text: '非小细胞肺癌患者接受顺铂治疗' },
  { label: '英文句子', text: 'Patients with advanced non-small cell lung cancer received cisplatin and pembrolizumab.' },
  { label: '缩写', text: 'NSCLC' },
]

for (const c of CASES) {
  console.log(`[2] 集成：${c.label}`)
  const tr = await call({ op: 'translate', args: { text: c.text } })
  check(tr.ok === true, `${c.label}: RPC 失败 ${tr.error}`)

  // 形状契约：客户端读的每个字段都必须真的存在
  for (const f of ['direction', 'autoDirection', 'notes', 'stats', 'terms', 'segments']) {
    check(tr[f] !== undefined, `${c.label}: payload 缺少字段 ${f}`)
  }
  for (const f of ['spans', 'distinctTerms', 'translatedTerms', 'missingTerms', 'coverage']) {
    check(typeof tr.stats[f] === 'number', `${c.label}: stats.${f} 不是数字`)
  }
  for (const t of tr.terms) {
    for (const f of ['id', 'en', 'category', 'key', 'surface', 'count', 'missing']) {
      check(t[f] !== undefined, `${c.label}: 术语缺少字段 ${f}（客户端会读到 undefined）`)
    }
  }

  const els = []
  let text = ''
  try {
    text = render(fake.React.createElement(TranslateResult, { data: tr }), els)
  } catch (e) {
    check(false, `${c.label}: 渲染真实 payload 抛错：${e && e.message}`)
    continue
  }
  check(!text.includes('渲染出错'), `${c.label}: 渲染进入错误边界`)

  const translated = tr.terms.filter((t) => !t.missing)
  const rows = els.filter((e) => e.props && e.props.className === 'onco-tr-row')
  check(rows.length === translated.length,
    `${c.label}: 对照行数 ${rows.length} 与可对照术语数 ${translated.length} 不一致`)
  const hits = els.filter((e) => e.props && e.props.className === 'onco-tr-hit')
  check(hits.length === tr.stats.translatedTerms,
    `${c.label}: 原文高亮 ${hits.length} 处，应为可对照命中数 ${tr.stats.translatedTerms}`)
  // 每个可对照术语的译名都必须真的渲染出来
  const target = (t) => (tr.direction === 'zh2en' ? t.en : t.zh)
  for (const t of translated) {
    check(text.includes(target(t)), `${c.label}: 译名 ${target(t)} 未出现在渲染结果中`)
  }
  // 无译名的命中不得被当成对照名渲染
  for (const t of tr.terms.filter((x) => x.missing)) {
    check(!hits.some((hh) => hh.props.children === t.surface), `${c.label}: 无译名的 ${t.surface} 被高亮了`)
  }
  console.log(`  方向 ${tr.direction} | 术语 ${tr.stats.distinctTerms}（可对照 ${tr.stats.translatedTerms}）| 高亮 ${hits.length} | 对照行 ${rows.length}`)

  // 导出：真实 payload 也要能拼出文本
  const body = translationToText(tr, 'NCIt 全量词典（本地构建）')
  check(body.includes('翻译对照导出'), `${c.label}: 导出缺少标题`)
  check(body.includes(`术语对照（${translated.length}）`), `${c.label}: 导出分组的条数不对`)
  for (const t of translated) {
    check(body.includes(`${t.surface} → ${target(t)}`), `${c.label}: 导出缺少对照行 ${t.surface}`)
  }
  check(body.includes('\r\n'), `${c.label}: 导出未用 CRLF`)
  check(body.includes('不是机器翻译'), `${c.label}: 导出未声明不是机器翻译`)
  // 分段必须能无损拼回原文
  check(tr.segments.map((s) => s.text).join('') === c.text,
    `${c.label}: 分段拼接与原文不一致`)
}

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
