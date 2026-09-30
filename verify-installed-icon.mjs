/**
 * 针对**已安装副本**的图标端到端验证。
 *
 * 这是最接近"别人电脑上"的场景：从 profile 的 node_modules 里加载插件，
 * 确认 index.js 能通过 import.meta.url 找到同包的 assets/icon.png 并供出 PNG。
 *
 * 路径不写死：优先用环境变量 DSH_HOME，其次回退到 ~/.ds-harness-desktop/dsh-home。
 */
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.ds-harness-desktop', 'dsh-home')
const PROFILE = process.env.DSH_PROFILE || 'web'
const INSTALLED_DIR = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-onco-lexicon')
const INSTALLED = pathToFileURL(path.join(INSTALLED_DIR, 'lib', 'index.js')).href

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}

const routes = []
const mockCtx = {
  logger: { info: (m) => console.log('  [log]', m) },
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get: () => undefined,
  effect: (fn) => fn(),
}

const mod = await import(INSTALLED)
mod.apply(mockCtx, {})

console.log('[1] 路由注册')
for (const r of routes) console.log('  ', r.path)
check(routes.length === 2, `应注册 2 条路由，实际 ${routes.length}`)

const iconRoute = routes.find((r) => r.path === '/dsh-onco-lexicon/icon.png')
check(!!iconRoute, '图标路由未注册')

console.log('[2] 取图标（从安装位置读取 assets/icon.png）')
if (iconRoute) {
  const result = await new Promise((resolve, reject) => {
    const req = { method: 'GET', setEncoding() {}, destroy() {}, on() { return this } }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
      end(body) { resolve({ status: res.statusCode, headers: res.headers, body }) },
    }
    iconRoute.handler(req, res).catch(reject)
  })
  const bytes = result.body ? result.body.length : 0
  const isPng = result.body && result.body.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  console.log(`  status=${result.status}  type=${result.headers['content-type']}  bytes=${bytes}`)
  check(result.status === 200, `状态码应为 200，实际 ${result.status}`)
  check(isPng, '返回的不是合法 PNG —— 说明 assets/icon.png 没随包安装')
  check(bytes > 1000, `字节数过小（${bytes}）`)
}

console.log('[3] 客户端内嵌数据也应在')
const clientSrc = await readFile(path.join(INSTALLED_DIR, 'lib', 'client.js'), 'utf8')
const m = /const ICON_DATA_URI = '([^']*)'/.exec(clientSrc)
check(!!m && m[1].length > 1000, `内嵌 data URI 异常（长度 ${m ? m[1].length : 0}）`)
check(/const ICON_SOURCES = \[ICON_DATA_URI, ICON_URL\]/.test(clientSrc), '来源列表构造不对')

console.log()
console.log('='.repeat(58))
console.log(`checks: ${checks}  failures: ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
