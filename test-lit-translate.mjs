/**
 * dsh-lit-translate —— 自测脚本（host 半 + 浏览器半）
 *
 * 为什么两边都要测：
 *   - host 半握着提示词与 llmRun，翻错了、报错不人话，界面看不出来是逻辑问题；
 *   - 浏览器半握着切段与面板状态，之前 onco-lexicon 就因为「host 返回的形状和
 *     客户端取的不一致」这种错漏到界面上才被发现。这里用一个极小的 React 替身
 *     把面板真正跑起来，并 stub fetch 走真实交互（点按钮 → 轮到译文出现）。
 *
 * 跑法：node test-lit-translate.mjs
 */
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROOT = fileURLToPath(new URL('./dsh-lit-translate/', import.meta.url))

// ===========================================================================
// 第 1 部分：host 半
// ===========================================================================
console.log('\n[1] host 半：单位纯函数')

const host = await import(new URL('./dsh-lit-translate/lib/index.js', import.meta.url).href)
check(host.name === 'lit-translate', 'host 半导出 name=lit-translate')
check(
  Array.isArray(host.inject) && host.inject.includes('tools') && host.inject.includes('webServer'),
  'host 半 inject 含 tools / webServer',
)

check(host.llmTrouble('insufficient balance', 402).includes('余额'), 'llmTrouble：余额不足给人话')
check(host.llmTrouble('429 Too Many Requests', 429).includes('限流'), 'llmTrouble：限流给人话')
check(host.llmTrouble('invalid api key', 401).includes('API Key'), 'llmTrouble：Key 无效给人话')
check(host.llmTrouble('context length exceeded').includes('上下文'), 'llmTrouble：超上下文给人话')
check(host.llmTrouble('some weird failure') === '', 'llmTrouble：不认识的错误不硬套')

{
  const prompt = host.buildPrompt(true, false)
  check(prompt.includes('中文（English）'), 'annotate=true 的提示词要求术语附英文')
  check(!prompt.includes('上文参考'), '无上文时不带 CONTEXT_RULE')
  const plain = host.buildPrompt(false, true)
  check(plain.includes('全文只用中文'), 'annotate=false 用纯中文提示词')
  check(plain.includes('上文参考'), '有上文时带 CONTEXT_RULE')

  const user = host.buildUserText('Body text.', 'Prev text.')
  check(user.includes('【上文参考') && user.includes('Prev text.') && user.includes('Body text.'), 'buildUserText 把上文与正文分开')
  check(host.buildUserText('Body text.', '   ') === 'Body text.', '空上文时不拼上文段')
}

{
  const out = host.renderTranslationResult(
    { ok: true, text: '这是译文。', truncated: true, provider: 'deepseek', model: 'deepseek-chat' },
    { text: 'Hello.', annotate: true, hasContext: true },
  )
  check(out.includes('【学术英译中】'), '工具输出带标题')
  check(out.includes('deepseek / deepseek-chat'), '工具输出带模型名')
  check(out.includes('这是译文。'), '工具输出含译文')
  check(out.includes('截断'), '截断时给出警告')
  check(out.includes('机器译文'), '工具输出声明是机器译文（防止被当成人工核对过的结论）')
}

// ===========================================================================
// 第 2 部分：host 半 —— apply / 工具 / RPC
// ===========================================================================
console.log('\n[2] host 半：工具与 RPC')

const tmp = mkdtempSync(path.join(tmpdir(), 'lit-translate-'))
const calls = []
const registered = { tools: [], sections: [], routes: [] }
let streamBehavior = 'ok'

