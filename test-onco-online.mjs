/**
 * dsh-onco-lexicon 联网兜底层的独立测试。
 *
 * 分两类：
 *   A. 真实网络（会上外网，需联网）——验证 NCIt / MeSH 取数与解析；
 *   B. 注入式故障（不联网）——验证超时、断网、非 JSON、缓存、中文跳过的降级行为。
 *
 * 用法：node test-onco-online.mjs          跑全部
 *       node test-onco-online.mjs --offline 只跑 B 类（无网环境）
 */
import {
  onlineLookup,
  renderOnline,
  resolveOnlineConfig,
  OnlineCache,
  normKey,
  hasCJK,
  NCIT_CODE_RE,
  MESH_CODE_RE,
} from './dsh-onco-lexicon/lib/online.js'

const OFFLINE_ONLY = process.argv.includes('--offline')

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  } else {
    console.log('  ok    ', label)
  }
}

const cfg = resolveOnlineConfig({ online: { timeoutMs: 15000 } })

console.log('=== 1. 配置解析 ===')
check(resolveOnlineConfig({}).enabled === true, '默认开启')
check(resolveOnlineConfig({ online: false }).enabled === false, 'online:false 关闭')
check(resolveOnlineConfig({ onlineEnabled: false }).enabled === false, '扁平字段 onlineEnabled 关闭')
check(resolveOnlineConfig({ online: { timeoutMs: 1234 } }).timeoutMs === 1234, '对象式 timeoutMs 生效')
check(resolveOnlineConfig({ onlineTimeoutMs: 4321 }).timeoutMs === 4321, '扁平 timeoutMs 生效')
check(resolveOnlineConfig({ online: { timeoutMs: -5 } }).timeoutMs === 6000, '非法 timeoutMs 回落默认')
check(resolveOnlineConfig({ online: { ncitBase: 'https://x.test/api/' } }).ncitBase === 'https://x.test/api', '基址去尾斜杠')
check(NCIT_CODE_RE.test('C4872') && NCIT_CODE_RE.test('c4872') && !NCIT_CODE_RE.test('D008545'), 'C-code 形态')
check(MESH_CODE_RE.test('D008545') && !MESH_CODE_RE.test('C4872'), 'D-code 形态')
check(hasCJK('肺癌') && !hasCJK('NSCLC') && hasCJK('PD-L1 表达'), 'CJK 判定')
check(normKey('Non-Small Cell') === 'non small cell', 'normKey 归一化')

console.log('\n=== 2. 纯中文查询：不发网络请求，直接说明 ===')
{
  const r = await onlineLookup('肺癌晚期', { kind: 'term', config: resolveOnlineConfig({ online: { timeoutMs: 200 } }) })
  check(r.skipped && r.skipped.reason === 'cjk-only', '纯中文被标记为 cjk-only 跳过')
  check(r.ms < 150, `纯中文不应产生网络等待（实测 ${r.ms}ms）`)
  const text = renderOnline(r)
  console.log(text.split('\n').map((l) => '    | ' + l).join('\n'))
  check(text.includes('英文词表'), '说明里点明了上游是英文词表')
  check(!/[\u4e00-\u9fff]+\s*=\s*[A-Za-z]/.test(text), '没有伪造中英对应')
}

