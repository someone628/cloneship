/**
 * dsh-ct-norm —— host 半（插件入口）
 *
 * 把「中文 CT 报告自由描述 → MeSH 标准概念」的确定性归一化能力交给智能体与浏览器面板。
 *
 * 设计口径（与 README / skill.md 必须一致）：
 *   * 全程离线：不联网、不调用模型。归一化只用随包分发的词表与 MeSH 子集。
 *   * 不推断：只有「词表命中」与「部位 + 形态学词的固定规则组合」两种产出路径。
 *   * 不编编号：每个 mesh:D###### 都来自构建期从 NLM 索引提取的 mesh.subset.jsonl。
 *   * 不掩盖漏收：未归一化的写法单列一栏并说明原因，与命中结果同等显眼。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadLexicon, searchLexicon } from './lexicon.js'
import { loadMeshSubset } from './mesh.js'
import { createNormalizer } from './normalize.js'
import { renderReport, renderSummary, renderLexiconHits, conceptIndex } from './render.js'

export const name = 'ct-norm'
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

const RPC_ROUTE = '/dsh-ct-norm/rpc'
const ICON_ROUTE = '/dsh-ct-norm/icon.png'
const ICON_FILE = fileURLToPath(new URL('../assets/icon.png', import.meta.url))

/** 面板栏目 key，客户端用 ctx.layout.selectPanel() 激活 */
export const PANEL_KEY = 'ct-norm'

const KINDS = ['anatomy', 'finding', 'neoplasm', 'assessment', 'imaging', 'morphology']
const KIND_LABEL = {
  anatomy: '解剖部位',
  finding: '征象/病变',
  neoplasm: '肿瘤概念',
  assessment: '疗效评估',
  imaging: '检查方法',
  morphology: '泛化形态学词',
}

function logInfo(ctx, message) {
  try { ctx?.logger?.info?.(`[ct-norm] ${message}`) } catch { /* 忽略 */ }
}

function pluginRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

function resolveFile(config, key, defaultRel) {
  const root = pluginRoot()
  const v = config?.[key]
  if (typeof v === 'string' && v.trim()) {
    const file = path.isAbsolute(v) ? v : path.join(root, v)
    if (!existsSync(file)) throw new Error(`${key} 指向的文件不存在：${file}`)
    return file
  }
  const file = path.join(root, defaultRel)
  if (!existsSync(file)) throw new Error(`未找到 ${defaultRel}（请先跑 node build-ct-lexicon.mjs）`)
  return file
}