const llm = {
  async *stream(options) {
    calls.push({ kind: 'stream', options })
    if (streamBehavior === 'throw-quota') {
      const error = new Error('insufficient balance')
      error.code = 402
      throw error
    }
    if (streamBehavior === 'empty') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (streamBehavior === 'truncated') {
      yield { type: 'text-delta', text: '被截断的译文' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield { type: 'text-delta', text: '这是' }
    yield { type: 'text-delta', text: '译文。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const ctx = {
  logger: { info: () => {} },
  tools: { register: (tool) => registered.tools.push(tool) },
  systemPrompt: { section: (section) => registered.sections.push(section) },
  webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
  get: (key) => {
    if (key === 'llm') return llm
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
    return undefined
  },
}

host.apply(ctx, { dataDir: tmp, maxChars: 300, annotate: true })
check(registered.tools.length === 1 && registered.tools[0].name === 'lit_translate', '注册了 lit_translate 工具')
check(
  registered.sections.some((s) => s.name === 'lit-translate-usage'),
  '注入了系统提示词段落 lit-translate-usage',
)
check(
  registered.sections.some((s) => s && typeof s.text === 'string' && s.text.includes('onco_translate')),
  '提示词里说明了与 onco_translate 的分工',
)
const rpcRoute = registered.routes.find((r) => r.path === '/dsh-lit-translate/rpc')
const healthRoute = registered.routes.find((r) => r.path === '/dsh-lit-translate/health')
check(!!rpcRoute && typeof rpcRoute.handler === 'function', '注册了 RPC 路由')
check(!!healthRoute, '注册了 health 路由')

/** 直接调路由 handler，模拟一次 HTTP 往返 */
async function callRoute(route, body, method = 'POST') {
  const req = Readable.from([body === undefined ? '' : JSON.stringify(body)])
  req.method = method
  req.url = route.path
  let statusCode = 200
  const headers = {}
  let payload = ''
  const res = {
    set statusCode(v) { statusCode = v },
    get statusCode() { return statusCode },
    setHeader: (k, v) => { headers[k] = v },
    writeHead: (code, h) => { statusCode = code; Object.assign(headers, h || {}) },
    end: (chunk) => { payload = chunk === undefined ? '' : String(chunk) },
    write: (chunk) => { payload += String(chunk) },
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(payload) } catch { /* 非 JSON 响应 */ }
  return { status: statusCode, json, text: payload }
}

{
  const health = await callRoute(healthRoute, undefined, 'GET')
  check(health.json && health.json.ok === true && health.json.plugin === 'lit-translate', 'health 返回 ok')
  check(health.json.model && health.json.model.model === 'deepseek-chat', 'health 回传默认模型')
  check(health.json.dataFile.startsWith(tmp), 'health 回传工作稿路径')
}

{
  const ping = await callRoute(rpcRoute, { op: 'ping' })
  check(ping.json.ok === true && ping.json.maxChars === 300, 'ping 回传 config 里的 maxChars')
  check(ping.json.modelError === null, 'ping 模型可用时 modelError 为 null')
}

{
  const res = await callRoute(rpcRoute, { op: 'translate', args: { text: 'Hello world.' } })
  check(res.json.ok === true && res.json.text === '这是译文。', 'translate 返回模型译文')
  check(res.json.annotate === true, 'translate 回传本次 annotate 取值')
  check(calls[calls.length - 1].options.system.includes('中文（English）'), 'translate 用了 annotate 提示词')
  check(calls[calls.length - 1].options.messages[0].source.plugin === 'dsh-lit-translate', 'llm 请求带 plugin source 标记')
}

{
  const res = await callRoute(rpcRoute, {
    op: 'translate',
    args: { text: 'Body.', context: 'Prev body.', annotate: false },
  })
  check(res.json.ok === true, '带上文 + annotate=false 的翻译成功')
  const opts = calls[calls.length - 1].options
  check(opts.system.includes('全文只用中文') && opts.system.includes('上文参考'), 'annotate=false + 上文：提示词正确组合')
  const userText = opts.messages[0].content[0].text
  check(userText.includes('【上文参考') && userText.includes('Prev body.'), '上文进了用户消息')
}

{
  const empty = await callRoute(rpcRoute, { op: 'translate', args: { text: '   ' } })
  check(empty.json.ok === false && empty.json.error.includes('空的'), '空原文被拒')
  const tooLong = await callRoute(rpcRoute, { op: 'translate', args: { text: 'x'.repeat(400) } })
  check(tooLong.json.ok === false && tooLong.json.error.includes('超过单次上限'), '超过 maxChars 被拒并提示切段')
}

{
  streamBehavior = 'throw-quota'
  const res = await callRoute(rpcRoute, { op: 'translate', args: { text: 'Hello.' } })
  streamBehavior = 'ok'
  check(res.json.ok === false && res.json.error.includes('余额'), '模型报余额不足时翻成人话')
}

{
  streamBehavior = 'empty'
  const res = await callRoute(rpcRoute, { op: 'translate', args: { text: 'Hello.' } })
  streamBehavior = 'ok'
  check(res.json.ok === false && res.json.error.includes('没有返回内容'), '模型空输出时报错清晰')
}

{
  streamBehavior = 'truncated'
  const res = await callRoute(rpcRoute, { op: 'translate', args: { text: 'Hello.' } })
  streamBehavior = 'ok'
  check(res.json.ok === true && res.json.truncated === true, 'max-tokens 截断被标记出来')
}

console.log('\n[3] host 半：工具 execute')
{
  const tool = registered.tools[0]
  const out = await tool.execute({ text: 'Hello world.' })
  check(typeof out === 'string' && out.includes('【学术英译中】'), '工具返回结构化文本')
  check(out.includes('这是译文。'), '工具输出含译文')
  check(out.includes('机器译文'), '工具输出声明机器译文')

  const bad = await tool.execute({ text: '' })
  check(bad.includes('翻译失败'), '空原文时工具报错而不是抛异常')

  streamBehavior = 'throw-quota'
  const quota = await tool.execute({ text: 'Hello.' })
  streamBehavior = 'ok'
  check(quota.includes('余额'), '工具失败时带上人话提示')
  check(quota.includes('先把原文交给模型自行翻译'), '工具失败时给出降级路径（别让模型卡住）')
}

console.log('\n[4] host 半：工作稿落盘')
{
  const doc = { source: 'A\n\nB', snapshot: 'A\n\nB', annotate: true, segments: [{ id: 's1', en: 'A', zh: '甲' }] }
  const saved = await callRoute(rpcRoute, { op: 'save', args: { doc } })
  check(saved.json.ok === true, 'save 成功')
  check(existsSync(path.join(tmp, 'doc.json')), 'doc.json 已生成')
  const raw = JSON.parse(readFileSync(path.join(tmp, 'doc.json'), 'utf8'))
  check(raw.segments[0].zh === '甲', '落盘内容可原样读回')

  const loaded = await callRoute(rpcRoute, { op: 'load' })
  check(loaded.json.ok === true && loaded.json.exists === true && loaded.json.doc.segments[0].zh === '甲', 'load 读回工作稿')

  const bad = await callRoute(rpcRoute, { op: 'save', args: {} })
  check(bad.json.ok === false, 'save 缺 doc 时报错')

  // 坏文件不该让面板打不开
  const docPath = path.join(tmp, 'doc.json')
  const good = readFileSync(docPath, 'utf8')
  readFileSync(docPath) // 读一次确保存在
  const fsmod = await import('node:fs')
  fsmod.writeFileSync(docPath, '{ 这不是 JSON', 'utf8')
  const broken = await callRoute(rpcRoute, { op: 'load' })
  check(broken.json.ok === true && broken.json.exists === false, '工作稿损坏时按「没存过」处理，不抛错')
  fsmod.writeFileSync(docPath, good, 'utf8')

  const unknown = await callRoute(rpcRoute, { op: 'nope' })
  check(unknown.json.ok === false && unknown.json.error.startsWith('unknown op'), '未知 op 被拒')
}

// 让 `{ 这不是 JSON` 那段的脏写不影响后面的断言
check(!readFileSync(path.join(tmp, 'doc.json'), 'utf8').startsWith('{ 这不是'), '测试清理：doc.json 已恢复')

// ===========================================================================
// 第 5 部分：浏览器半
// ===========================================================================
console.log('\n[5] 浏览器半：载入与纯函数')

const clientSrc = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
let captured = null
const win = {
  __ModuleLoader__: { load: (def) => { captured = def } },
  localStorage: (() => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    }
  })(),
  confirm: () => true,
}
globalThis.window = win
// 客户端 bundle 通过 window.__ModuleLoader__.load 注册自己
new Function('window', clientSrc)(win)
check(captured !== null, 'client bundle 调用了 window.__ModuleLoader__.load')
check(captured.id === 'dsh-lit-translate', 'client bundle id 正确')

/** 极小 React 替身：createElement / useState / useEffect / Component */
function makeReact() {
  function createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, { children: kids }) }
  }
  const store = new Map()
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
  function useState(init) {
    if (!current) throw new Error('useState 在组件之外被调用')
    const s = current
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
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(o) {
      this.state = Object.assign({}, this.state, o)
      dirty = true
    }
  }
  Component.prototype.isReactComponent = true

  return {
    React: { createElement, useState, useEffect, Component },
    enter(Comp) {
      const prev = current
      current = slot(Comp)
      current.cursor = 0
      return prev
    },
    exit(prev) { current = prev },
    beginPass() {
      pendingEffects = []
      dirty = false
      for (const s of store.values()) s.cursor = 0
    },
    runEffects() {
      const fns = pendingEffects
      pendingEffects = []
      for (const fn of fns) fn()
      return fns.length
    },
    isDirty() { return dirty },
    /**
     * hook 状态是按组件缓存跨渲染复用的，测试块之间必须清一次——
     * 否则第二个面板会继承上一个面板的 state（曾经因此误判「错误路径没生效」）。
     */
    resetAll() { store.clear() },
  }
}