console.log('\n=== 3. 注入式故障：超时 / 断网 / 非 JSON / 无 fetch ===')
{
  // 永不 resolve，但在 abort 时以 AbortError 结束——模拟真实 fetch 的超时行为
  const hangingFetch = (url, opts = {}) =>
    new Promise((_, reject) => {
      const s = opts.signal
      const onAbort = () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      }
      if (s) {
        if (s.aborted) onAbort()
        else s.addEventListener('abort', onAbort)
      }
    })
  const t0 = Date.now()
  const r = await onlineLookup('Tirofiban', {
    kind: 'term',
    config: resolveOnlineConfig({ online: { timeoutMs: 400 } }),
    fetchImpl: hangingFetch,
  })
  const elapsed = Date.now() - t0
  check(!r.ok, '超时后 ok=false')
  check(r.errors.length >= 1 && r.errors.every((e) => e.kind === 'timeout'), '错误被归类为 timeout')
  check(elapsed < 1500, `超时应受预算约束（实测 ${elapsed}ms）`)
  const text = renderOnline(r)
  check(text.includes('请求超时'), '输出写明请求超时')
  check(text.includes('不代表该术语不存在'), '超时不被表述成「不存在」')
  console.log(text.split('\n').map((l) => '    | ' + l).join('\n'))
}
{
  // 上层信号（工具调用的 exec.signal）取消：应立刻中止，并报「已取消」而不是「超时」
  const hangingFetch = (url, opts = {}) =>
    new Promise((_, reject) => {
      const s = opts.signal
      const onAbort = () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      }
      if (s) {
        if (s.aborted) onAbort()
        else s.addEventListener('abort', onAbort)
      }
    })
  const ext = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ext.abort(), 50)
  const r = await onlineLookup('Tirofiban', {
    kind: 'term',
    // 预算给到 60s：只有外部取消生效，耗时才会短
    config: resolveOnlineConfig({ online: { timeoutMs: 60000 } }),
    fetchImpl: hangingFetch,
    signal: ext.signal,
  })
  const elapsed = Date.now() - t0
  check(!r.ok, '上层取消后 ok=false')
  check(r.errors.length >= 1 && r.errors.every((e) => e.kind === 'cancelled'), '被归类为 cancelled')
  check(elapsed < 1000, `取消应立即生效（实测 ${elapsed}ms）`)
  check(renderOnline(r).includes('调用已被取消'), '输出写明调用已被取消')
}
{
  const failFetch = () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
  const r = await onlineLookup('Tirofiban', {
    kind: 'term',
    config: resolveOnlineConfig({ online: { timeoutMs: 1000 } }),
    fetchImpl: failFetch,
  })
  check(!r.ok, '断网后 ok=false')
  check(r.errors.every((e) => e.kind === 'network'), '错误被归类为 network')
  check(renderOnline(r).includes('网络不可达'), '输出写明网络不可达')
}
{
  // 退役域名的真实形态：HTTP 200 + text/html
  const htmlFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=UTF-8' },
    text: async () => '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><body>portal</body></html>',
  })
  const r = await onlineLookup('C4872', {
    kind: 'term',
    config: resolveOnlineConfig({ online: { timeoutMs: 1000 } }),
    fetchImpl: htmlFetch,
  })
  check(!r.ok, 'HTTP 200 + HTML 不算成功')
  check(r.errors.every((e) => e.kind === 'non-json'), '被识别为 non-json 而不是静默成功')
  check(renderOnline(r).includes('不是 JSON'), '输出点明响应不是 JSON')
}
{
  const r = await onlineLookup('Tirofiban', {
    kind: 'term',
    config: resolveOnlineConfig({ online: {} }),
    fetchImpl: null,
  })
  // fetchImpl=null 会回落到 globalThis.fetch（存在），故这里只验证不抛异常
  check(typeof r.ok === 'boolean', '不抛异常且返回结构化结果')
}
{
  // 关闭联网
  const r = await onlineLookup('Tirofiban', { kind: 'term', config: resolveOnlineConfig({ online: false }) })
  check(r.skipped && r.skipped.reason === 'disabled', '关闭时不做任何请求')
  check(renderOnline(r).includes('没有进行联网查询'), '关闭时的措辞正确')
}