export function apply(ctx, config = {}) {
  const maxChars = config.maxChars && config.maxChars > 0 ? config.maxChars : 60000
  const defChars = config.defChars && config.defChars > 0 ? config.defChars : 200

  let normalizer = null
  let entries = []
  let manifest = null
  let meshSubset = null
  let rules = null
  let loadError = null
  let loadMs = null
  let paths = null

  const t0 = performance.now()
  try {
    const lexiconFile = resolveFile(config, 'lexiconFile', 'data/ct.lexicon.jsonl')
    const subsetFile = resolveFile(config, 'meshSubsetFile', 'data/mesh.subset.jsonl')
    const rulesFile = resolveFile(config, 'rulesFile', 'data/ct.rules.json')
    const manifestFile = path.join(pluginRoot(), 'data', 'ct.manifest.json')

    rules = JSON.parse(readFileSync(rulesFile, 'utf8'))
    entries = loadLexicon(lexiconFile)
    meshSubset = loadMeshSubset(subsetFile)
    manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null

    normalizer = createNormalizer({
      entries,
      meshSubset,
      rules,
      config: { defChars, siteLookback: config.siteLookback },
    })
    paths = { lexiconFile, subsetFile, rulesFile, manifestFile }
    loadMs = performance.now() - t0
    logInfo(
      ctx,
      `已加载词表 ${entries.length} 条 / 别名 ${normalizer.aliasCount} 个 / MeSH 概念 ${meshSubset.records.length} 个，耗时 ${loadMs.toFixed(0)} ms`,
    )
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    logInfo(ctx, `初始化失败：${loadError}`)
  }

  const meta = () => ({
    version: manifest?.version ?? null,
    meshRelease: manifest?.mesh_release ?? null,
    builtUtc: manifest?.built_utc ?? null,
    entries: entries.length,
    aliases: normalizer?.aliasCount ?? 0,
    concepts: meshSubset?.records.length ?? 0,
    unmappedGroups: rules?.unmapped?.terms?.length ?? 0,
    loadMs: Math.round(loadMs ?? 0),
  })

  const unavailable = `CT 报告归一化词表不可用（${loadError ?? '未知原因'}），无法归一化。请如实说明工具不可用，不要凭记忆给出 MeSH 编号。`

  // ---------- 提示词层 ----------
  try {
    ctx.systemPrompt.section({
      name: 'ct-norm-usage',
      order: 46,
      text: [
        '本环境装有一个中文 CT 报告实体归一化工具（工具名 ct_norm / ct_lexicon）。',
        '它把放射科 CT 报告里的自由描述（「右肺上叶结节」「纵隔淋巴结肿大」「肝内多发低密度灶」…）',
        '按**本地人工整理的词表**确定性映射到 MeSH 2026 标准概念，并给出 MeSH 编号。',
        '',
        '使用铁律：',
        '1. 用户给出 CT 报告原文、或问「这段话对应哪个 MeSH 概念」时，必须调用 ct_norm，不要凭记忆给 MeSH 编号。',
        '2. 工具输出分「归一化结果」与「未归一化」两栏，**必须一起转述**。只讲命中、不讲漏收，',
        '   会让听者以为报告里的每个描述都已经被规范化了——这比没有结果更危险。',
        '3. 「未归一化」不是工具坏了：MeSH 主题词表以**疾病实体**为粒度，磨玻璃影、毛刺、分叶、',
        '   低密度灶这类影像描述性征象在 MeSH 里根本没有对应概念。不得为它们编一个 MeSH 编号。',
        '4. 结果里标了「规则组合」的（如「肝转移瘤」→ Liver Neoplasms ＋ Neoplasm Metastasis），',
        '   是「部位 + 形态学词」的规则外推，不等于病理诊断，转述时必须带上这一点。',
        '5. 标了「歧义」的（如「肺结节」未写单发/多发，MeSH 把它拆成 Solitary / Multiple 两个描述符），',
        '   必须把待确认的问题一并说出，不要替用户选一个。',
        '6. 标了「否定」的（「未见胸腔积液」）表示报告否定了该发现，不要当成阳性发现转述。',
        '7. 本工具**不产出中文译名**：MeSH 只有英文，条目里的中文是**词表收录的中文写法**，不是 MeSH 官方中文名。',
        '8. 覆盖范围就是词表本身。用户问「某写法为什么没识别出来」时，可以用 ct_lexicon 确认收录情况，',
        '   并如实说明未收录，不要用「可能是模型没识别到」这类含糊说法搪塞。',
        '9. 涉及诊断结论、分期、治疗方案的问题，本工具只做名词层面的归一化，须提示以临床指南与医师意见为准。',
      ].join('\n'),
    })
  } catch (error) {
    logInfo(ctx, `系统提示词注入失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const textOutput = () => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  })

  // ---------- 工具层 ----------
  ctx.tools.register(
    defineTool({
      name: 'ct_norm',
      description:
        '从中文 CT 报告原文中抽取自由描述，确定性归一化到 MeSH 2026 标准概念（给出 MeSH 规范名与编号）。' +
        '全程离线：只用本地人工整理的词表与从 NLM 索引提取的 MeSH 子集，不联网、不调用模型、不做推断。' +
        '输出分「归一化结果」「未归一化」「仅识别到部位」三栏——未归一化那一栏是刻意保留的：' +
        '磨玻璃影、毛刺、低密度灶这类影像描述性征象在 MeSH 里没有对应概念，硬映射会造出错误编码。' +
        '标「规则组合」的结果是「部位+形态学词」的规则外推，不等于诊断。',
      parameters: {
        text: { type: 'string', required: true, description: 'CT 报告原文（中文，可含英文缩写）。整段粘贴即可。' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text（默认，给人读的中文报告）/ json（结构化结果，给下游程序用）。',
        },
      },
      output: textOutput(),
      async execute(args) {
        if (!normalizer) return unavailable
        const text = String(args?.text ?? '')
        if (!text.trim()) return '没有可归一化的文本。'
        if (text.length > maxChars) {
          return `文本过长（${text.length} 字符，上限 ${maxChars}）。请按「检查所见」「诊断意见」分段后分次调用。`
        }
        const result = normalizer.normalize(text)
        if (args?.format === 'json') {
          return JSON.stringify({ ...result, lexicon: meta() }, null, 2)
        }
        return renderReport(result, meta())
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'ct_lexicon',
      description:
        '查询 ct_norm 用的本地词表：某个中文/英文写法对应哪个 MeSH 概念、词表收录了哪些写法、' +
        '某个 MeSH 概念有哪些中文写法、以及词表**没**收录什么。' +
        '当用户问「为什么这个写法没被识别出来」「词表里有没有 XX」「XX 对应哪个 MeSH 编号」时使用。' +
        '本工具只作用于本地词表，不联网。',
      parameters: {
        query: {
          type: 'string',
          description: '要查的写法或 MeSH 编号（如「胸腔积液」「pleural effusion」「D010996」「mesh:D010996」）。留空则按 kind 浏览。',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description:
            '可选：限定条目类别。anatomy（解剖部位）、finding（征象/病变）、neoplasm（肿瘤概念）、' +
            'assessment（疗效评估）、imaging（检查方法）、morphology（泛化形态学词，靠组合规则出概念）。',
        },
        limit: { type: 'number', description: '返回条数上限，默认 20。' },
      },
      output: textOutput(),
      execute(args) {
        if (!normalizer) return unavailable
        const limit = args?.limit && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const kind = KINDS.includes(args?.kind) ? args.kind : null
        const query = String(args?.query ?? '').trim()
        if (!query) {
          const list = entries.filter((e) => !kind || e.kind === kind).slice(0, limit)
          const head = `按类别浏览：${kind ? KIND_LABEL[kind] : '全部'}，共 ${entries.filter((e) => !kind || e.kind === kind).length} 条，列出前 ${list.length} 条。`
          return head + '\n\n' + renderLexiconHits(list.map((e) => ({ entry: e })), meta())
        }
        const hits = searchLexicon(entries, query, { limit, kind })
        return renderLexiconHits(hits, meta())
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
            if (data.length > 2e6) { reject(new Error('request body too large')); req.destroy() }
          })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })

      const serializeEntry = (e) => ({
        id: e.id,
        kind: e.kind,
        region: e.region ?? null,
        action: e.action ?? null,
        zh: e.zh ?? [],
        en: e.en ?? [],
        approx: Array.isArray(e.approx) ? e.approx : [],
        mesh: e.mesh ?? null,
        neoplasm: e.neoplasm ?? null,
        lymphaticMesh: e.lymphaticMesh ?? null,
        candidates: e.candidates ?? null,
        note: e.note ?? null,
      })

      const respond = (payload) => {
        if (!normalizer) return { ok: false, error: `词表不可用：${loadError ?? 'unknown'}` }
        const op = payload?.op
        const args = payload?.args ?? {}

        if (op === 'stats') {
          const byKind = {}
          for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
          return {
            ok: true,
            meta: meta(),
            byKind,
            meshConcepts: meshSubset.records.length,
            unmapped: (rules?.unmapped?.terms ?? []).map((t) => ({
              term: t.term, aliases: t.aliases ?? [], reason: t.reason ?? '',
            })),
            build: manifest,
          }
        }
        if (op === 'normalize') {
          const text = String(args.text ?? '')
          if (!text.trim()) return { ok: false, error: '没有可归一化的文本' }
          if (text.length > maxChars) return { ok: false, error: `文本过长（${text.length} 字符，上限 ${maxChars}）` }
          const r = normalizer.normalize(text)
          return { ok: true, meta: meta(), result: r, report: renderReport(r, meta()) }
        }
        if (op === 'lexicon') {
          const q = String(args.q ?? '').trim()
          const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200)
          const kind = KINDS.includes(args.kind) ? args.kind : null
          const list = q ? searchLexicon(entries, q, { limit, kind }) : entries.filter((e) => !kind || e.kind === kind).slice(0, limit).map((e) => ({ entry: e, via: '类别浏览' }))
          return { ok: true, meta: meta(), hits: list.map((h) => ({ ...serializeEntry(h.entry), via: h.via ?? null })) }
        }
        if (op === 'concepts') {
          const idx = conceptIndex(entries)
          const q = String(args.q ?? '').trim().toLowerCase()
          const filtered = q
            ? idx.filter((c) => c.name.toLowerCase().includes(q) || c.ui.toLowerCase().includes(q))
            : idx
          return {
            ok: true,
            meta: meta(),
            total: idx.length,
            concepts: filtered.slice(0, Math.min(Math.max(Number(args.limit) || 100, 1), 500)),
          }
        }
        if (op === 'export') {
          const text = String(args.text ?? '')
          if (!text) return { ok: false, error: '没有可导出的内容' }
          const safe = String(args.name ?? 'ct-norm.txt')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^\.+/, '_')
          const home = os.homedir()
          const downloads = path.join(home, 'Downloads')
          const override = process.env.CT_NORM_EXPORT_DIR
          const dir = override || (existsSync(downloads) ? downloads : home)
          const file = path.join(dir, safe)
          // 不接受 RPC 传入目录；再兜一层，确认最终路径确实落在导出目录内
          if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, error: '导出文件名非法' }
          // 带 UTF-8 BOM：Windows 记事本 / Excel 打开中文才不会乱码
          writeFileSync(file, '\uFEFF' + text, 'utf8')
          return { ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8') }
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
              } catch { /* 栅栏不可用时放行，避免整个面板失效 */ }
              try {
                if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return }
                const payload = JSON.parse(await readBody(req))
                sendJson(res, respond(payload))
              } catch (error) {
                sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
              }
            },
          }),
        'ct-norm: panel rpc route',
      )
      logInfo(ctx, `面板数据路由已注册：${RPC_ROUTE}`)

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
        'ct-norm: icon route',
      )
    } else {
      logInfo(ctx, '未拿到 webServer，面板数据路由未注册（工具仍可用）')
    }
  } catch (error) {
    logInfo(ctx, `面板路由注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 供自检脚本使用：不依赖 DSH 上下文即可构建归一化器 */
export function createFromDataDir(dataDir) {
  const rules = JSON.parse(readFileSync(path.join(dataDir, 'ct.rules.json'), 'utf8'))
  const e = loadLexicon(path.join(dataDir, 'ct.lexicon.jsonl'))
  const m = loadMeshSubset(path.join(dataDir, 'mesh.subset.jsonl'))
  return { normalizer: createNormalizer({ entries: e, meshSubset: m, rules }), entries: e, meshSubset: m, rules }
}

export { loadLexicon, loadMeshSubset, createNormalizer, renderReport, renderSummary, searchLexicon }