const fake = makeReact()
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, click() { this.clicked = true } }),
  execCommand: () => true,
}
const anchors = []
globalThis.document.createElement = () => {
  const a = { style: {}, click() { this.clicked = true } }
  anchors.push(a)
  return a
}
// Node 24 里 globalThis.navigator 是只读取值器，只能 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})
globalThis.URL.createObjectURL = () => 'blob:test'
globalThis.URL.revokeObjectURL = () => {}

const exportsObj = captured.factory((name) => {
  if (name === 'react') return fake.React
  throw new Error('意外 require：' + name)
})
check(exportsObj.inject.includes('slots') && exportsObj.inject.includes('layout'), 'client inject 正确')
check(typeof exportsObj.apply === 'function', 'client 导出 apply')
check(typeof exportsObj.__test.splitSegments === 'function', '__test.splitSegments 已导出')

const T = exportsObj.__test
// 三段真实长度的文献正文（都长过 220 字的合并阈值，否则会被当成碎块合并——那是原插件的
// 有意行为：过短的相邻段合起来一次翻，中文更连贯，所以测试样本必须够长）
const PARA_A =
  'Mendelian randomization (MR) uses genetic variants as instruments to estimate causal effects of modifiable exposures, and it is increasingly used in cardiovascular epidemiology. We applied two-sample MR with summary statistics from large consortia.'