console.log('\n=== 4. 缓存 ===')
{
  const cache = new OnlineCache({ ttlMs: 10000, errorTtlMs: 10, max: 3 })
  cache.set('a', { v: 1 })
  check(cache.get('a')?.v === 1, '缓存写入后可读')
  check(cache.get('missing') === undefined, '未命中返回 undefined')
  cache.set('b', { v: 2 })
  cache.set('c', { v: 3 })
  cache.set('d', { v: 4 })
  check(cache.size === 3, `LRU 容量上限生效（size=${cache.size}）`)
  check(cache.get('a') === undefined, '最久未使用项被淘汰')
  const shortCache = new OnlineCache({ ttlMs: 10000, errorTtlMs: 1, max: 5 })
  shortCache.set('f', { failed: true }, { failed: true })
  await new Promise((r) => setTimeout(r, 12))
  check(shortCache.get('f') === undefined, '失败结果按 errorTtlMs 过期')
}

if (!OFFLINE_ONLY) {
  /**
   * 真实网络的断言会被瞬时抖动影响：实测 MeSH 偶发拿不到结果，紧接着 4/4 又都正常。
   * 这里对带网络腿的查询做有限重试，但**只在该次失败确实属于网络类**时才重试——
   * 无脑重试会把真实的解析 bug 一起放过，那比偶发失败更糟。
   */
  async function onlineWithRetry(run, predicate, attempts = 3) {
    const netKinds = ['timeout', 'network', 'http', 'non-json', 'unavailable']
    let last
    for (let i = 0; i < attempts; i++) {
      last = await run()
      if (predicate(last)) return last
      const netish = (last.errors || []).some((e) => netKinds.includes(e.kind))
      if (!netish) return last
      console.log(`  [重试 ${i + 1}/${attempts - 1}] 上次失败原因是网络类：${JSON.stringify(last.errors.map((e) => e.kind))}`)
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
    return last
  }

  console.log('\n=== 5. 真实网络：英文术语兜底 ===')
  const t1 = Date.now()
  const r1 = await onlineWithRetry(
    () => onlineLookup('Melanoma', { kind: 'term', topK: 3, config: cfg }),
    (r) => r.ok && !!r.mesh && r.mesh.descriptors.some((d) => d.code === 'D008545'),
  )
  console.log(`  耗时 ${Date.now() - t1}ms  ok=${r1.ok}  ncit=${r1.ncit?.concepts.length ?? 0}  mesh=${r1.mesh?.descriptors.length ?? 0}`)
  check(r1.ok, 'Melanoma 应在线查到')
  check(r1.ncit && r1.ncit.concepts.length > 0, 'NCIt 有结果')
  check(!!r1.ncit.version, `NCIt 版本号已取到（${r1.ncit?.version}）`)
  check(r1.ncit.concepts.some((c) => c.code === 'C3224'), 'Melanoma 应为 C3224')
  const mel = r1.ncit.concepts.find((c) => c.code === 'C3224')
  check(mel && mel.synonyms.length > 0, `C3224 带同义词（${mel?.synonyms.length} 个）`)
  check(mel && mel.def.length > 50, 'C3224 带释义')
  check(r1.mesh && r1.mesh.descriptors.some((d) => d.code === 'D008545'), 'MeSH 应给出 D008545')
  const text1 = renderOnline(r1)
  console.log(text1.split('\n').map((l) => '    | ' + l).join('\n'))
  check(text1.includes('联网兜底'), '输出带联网兜底标记')
  check(text1.includes('未经本地人工整理'), '输出声明未经本地人工整理')
  check(text1.includes('不提供中文名'), '输出声明确实没有中文名')
  check(!text1.includes('中文名：'), '没有伪造中文字段')

  console.log('\n=== 6. 真实网络：按编码直取 ===')
  const r2 = await onlineLookup('C4872', { kind: 'term', config: cfg })
  check(r2.ok && r2.mode === 'ncit-code', 'C-code 走按码直取')
  check(r2.ncit.concepts[0].name.includes('Breast'), `C4872 = ${r2.ncit.concepts[0].name}`)
  const r3 = await onlineLookup('D002289', { kind: 'term', config: cfg })
  check(r3.ok && r3.mode === 'mesh-code', 'D-code 走按码直取')
  check(/Non-Small-Cell Lung/i.test(r3.mesh.descriptors[0].label), `D002289 = ${r3.mesh.descriptors[0].label}`)
  check((r3.mesh.descriptors[0].entryTerms || []).length > 0, 'D-code 带入口词')

  console.log('\n=== 7. 真实网络：缩写兜底（含召回不完整的如实说明）===')
  const r4 = await onlineWithRetry(
    () => onlineLookup('NSCLC', { kind: 'abbr', topK: 5, config: cfg }),
    (r) => r.ok && !!r.ncit && r.ncit.concepts.some((c) => c.code === 'C2926'),
  )
  console.log(`  NSCLC -> ${r4.ncit?.concepts.map((c) => c.code + ':' + c.name).join(' | ')}`)
  check(r4.ok, 'NSCLC 在线有结果')
  check(r4.ncit.concepts.some((c) => c.code === 'C2926'), 'NSCLC 应命中 C2926')
  check(r4.ncit.concepts.every((c) => c.matchedAs), '每条都带匹配依据')
  const text4 = renderOnline(r4)
  check(text4.includes('不等于'), '写明候选不等于全部义项（召回不完整）')
  check(!/MeSH 主题词/.test(text4), '缩写模式不查 MeSH 标签（避免化学名噪声）')

  console.log('\n=== 8. 真实网络：缓存命中 ===')
  const cache = new OnlineCache({ ttlMs: 60000, errorTtlMs: 1000, max: 10 })
  const a = await onlineLookup('Melanoma', { kind: 'term', topK: 3, config: cfg, cache })
  const b = await onlineLookup('Melanoma', { kind: 'term', topK: 3, config: cfg, cache })
  check(b.cached === true, '第二次调用命中缓存')
  check(b.ms < 20, `缓存命中应近乎零耗时（实测 ${b.ms}ms）`)
  check(JSON.stringify(a.ncit) === JSON.stringify(b.ncit), '缓存内容一致')
}

console.log('\n=== 9. 工具层集成（种子词典 + mock ctx）===')
{
  const { apply } = await import('./dsh-onco-lexicon/lib/index.js')
  const registered = []
  const sections = []
  const mockCtx = {
    logger: { info: () => {} },
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: (s) => sections.push(s) },
  }
  // 用 106 条的种子词典：它只有 MeSH 编码、没有 NCIt C-code，
  // 因此 C4872 之类的查询必然是「本地未命中」，可以把兜底链路测成确定性的。
  apply(mockCtx, { dictPath: 'data/onco.seed.jsonl', online: { timeoutMs: 15000 } })
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))

  check(registered.length === 4, `仍注册 4 个工具（${registered.length}）`)
  check(sections.length === 1, '仍注入 1 段系统提示词')
  check(sections[0].text.includes('联网'), '提示词写明联网兜底')
  check(sections[0].text.includes('英文'), '提示词写明联网源是英文词表')
  check(String(byName.onco_term.description).includes('本地优先'), 'onco_term 描述写明本地优先')
  check(byName.onco_term.timeoutMs > 15000, `onco_term 声明了外层预算（${byName.onco_term.timeoutMs}）`)
  check(byName.onco_abbr.timeoutMs > 15000, 'onco_abbr 声明了外层预算')
  check(byName.onco_browse.timeoutMs === undefined, 'onco_browse 不声明预算（本地行为不变）')
  check(byName.onco_translate.timeoutMs === undefined, 'onco_translate 不声明预算（本地行为不变）')

  // 本地命中：不该出现联网段
  const hit = String(await byName.onco_term.execute({ term: 'Melanoma' }))
  check(hit.includes('命中'), '本地命中的措辞不变')
  check(!hit.includes('【联网兜底】'), '本地命中时没有联网段')

  if (!OFFLINE_ONLY) {
    // 本地未命中 → 联网按码直取（确定性最强的一条路径）
    const missCode = String(await byName.onco_term.execute({ term: 'C4872' }))
    check(missCode.includes('未在离线词典中检索到'), '先如实说明本地未命中')
    check(missCode.includes('【联网兜底】'), '本地未命中后接上联网兜底段')
    check(missCode.includes('Breast Carcinoma'), '联网按码取到了 Breast Carcinoma')
    check(missCode.includes('未经本地人工整理'), '联网内容标注了未经人工整理')
    check(
      missCode.indexOf('未在离线词典') < missCode.indexOf('【联网兜底】'),
      '本地段排在联网段之前（不喧宾夺主）',
    )
    console.log(missCode.split('\n').slice(0, 12).map((l) => '    | ' + l).join('\n'))

    // 英文术语未命中 → 联网检索
    const missTerm = String(await byName.onco_term.execute({ term: 'Tirofiban' }))
    check(missTerm.includes('【联网兜底】'), '英文术语未命中也会联网')
    check(missTerm.includes('C76405'), '联网检索到 Tirofiban 的 NCIt 编码 C76405')

    // 纯中文未命中 → 不做无谓往返，说明英文词表限制。
    // 注意用例选择：中文分词走字符二元组，「肺癌晚期」这类词本地是命中的
    // （命中 onco:nsclc / onco:sclc），根本走不到兜底分支，必须用真正的零命中词。
    const zhMiss = String(await byName.onco_term.execute({ term: '完全不存在的术语' }))
    check(zhMiss.includes('英文词表'), '纯中文未命中时说明联网源是英文词表')
    check(!zhMiss.includes('◇ NCIt'), '纯中文不产出联网结果段')

    // 缩写未命中 → 联网，且如实说明可能查不到
    const abbrMiss = String(await byName.onco_abbr.execute({ abbr: 'ZZQQ' }))
    check(abbrMiss.includes('未收录缩写'), '缩写未命中先如实说明')
    check(abbrMiss.includes('【联网兜底】'), '缩写未命中也会联网')
  }

  // 被筛查条件挡掉：不能去联网（联网结果没有本地那些可筛查字段）
  const filtered = String(await byName.onco_term.execute({ term: 'Breast Carcinoma', category: 'drug' }))
  check(filtered.includes('被当前筛查条件排除'), '被筛查条件挡掉时明确说明')
  check(!filtered.includes('【联网兜底】'), '被筛查条件挡掉时不联网')
  check(filtered.includes('已按 类别=抗肿瘤药物 筛查'), '筛查条件仍然回显')

  // 断网：工具不能崩，且必须保住「本地未收录」这个已确定的事实
  const realFetch = globalThis.fetch
  // 刻意换一个没查过的词：C4872 已在缓存里，用它测不出断网分支
  globalThis.fetch = () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
  try {
    const down = String(await byName.onco_term.execute({ term: 'Aspirin' }))
    check(down.includes('未在离线词典中检索到'), '断网时本地未命中的结论仍然返回')
    check(down.includes('【联网兜底】'), '断网时仍有联网兜底段')
    check(down.includes('网络不可达'), '断网时说明网络不可达')
    check(down.includes('不代表该术语不存在'), '断网不表述成「不存在」')
  } finally {
    globalThis.fetch = realFetch
  }

  // 显式关闭联网：回到改造前的行为
  const off = []
  apply(
    { logger: { info: () => {} }, tools: { register: (t) => off.push(t) }, systemPrompt: { section: () => {} } },
    { dictPath: 'data/onco.seed.jsonl', online: false },
  )
  const offTerm = off.find((t) => t.name === 'onco_term')
  check(offTerm.timeoutMs === undefined, '联网关闭时 onco_term 不声明预算')
  const offMiss = String(await offTerm.execute({ term: 'C4872' }))
  check(offMiss.includes('未在离线词典中检索到'), '联网关闭时仍是原来的未收录文案')
  check(!offMiss.includes('【联网兜底】'), '联网关闭时没有联网段')
  check(offMiss.includes('请勿据此推测或编造'), '联网关闭时保留「不要编造」的约束')
}

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