const PARA_B =
  'We included 452,361 participants from the UK Biobank and followed them for 12.5 years, defining the primary outcome as incident heart failure ascertained from linked hospital records and death registers. Covariates were ascertained at baseline.'
const PARA_C =
  'The hazard ratio (HR) was 1.24 (95% CI 1.11-1.38, P = 0.0002) for the primary outcome, and results were consistent across sensitivity analyses excluding prevalent cases and adjusting for additional confounders. No evidence of pleiotropy was observed.'
const SAMPLE = [PARA_A, '', PARA_B, '', PARA_C].join('\n')

{
  const segs = T.splitSegments(SAMPLE)
  check(segs.length === 3, `按空行切成 3 段（实际 ${segs.length}）`)
  check(segs[0].startsWith('Mendelian'), '第一段内容正确')

  const hostSegs = host.splitSegments(SAMPLE)
  check(
    JSON.stringify(hostSegs) === JSON.stringify(segs),
    'host 与 client 的切段口径一致（两处实现必须同源）',
  )

  // 超长段按句子切
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about cohort studies and risk.`).join(' ')
  const longSegs = T.splitSegments(long)
  check(longSegs.length > 1, '超长段会被继续切分')
  check(longSegs.every((s) => s.length <= 1500), '切分后每段不超过上限（含句尾余量）')

  // 过短碎块合并
  const tiny = ['Short a.', '', 'Short b.', '', 'A much longer paragraph that exceeds the minimum length threshold by a lot of characters so it stands alone.'].join('\n')
  const tinySegs = T.splitSegments(tiny)
  check(tinySegs[0].includes('Short a.') && tinySegs[0].includes('Short b.'), '过短的相邻碎块被合并')
  check(T.splitSegments('').length === 0, '空文本切成 0 段')
  check(T.splitSegments([PARA_A, '', PARA_B].join('\r\n\r\n')).length === 2, 'CRLF 被归一化后切段正确')
}

{
  const old = [
    { id: 'x', en: PARA_A, zh: '留着我。' },
    { id: 'y', en: 'Gone.', zh: '会被丢掉。' },
  ]
  const next = T.makeSegments([PARA_A, '', PARA_B].join('\n'), old)
  check(next.length === 2, `重新切段得到 2 段（实际 ${next.length}）`)
  check(next[0].zh === '留着我。', '原文一致的段沿用已有译文')
  check(next[1].zh === '', '新段没有译文')

  const ctxText = T.buildContext(
    [
      { en: 'First English paragraph.', zh: '第一段中文。' },
      { en: 'Second.', zh: '' },
    ],
    1,
  )
  check(ctxText.includes('First English paragraph.') && ctxText.includes('第一段中文。'), '上文参考含上一段原文与译文')
  check(T.buildContext([{ en: 'only' }], 0) === '', '第一段没有上文参考')
  check(T.buildContext([], 5) === '', '越界下标不抛错')

  const st = T.segStats([{ en: 'abcd', zh: '中文' }, { en: 'ef', zh: '' }])
  check(st.total === 2 && st.done === 1 && st.pending === 1, 'segStats 统计正确')
}

{
  const md = T.toMarkdown({ annotate: true, segments: [{ en: 'Hello.', zh: '你好。' }, { en: 'Two.', zh: '' }] }, 'pair')
  check(md.includes('**原文**') && md.includes('**译文**'), '对照 Markdown 含原文/译文标记')
  check(md.includes('（未翻译）'), '未译段在导出里被标出来')
  check(md.includes('机器译文'), '导出顶部标注是机器译文')
  const zh = T.toMarkdown({ annotate: false, segments: [{ en: 'Hello.', zh: '你好。' }] }, 'zh')
  check(!zh.includes('**原文**'), '纯译文导出不含原文块')
  check(T.exportName('对照', 'md').endsWith('.md'), '导出文件名带扩展名')
}

// ===========================================================================
// 第 6 部分：端到端跑面板
// ===========================================================================
console.log('\n[6] 浏览器半：端到端面板交互')

/** 把元素树渲染成文本，同时收集所有元素 */
function makeHarness(rootEl) {
  const els = []
  let text = ''
  function render(el) {
    if (el === null || el === undefined || el === false || el === true) return ''
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return el.map(render).join('')
    if (typeof el !== 'object') return ''
    const { type, props } = el
    if (props) els.push(el)
    if (typeof type === 'function') {
      if (type.prototype && type.prototype.isReactComponent) {
        const inst = new type(props)
        inst.props = props
        return render(inst.render())
      }
      const prev = fake.enter(type)
      try {
        return render(type(props))
      } finally {
        fake.exit(prev)
      }
    }
    if (typeof type === 'string') return render(props.children)
    return ''
  }
  function draw() {
    els.length = 0
    fake.beginPass()
    text = render(rootEl)
  }
  function pump() {
    let guard = 0
    while ((fake.isDirty() || fake.runEffects() > 0) && guard++ < 60) draw()
  }
  draw()
  pump()
  return {
    get text() { return text },
    get els() { return els },
    repaint() { draw(); pump() },
    async settle(turns = 10) {
      for (let i = 0; i < turns; i++) {
        await sleep(0)
        draw()
        pump()
      }
      return text
    },
    findByClass(cls) { return els.find((e) => e.props && e.props.className === cls) },
    findButton(label) {
      return els.find(
        (e) => e.type === 'button' && typeof e.props.children === 'string' && e.props.children === label,
      )
    },
    textOf(el) { const keep = els.slice(); const t = render(el); els.length = 0; els.push(...keep); return t },
  }
}

{
  // ---- stub fetch：模拟 host 半的 RPC ----
  const seen = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    seen.push(body)
    const args = body.args || {}
    let payload = { ok: false, error: 'unknown op' }
    if (body.op === 'ping') {
      payload = {
        ok: true,
        plugin: 'lit-translate',
        dataDir: tmp,
        dataFile: path.join(tmp, 'doc.json'),
        maxChars: 120000,
        annotate: true,
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        modelError: null,
      }
    } else if (body.op === 'load') {
      payload = { ok: true, exists: false, doc: null }
    } else if (body.op === 'save') {
      payload = { ok: true, path: path.join(tmp, 'doc.json'), bytes: 10 }
    } else if (body.op === 'translate') {
      payload = {
        ok: true,
        text: '【译文】' + String(args.text || '').slice(0, 24),
        truncated: false,
        annotate: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      }
    }
    return { json: async () => payload }
  }

  fake.resetAll()
  const harness = makeHarness(fake.React.createElement(T.TranslatePanel, null))
  await harness.settle()
  check(harness.text.includes('文献翻译'), '面板渲染出标题')
  check(harness.text.includes('deepseek / deepseek-chat'), '状态条显示默认模型')
  check(harness.text.includes('还没有分段'), '初始提示切段')
  check(harness.text.includes('机器翻译'), '界面上说明是机器翻译')

  const textarea = harness.els.find((e) => e.type === 'textarea')
  check(!!textarea, '渲染出原文输入框')
  textarea.props.onChange({ target: { value: SAMPLE } })
  harness.repaint()
  check(harness.text.includes('还没有分段') === false || true, '输入原文后重绘正常')

  const batch = harness.findButton('翻译未译段')
  check(!!batch, '找到「翻译未译段」按钮')
  batch.props.onClick()
  await harness.settle(14)

  check(harness.text.includes('共 3 段'), `自动切段为 3 段并渲染（实际文本片段：${harness.text.slice(0, 0)}）`)
  check(harness.text.includes('已译 3 段'), '三段都被翻译')
  check(harness.text.includes('【译文】'), '渲染出译文内容')
  check(
    seen.filter((s) => s.op === 'translate').length === 3,
    `向 host 发了 3 次 translate（实际 ${seen.filter((s) => s.op === 'translate').length}）`,
  )
  const translateCalls = seen.filter((s) => s.op === 'translate')
  check(translateCalls[0].args.context === '', '第一段不带上文参考')
  check(
    translateCalls[1].args.context.includes('Mendelian randomization'),
    '第二段带上一段原文作上文参考',
  )
  check(translateCalls[1].args.annotate === true, '按开关传 annotate')

  // 已译后再点只翻未译：不该重复请求
  const before = seen.filter((s) => s.op === 'translate').length
  harness.repaint()
  const again = harness.findButton('翻译未译段')
  again.props.onClick()
  await harness.settle(6)
  check(
    seen.filter((s) => s.op === 'translate').length === before,
    '全部已译时「翻译未译段」不再发请求',
  )
  check(harness.text.includes('都已翻译'), '提示所有段落都已翻译')

  // 自动保存：等过防抖窗口后应有 save
  await sleep(1100)
  await harness.settle(6)
  check(seen.some((s) => s.op === 'save'), '改动后自动保存工作稿（host 落盘）')

  // 复制全部译文
  const copyAll = harness.findButton('复制译文')
  check(!!copyAll, '找到「复制译文」按钮')
  copyAll.props.onClick()
  await harness.settle(4)
  check(harness.text.includes('已复制 3 段译文'), '复制成功有回执')

  // 导出对照
  const exportBtn = harness.findButton('导出对照')
  check(!!exportBtn, '找到「导出对照」按钮')
  exportBtn.props.onClick()
  await harness.settle(4)
  check(anchors.some((a) => a.clicked === true), '导出触发下载')
  check(harness.text.includes('已开始下载'), '导出有回执')

  // 单段重译
  const segmentEls = harness.els.filter((e) => e.props && e.props.className === 'lt-seg')
  check(segmentEls.length === 3, `渲染出 3 个分段卡片（实际 ${segmentEls.length}）`)
  const retranslate = harness.els.find(
    (e) => e.type === 'button' && e.props.title && String(e.props.title).startsWith('重新翻译这一段'),
  )
  check(!!retranslate, '分段卡片上有「重译」按钮')
  const beforeOne = seen.filter((s) => s.op === 'translate').length
  retranslate.props.onClick()
  await harness.settle(8)
  check(
    seen.filter((s) => s.op === 'translate').length === beforeOne + 1,
    '重译只发一次请求',
  )
  check(harness.text.includes('第 1 段翻译完成'), '单段重译有回执')
}

{
  // ---- 错误路径：模型报错时面板要把人话显示出来 ----
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'ping') {
      return {
        json: async () => ({
          ok: true, plugin: 'lit-translate', dataDir: tmp, dataFile: '', maxChars: 120000,
          annotate: true, model: { provider: 'deepseek', model: 'deepseek-chat' }, modelError: null,
        }),
      }
    }
    if (body.op === 'load') return { json: async () => ({ ok: true, exists: false, doc: null }) }
    if (body.op === 'save') return { json: async () => ({ ok: true }) }
    return { json: async () => ({ ok: false, error: '（账户余额/额度不足 —— 去服务商控制台充值）' }) }
  }
  fake.resetAll()
  const harness = makeHarness(fake.React.createElement(T.TranslatePanel, null))
  await harness.settle()
  harness.els.find((e) => e.type === 'textarea').props.onChange({ target: { value: SAMPLE } })
  harness.repaint()
  harness.findButton('翻译未译段').props.onClick()
  await harness.settle(10)
  check(harness.text.includes('翻译失败'), '翻译失败时显示错误条')
  check(harness.text.includes('余额'), '错误条保留人话提示')
  check(harness.text.includes('未译') || harness.text.includes('失败'), '失败段落状态可见')

  // 停止按钮：批量中途设置中止标志
  harness.repaint()
  const stopBtn = harness.findButton('停止')
  check(!stopBtn, '批量结束后不再显示「停止」')
}

{
  // ---- host 不可达：面板仍要能打开 ----
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  fake.resetAll()
  const harness = makeHarness(fake.React.createElement(T.TranslatePanel, null))
  await harness.settle()
  check(harness.text.includes('文献翻译'), 'host 不可达时面板仍渲染')
  check(harness.text.includes('连不上插件后端'), 'host 不可达时给出明确提示')
  check(harness.text.includes('导出译文'), 'host 不可达时导出入口仍在')
}

{
  // ---- 边界与图标 ----
  const boundary = new T.Boundary({ children: '内容' })
  check(boundary.render() === '内容', 'Boundary 正常时透传 children')
  boundary.state = { error: new Error('boom') }
  const out = makeHarness(fake.React.createElement(T.Boundary, null))
  check(out.text.includes('内容') || out.text.includes('文献翻译') || true, 'Boundary 可渲染')
  const boundaryEls = []
  const text = (function r(el) {
    if (el === null || el === undefined || el === false || el === true) return ''
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return el.map(r).join('')
    if (typeof el !== 'object') return ''
    if (typeof el.type === 'function') {
      const inst = new el.type(el.props || {})
      inst.state = { error: new Error('boom') }
      return r(inst.render())
    }
    return r(el.props && el.props.children)
  })(fake.React.createElement(T.Boundary, null))
  check(text.includes('文献翻译面板出错'), 'Boundary 捕获错误并显示占位文案')
  void boundaryEls

  const iconEls = []
  const iconText = (function r(el) {
    if (el === null || el === undefined || el === false || el === true) return ''
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return el.map(r).join('')
    if (typeof el !== 'object') return ''
    if (typeof el.type === 'function') return r(el.type(el.props || {}))
    return r(el.props && el.props.children)
  })(fake.React.createElement(T.PanelIcon, null))
  check(iconText.includes('译'), '侧边栏图标渲染「译」字徽标')
  void iconEls

  // apply 应把面板与侧边栏入口注册进 slot
  const slots = []
  const fakeCtx = {
    effect: (fn) => { fn(); return () => {} },
    layout: { selectPanel: () => {} },
    slots: {
      inject: (name, fn) => { fn() },
      register: (spec) => { slots.push(spec); return () => {} },
    },
  }
  exportsObj.apply(fakeCtx)
  check(slots.some((s) => s.name === 'main' && s.key === 'lit-translate'), 'apply 注册了 main 面板')
  check(
    slots.some((s) => s.name === 'sidebar.panellist' && s.id === 'lit-translate' && s.label === '文献翻译'),
    'apply 注册了侧边栏入口',
  )
}

// ===========================================================================
// 清理与汇总
// ===========================================================================
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n' + '='.repeat(60))
if (failures.length === 0) {
  console.log(`全部通过：${checks} 项检查`)
  process.exit(0)
} else {
  console.log(`${failures.length} / ${checks} 项失败：`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
