/**
 * dsh-lit-translate —— host 半
 *
 * 来历：这一半是从 dsh-literature-reading（文献阅读）里**原样抠出来**的翻译链路。
 * 抠出来的边界很清楚——只保留「把英文文献译成学术中文」这件事：
 *   1. 用 harness 当前的默认模型做英译中（整段 / 逐段 / 带上一段作上文参考）
 *   2. 把工作稿（原文 + 各段译文）落盘到 $DSH_HOME/lit-translate/doc.json
 *   3. 给模型提供 lit_translate 工具，和 onco_translate 的「术语级对照」互补：
 *      词典工具管术语，这个工具管整段学术翻译
 *   4. 翻译前用本地 MeSH 2026 离线索引（lib/mesh.js + data/mesh_index.bin）
 *      把原文命中的术语收敛到 MeSH 规范名，作为术语约束注入系统提示词。
 *      注意：MeSH 只有英文，没有中文名——这一层只统一英文口径与消歧，
 *      绝不产出「MeSH 官方中文名」这种东西。
 *
 * 刻意**不做**的事：不导入 PDF、不做版式渲染、不做思维导图、不存文献卡片。
 * 那些都属于文献阅读插件；这个插件只服务翻译这一段链路，因此不碰它的数据目录，
 * 也不依赖它是否安装——两个插件并存、互不干扰。
 *
 * 浏览器半通过 POST /dsh-lit-translate/rpc 调用这里的 op。
 *
 * 关于提示词：SYSTEM_ANNOTATE / SYSTEM_PLAIN / CONTEXT_RULE 三份提示词与
 * dsh-literature-reading v1.19.0 逐字一致。翻译质量的调参都在这三份提示词里，
 * 改之前先在面板上对同一段原文做 A/B，别凭印象改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createMeshSource,
  findMeshTerms,
  renderMeshBlock,
  renderMeshSummary,
  meshBrief,
} from './mesh.js'

export const name = 'lit-translate'
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

const RPC_ROUTE = '/dsh-lit-translate/rpc'
const HEALTH_ROUTE = '/dsh-lit-translate/health'
/** RPC 请求体上限：单次最多 12 万字符原文，留足 JSON 与转义的余量 */
const MAX_BODY = 8 * 1024 * 1024
const DEFAULT_MAX_CHARS = 120000
/** 工作稿落盘上限：超过就拒绝写，避免一个坏状态把磁盘写满 */
const MAX_DOC_BYTES = 24 * 1024 * 1024

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_DATA_DIR = path.join(HOME, 'lit-translate')

const SYSTEM_ANNOTATE = [
  '你是医学与流行病学文献的翻译助手。把用户给出的英文文献内容翻译成流畅、准确的学术中文，供中文医学科研人员阅读。',
  '',
  '必须遵守：',
  '1. 只输出译文本身，不要写解释、前言、点评或「以下是翻译」之类的套话。',
  '2. 专业术语、方法名、统计量、量表名、数据库名、基因与蛋白名、药物名在第一次出现时，写成「中文（English）」的形式附上英文原文。例如：孟德尔随机化（Mendelian randomization, MR）、全基因组关联研究（genome-wide association study, GWAS）、风险比（hazard ratio, HR）、95%置信区间（95% confidence interval, 95%CI）、英国生物样本库（UK Biobank）。',
  '3. 同一术语再次出现时只用中文；但纯缩写（HR、OR、BMI、GWAS 等）保留英文缩写。',
  '4. 数字、单位、P 值、置信区间、样本量、基因位点（如 rs123456）、蛋白编号原样保留，不改写、不换算、不四舍五入。',
  '5. 保持原文的段落与层级结构，小标题同样翻译。',
  '6. 若原文本身已是中文或中英对照，原样返回。',
  '7. 内容被截断时翻译到能翻译的地方为止，不要自行补写。',
  '8. PDF 抽出的文字可能有断行、公式乱码或表格错位，按语义合理拼回，拼不回来的地方保留原样。',
].join('\n')

const SYSTEM_PLAIN = [
  '你是医学与流行病学文献的翻译助手。把用户给出的英文文献内容翻译成流畅、准确的学术中文。',
  '',
  '必须遵守：',
  '1. 只输出译文本身，不要写解释、前言、点评或「以下是翻译」之类的套话。',
  '2. 全文只用中文表达，专业术语不要附英文原文。',
  '3. 数字、单位、P 值、置信区间、样本量、基因位点原样保留，不改写、不换算。',
  '4. 保持原文的段落与层级结构。',
  '5. 内容被截断时翻译到能翻译的地方为止，不要自行补写。',
].join('\n')

const CONTEXT_RULE = '\n\n补充要求：用户可能先给一段「上文参考」。它只用于保持术语、缩写和指代一致，不要翻译它、不要评价它，只输出「需要翻译的段落」的译文。'

// ---------------------------------------------------------------------------
// 纯函数（导出以便测试直接调用）
// ---------------------------------------------------------------------------

export function errText(error) {
  if (error === null || error === undefined) return 'unknown'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

/**
 * 把模型这边常见的「不是你写错了、是账号/配置问题」翻译成人话，
 * 省得用户以为插件坏了。与文献阅读同源。
 */
export function llmTrouble(message, code) {
  const raw = String(message === null || message === undefined ? '' : message)
  const text = (raw + ' ' + String(code === null || code === undefined ? '' : code)).toLowerCase()
  if (/insufficient|balance|quota|欠费|余额/.test(text)) {
    return '（账户余额/额度不足 —— 这是 DSH 那边模型账号的问题，和插件无关：去服务商控制台充值，或换一个有额度的 API Key）'
  }
  if (/unauthorized|invalid.*api.*key|401|403|api key/.test(text)) {
    return '（API Key 无效或没权限 —— 检查 DSH 里配置的 Key 是否过期、是否填错）'
  }
  if (/rate ?limit|too many requests|429|overload/.test(text)) {
    return '（触发限流/服务繁忙 —— 等一会儿再试，或把「翻译未译的段」分成几批翻）'
  }
  if (/context length|too long|token.*limit|max.*token/.test(text)) {
    return '（内容超出模型上下文 —— 把选段缩小一点，或按段落切分后再翻）'
  }
  return ''
}

/**
 * 按空行优先、超长按句子切、相邻碎块合并的方式把原文切成可翻译的段。
 *
 * 客户端也有一份**同源**实现（浏览器半不能 import host 半）。两边必须保持一致，
 * 否则面板上「切段」的结果和 host 侧校验/工具的理解会错位；改动时两处一起改，
 * 测试里有对同一份样本的断言。
 */
export function splitSegments(text) {
  const norm = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n')
  const blocks = norm.split(/\n\s*\n/)
  const raw = []
  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed.length > 0) raw.push(trimmed)
  }
  if (raw.length === 0) return []
  const MAX = 1400
  const MIN = 220
  const out = []
  for (const block of raw) {
    if (block.length <= MAX) {
      out.push(block)
      continue
    }
    const sentences = block.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g) || [block]
    let current = ''
    for (const sentence of sentences) {
      if (current.length > 0 && current.length + sentence.length > MAX) {
        out.push(current.trim())
        current = ''
      }
      current += sentence
    }
    if (current.trim().length > 0) out.push(current.trim())
  }
  const merged = []
  for (const piece of out) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    if (prev !== null && prev.length < MIN && piece.length < MIN) {
      merged[merged.length - 1] = prev + '\n\n' + piece
      continue
    }
    merged.push(piece)
  }
  return merged
}

/** 组装系统提示词：是否附英文原文 + 是否给了上文参考 + 本次命中的 MeSH 术语约束 */
export function buildPrompt(annotate, hasContext, meshBlock) {
  const block = typeof meshBlock === 'string' ? meshBlock.trim() : ''
  return (
    (annotate ? SYSTEM_ANNOTATE : SYSTEM_PLAIN) +
    (hasContext ? CONTEXT_RULE : '') +
    (block.length > 0 ? '\n\n' + block : '')
  )
}

/** 组装用户消息：有上文参考时两段分开写，并明确「不要翻译上文」 */
export function buildUserText(text, context) {
  const hasContext = String(context === null || context === undefined ? '' : context).trim().length > 0
  if (!hasContext) return text
  return '【上文参考（只用来保持术语与指代一致，不要翻译它）】\n' + context + '\n\n【需要翻译的段落】\n' + text
}

/**
 * 工具层的文本输出。
 *
 * 这里的框架很重要：lit_translate 给出的是一份**真实译文**（模型按医学文献术语
 * 规范产出），和 onco_translate 的「术语级对照」是两回事。因此要明确标注
 * 「这是机器翻译、不是原文」，也不能让模型把它当成自己核对过原文的结论。
 */
export function renderTranslationResult(result, meta) {
  const opts = meta && typeof meta === 'object' ? meta : {}
  const src = String(opts.text === null || opts.text === undefined ? '' : opts.text)
  const head = [
    '【学术英译中】',
    `模型：${result.provider || '?'} / ${result.model || '?'}`,
    `术语附英文原文：${opts.annotate === false ? '关' : '开'}`,
    `本次原文 ${src.length} 字`,
    opts.hasContext === true ? '已带上一段作上文参考（只用于术语与指代一致，未参与翻译）' : '',
    typeof opts.meshLine === 'string' ? opts.meshLine : '',
  ].filter((line) => line.length > 0)
  const parts = [head.join(' · ')]
  parts.push(String(result.text === null || result.text === undefined ? '' : result.text))
  if (result.truncated === true) {
    parts.push('注意：译文在模型的输出上限处被截断，后面还有内容没译完。请把原文再切小一段重译，不要用这份不完整的译文下结论。')
  }
  parts.push('以上是默认模型产出的机器译文，供文献阅读参考；正式引用或做判断前请对照英文原文核对。')
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// 落盘小工具
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在或不可写；真正失败会在写文件时再报出来 */
  }
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim().length === 0) return null
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // 工作稿坏了不该让面板打不开：当作「没有存过」处理，用户可以重新粘贴
    return null
  }
}

/** 先写临时文件再 rename，避免写到一半断电留下半个 JSON */
function writeJsonFile(file, value) {
  const text = JSON.stringify(value)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_DOC_BYTES) {
    throw new Error(`工作稿过大（${(bytes / 1024 / 1024).toFixed(1)} MB），已拒绝写入`)
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return bytes
}

/** 安全写日志：不同版本上下文对象的日志接口存在差异，失败不影响主流程 */
function logInfo(ctx, message) {
  try {
    ctx?.logger?.info?.(`[lit-translate] ${message}`)
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const maxChars = Number.isFinite(config.maxChars) && config.maxChars > 0 ? Math.floor(config.maxChars) : DEFAULT_MAX_CHARS
  const defaultAnnotate = config.annotate !== false
  const dataDir =
    typeof config.dataDir === 'string' && config.dataDir.trim().length > 0 ? config.dataDir.trim() : DEFAULT_DATA_DIR
  const dataFile = path.join(dataDir, 'doc.json')
  ensureDir(dataDir)

  // ---- MeSH 2026 术语约束（离线索引，随包分发）----
  // 只做英文术语口径收敛与消歧：MeSH 没有中文名，插件绝不产出中文译名。
  const meshEnabled = config.mesh !== false
  const meshIndexFile =
    typeof config.meshIndexFile === 'string' && config.meshIndexFile.trim().length > 0
      ? config.meshIndexFile.trim()
      : null
  const meshMaxTerms = Number.isFinite(config.meshMaxTerms) && config.meshMaxTerms > 0 ? Math.floor(config.meshMaxTerms) : 40
  const meshDefChars = Number.isFinite(config.meshDefChars) && config.meshDefChars > 0 ? Math.floor(config.meshDefChars) : 120
  const meshMaxBlockChars =
    Number.isFinite(config.meshMaxBlockChars) && config.meshMaxBlockChars > 0 ? Math.floor(config.meshMaxBlockChars) : 3600
  // 索引整份 74 MiB，第一次真要翻译时才读进内存；面板探活只读 68 字节的头
  const meshSource = createMeshSource(meshIndexFile)

  function meshStatusPayload() {
    if (!meshEnabled) return { enabled: false, ok: false, file: meshSource.file, records: 0, terms: 0, loaded: false, error: null }
    const st = meshSource.status()
    return {
      enabled: true,
      ok: st.ok === true,
      file: st.file,
      bytes: st.bytes || 0,
      records: st.recordCount || 0,
      terms: st.termCount || 0,
      loaded: st.loaded === true,
      error: st.ok === true ? null : st.error || 'unknown',
    }
  }

  /**
   * 给一段原文找出 MeSH 术语并组装成提示词块。
   * 返回 { block, brief, matchCount, truncated } 或 { error }；**任何失败都不阻断翻译**。
   *
   * 「不阻断」不是靠自觉：索引被截断、释义超长、正则异常都会在这里抛，所以整段包在
   * try/catch 里，失败只降级为「本次没有术语约束」，翻译照常进行。
   */
  function meshFor(text, disabled, annotate) {
    if (!meshEnabled || disabled === true) return null
    const got = meshSource.get()
    if (got.ok !== true) return { error: got.error }
    try {
      const found = findMeshTerms(got.index, text, { maxTerms: meshMaxTerms })
      if (found.matches.length === 0) return { block: '', brief: meshBrief(found.matches), matchCount: 0, truncated: false }
      const block = renderMeshBlock(found, {
        defChars: meshDefChars,
        maxChars: meshMaxBlockChars,
        annotate: annotate !== false,
      })
      return { block, brief: meshBrief(found.matches), matchCount: found.matches.length, truncated: found.truncated === true }
    } catch (error) {
      return { error: 'MeSH 术语层本次未生效（不影响翻译）：' + errText(error) }
    }
  }

  /**
   * 读当前默认模型。只做读取，不发起调用，所以可以放心地在 ping / 面板状态条里用。
   * 刻意不把 llm / agentDefaultModel 写进 inject：这两个服务缺失时插件仍应加载，
   * 面板还能用来看/导出已存的工作稿，只是翻译报错而已。
   */
  function currentModel() {
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) return { ok: false, error: 'llm 服务不可用' }
    const modelService = ctx.get('agentDefaultModel')
    if (modelService === undefined || modelService === null) return { ok: false, error: '读不到默认模型配置' }
    let selection = null
    try {
      selection = modelService.currentSelection()
    } catch (error) {
      return { ok: false, error: '读取默认模型失败：' + errText(error) }
    }
    const provider = selection && selection.provider ? String(selection.provider) : ''
    const model = selection && selection.model ? String(selection.model) : ''
    if (provider.length === 0 || model.length === 0) return { ok: false, error: '没有可用的默认模型' }
    return { ok: true, provider, model }
  }

  /**
   * 和默认模型聊一句：翻译只有这一条出口。
   * 返回 { ok:true, text, truncated, provider, model } 或 { ok:false, error, code?, provider?, model? }。
   */
  async function llmRun(system, userText, tag) {
    const picked = currentModel()
    if (picked.ok !== true) return { ok: false, error: picked.error }
    const { provider, model } = picked
    const llm = ctx.get('llm')

    const messages = [
      {
        id: tag + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin', plugin: 'dsh-lit-translate' },
      },
    ]

    let out = ''
    const blockTexts = []
    let failure = null
    let truncated = false
    let finishKind = null
    try {
      for await (const chunk of llm.stream({ provider, model, messages, system })) {
        if (chunk === null || chunk === undefined) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text
        } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          blockTexts.push(chunk.block.text)
        } else if (chunk.type === 'finish' && chunk.reason) {
          const kind = chunk.reason.kind
          finishKind = kind
          // 以 kind 为准，而不是「failure 在不在」：万一上游只给了 kind 没给 failure，
          // 半截译文会被当成完整结果返回（ok:true、truncated:false），那是最坏的一种错。
          if (kind === 'error' || kind === 'aborted') {
            failure = chunk.reason.failure || { message: kind === 'aborted' ? '模型调用被中断' : '模型返回错误', kind }
          } else if (kind === 'max-tokens') truncated = true
        }
      }
    } catch (error) {
      const hint = llmTrouble(errText(error), error && error.code)
      return { ok: false, error: errText(error) + hint, hinted: hint.length > 0, provider, model }
    }
    if (out.trim().length === 0 && blockTexts.length > 0) out = blockTexts.join('\n')
    if (out.trim().length === 0) {
      if (failure !== null && failure !== undefined) {
        const detail = String(failure.message || '')
        const hint = llmTrouble(detail, failure.code)
        return { ok: false, error: '模型调用失败：' + detail + hint, hinted: hint.length > 0, code: failure.code, provider, model }
      }
      return { ok: false, error: '模型没有返回内容', provider, model, finishKind }
    }
    if (failure !== null && failure !== undefined) {
      const detail = String(failure.message || '')
      const hint = llmTrouble(detail, failure.code)
      return { ok: false, error: '模型调用中断：' + detail + hint, hinted: hint.length > 0, code: failure.code, provider, model }
    }
    return { ok: true, text: out, truncated, provider, model, finishKind }
  }

  /**
   * 翻译一段。args 来自面板 RPC 或 lit_translate 工具，两处共用这一份校验，
   * 免得出现「面板能翻、工具报的参数错误不一样」这种割裂。
   */
  async function doTranslate(args) {
    const text = args && typeof args.text === 'string' ? args.text : ''
    const context = args && typeof args.context === 'string' ? args.context : ''
    if (text.trim().length === 0) return { ok: false, error: '原文是空的' }
    if (text.length > maxChars) {
      return { ok: false, error: `原文 ${text.length} 字，超过单次上限 ${maxChars} 字，请先按段落切分再翻` }
    }
    const annotate = args && args.annotate === false ? false : args && args.annotate === true ? true : defaultAnnotate
    const hasContext = context.trim().length > 0
    const mesh = meshFor(text, args && args.mesh === false, annotate)
    const system = buildPrompt(annotate, hasContext, mesh && typeof mesh.block === 'string' ? mesh.block : '')
    const userText = buildUserText(text, context)
    const res = await llmRun(system, userText, 'littr')
    if (res.ok === true) {
      res.annotate = annotate
      if (mesh !== null) {
        res.mesh = mesh
        if (typeof mesh.error === 'string') res.meshWarning = mesh.error
      } else {
        // 配置关掉、或调用方本次传了 mesh=false：说清楚是「没启用」而不是「没命中」
        res.mesh = { block: '', brief: meshBrief([]), matchCount: 0, truncated: false, disabled: true }
      }
    }
    return res
  }

  /**
   * 工具输出里那行 MeSH 说明。
   * 三种状态都要说清楚：生效了命中几个 / 索引不可用没生效 / 调用方主动关掉了。
   */
  function meshSummaryLine(res) {
    if (!meshEnabled) return 'MeSH 术语约束：插件配置里已关闭'
    if (res && typeof res.meshWarning === 'string') return `MeSH 术语约束：本次未生效（${res.meshWarning}）`
    const m = res && res.mesh ? res.mesh : null
    if (m === null) return ''
    if (m.disabled === true) return 'MeSH 术语约束：本次已按调用方要求关闭'
    const terms = m.brief && Array.isArray(m.brief.terms) ? m.brief.terms : []
    if (m.matchCount === 0) return renderMeshSummary(terms)
    let line = renderMeshSummary(terms)
    if (m.truncated === true) line += '（命中更多，已按词长与特异性优先注入前若干个）'
    return line
  }

  // ---------- 工具层：lit_translate ----------
  try {
    ctx.tools.register(
      defineTool({
        name: 'lit_translate',
        description:
          '把英文医学/流行病学文献内容翻译成流畅、准确的学术中文（默认术语首次出现时附英文原文）。' +
          '默认会用本地 MeSH 2026 离线术语库约束英文术语口径（规范名 + 释义消歧 + MeSH 编号），' +
          '但 MeSH 只有英文、没有中文名，所以中文译名仍由模型按医学翻译规范给出。' +
          '与 onco_translate 的区别：onco_translate 只做「术语级对照」，不做语序调整；' +
          '本工具做的是整段学术翻译，可直接供中文阅读。' +
          '长文献请按段落多次调用，并把上一段原文（可含其译文）放进 context，以保持术语与指代一致。',
        parameters: {
          text: {
            type: 'string',
            required: true,
            description: '要翻译的英文文献内容（一段或几段）。超过单次上限时请按段落分次调用。',
          },
          context: {
            type: 'string',
            description:
              '可选：上一段的原文（可再附上它的中文译文）。只用于让本段术语、缩写与指代保持一致，' +
              '不会被翻译、也不会出现在译文里。',
          },
          annotate: {
            type: 'boolean',
            description:
              '可选：术语首次出现时是否写成「中文（English）」形式，默认 true（便于核对原文用词）。' +
              '想直接拿到纯中文译文时传 false。',
          },
          mesh: {
            type: 'boolean',
            description:
              '可选：本次是否启用 MeSH 2026 术语约束（默认 true，取插件配置）。' +
              '关掉后只做纯翻译，不注入术语提示词；术语一致性则完全依赖 context。',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const text = args && typeof args.text === 'string' ? args.text : ''
          const context = args && typeof args.context === 'string' ? args.context : ''
          try {
            const res = await doTranslate(args)
            if (res.ok !== true) {
              // llmRun 已经把「余额不足 / Key 无效」这类人话提示拼进 error 了（hinted=true），
              // 这里不能再拼一次，否则同一句提示会出现两遍。
              const hint = res.hinted === true ? '' : llmTrouble(res.error, res.code)
              return `文献翻译失败：${res.error}${hint}\n（lit-translate 插件：译文由 DSH 默认模型产出；失败时可以先把原文交给模型自行翻译，并向用户说明是模型翻译而非插件产出。）`
            }
            return renderTranslationResult(res, {
              text,
              annotate: res.annotate !== false,
              hasContext: context.trim().length > 0,
              meshLine: meshSummaryLine(res),
            })
          } catch (error) {
            // 兜底：任何没预料到的异常（例如损坏的 MeSH 索引）都不能让工具调用直接抛栈——
            // 那样模型只看到一句技术报错，用户则什么都拿不到。
            logInfo(ctx, `lit_translate 工具异常：${errText(error)}`)
            return `文献翻译失败：插件内部错误（${errText(error)}）。可以先把原文交给模型自行翻译，并向用户说明这是模型翻译、不是插件产出。`
          }
        },
      }),
    )
    logInfo(ctx, '工具已注册：lit_translate')
  } catch (error) {
    logInfo(ctx, `工具注册失败：${errText(error)}`)
  }

  // ---------- 提示词层：告诉模型什么时候用它、别把它当文献解读工具 ----------
  try {
    ctx.systemPrompt.section({
      name: 'lit-translate-usage',
      order: 46,
      text: [
        '本环境装有一个文献翻译插件（工具名 lit_translate），它用当前默认模型做学术英译中。',
        '1. 需要把英文文献段落译成中文时用 lit_translate；只查术语中英名时用 onco_translate，两者不要混用。',
        '2. 默认 annotate=true：术语首次出现写成「中文（English）」，便于核对原文用词；用户明确要纯中文时传 annotate=false。',
        '3. 长文献按段落分次调用；把上一段原文（可含其译文）放进 context，可显著减少同一术语前后译法不一致。',
        '4. 它默认带本地 MeSH 2026 术语约束（把原文命中的术语收敛到 MeSH 规范名，附释义与 MeSH 编号）。MeSH 只有英文、没有中文名——不要把 MeSH 编号说成「官方中文名」的依据，中文译名由模型按医学翻译规范给出。',
        '5. 它是翻译工具，不是文献解读工具：需要总结、评价、提取数据或回答研究问题时不要用它，直接用你自己的分析能力。',
        '6. 转述它的结果时要说明这是机器译文；数字、单位、P 值、样本量、基因位点必须与原文一致，不得据译文推断原文没有的结论。',
      ].join('\n'),
    })
  } catch (error) {
    logInfo(ctx, `系统提示词注入失败：${errText(error)}`)
  }

  // ---------- 浏览器面板的数据接口（同源 HTTP）----------
  try {
    const webServer = ctx.webServer
    if (webServer && typeof webServer.register === 'function') {
      const sendJson = (res, obj, status = 200) => {
        const body = JSON.stringify(obj)
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
      }
      const readBody = (req) =>
        new Promise((resolve, reject) => {
          let data = ''
          req.setEncoding('utf8')
          req.on('data', (chunk) => {
            data += chunk
            if (data.length > MAX_BODY) {
              reject(new Error('请求体过大'))
              req.destroy()
            }
          })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })

      /** 统一注册入口：所有路由先过 DSH 的浏览器信任栅栏 */
      const registerRoute = (route) => {
        const inner = route.handler
        return webServer.register(
          Object.assign({}, route, {
            handler: async (req, res) => {
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
              } catch {
                /* 栅栏不可用时放行，避免整个面板失效 */
              }
              try {
                await inner(req, res)
              } catch (error) {
                // 面板只该看到人话。原始报错（JSON 解析失败、RangeError、栈信息……）
                // 写进日志供排查，不直接丢给浏览器。
                logInfo(ctx, `面板 RPC 处理失败：${errText(error)}`)
                try {
                  sendJson(res, { ok: false, error: '插件内部错误（已记录到 DSH 日志），请重试或查看日志' }, 500)
                } catch {
                  /* 响应已经发出去或连接断了 */
                }
              }
            },
          }),
        )
      }

      async function respond(payload) {
        const op = payload && typeof payload.op === 'string' ? payload.op : ''
        const args = payload && payload.args && typeof payload.args === 'object' ? payload.args : {}

        if (op === 'ping') {
          const picked = currentModel()
          return {
            ok: true,
            plugin: name,
            dataDir,
            dataFile,
            maxChars,
            annotate: defaultAnnotate,
            mesh: meshStatusPayload(),
            model: picked.ok === true ? { provider: picked.provider, model: picked.model } : null,
            modelError: picked.ok === true ? null : picked.error,
          }
        }

        if (op === 'translate') {
          const res = await doTranslate(args)
          if (res.ok !== true) return res
          return {
            ok: true,
            text: res.text,
            truncated: res.truncated === true,
            annotate: res.annotate !== false,
            provider: res.provider,
            model: res.model,
            mesh: res.mesh && res.mesh.matchCount > 0 ? res.mesh.brief : null,
            meshCount: res.mesh ? res.mesh.matchCount : 0,
            meshDisabled: res.mesh ? res.mesh.disabled === true : false,
            meshWarning: typeof res.meshWarning === 'string' ? res.meshWarning : null,
          }
        }

        if (op === 'load') {
          const doc = readJsonFile(dataFile)
          return { ok: true, exists: doc !== null, doc, path: dataFile }
        }

        if (op === 'save') {
          const doc = args && args.doc && typeof args.doc === 'object' ? args.doc : null
          if (doc === null) return { ok: false, error: 'save 需要 doc 对象' }
          try {
            const bytes = writeJsonFile(dataFile, doc)
            return { ok: true, path: dataFile, bytes }
          } catch (error) {
            return { ok: false, error: '工作稿保存失败：' + errText(error) }
          }
        }

        if (op === 'segments') {
          // 面板想在后端确认切段口径时用它；正常情况下切段在浏览器本地做，不走网络
          const text = args && typeof args.text === 'string' ? args.text : ''
          return { ok: true, segments: splitSegments(text) }
        }

        return { ok: false, error: 'unknown op: ' + op }
      }

      ctx.effect(
        () =>
          registerRoute({
            kind: 'exact',
            path: HEALTH_ROUTE,
            handler: (req, res) => {
              const picked = currentModel()
              sendJson(res, {
                ok: true,
                plugin: name,
                dataDir,
                dataFile,
                maxChars,
                mesh: meshStatusPayload(),
                model: picked.ok === true ? { provider: picked.provider, model: picked.model } : null,
                modelError: picked.ok === true ? null : picked.error,
              })
            },
          }),
        'lit-translate: health route',
      )

      ctx.effect(
        () =>
          registerRoute({
            kind: 'exact',
            path: RPC_ROUTE,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, { ok: false, error: 'POST only' }, 405)
                return
              }
              const payload = JSON.parse(await readBody(req))
              sendJson(res, await respond(payload))
            },
          }),
        'lit-translate: panel rpc route',
      )

      logInfo(ctx, `面板数据路由已注册：${RPC_ROUTE}（工作稿：${dataFile}）`)
    } else {
      logInfo(ctx, '未拿到 webServer，面板数据路由未注册（工具仍可用）')
    }
  } catch (error) {
    logInfo(ctx, `面板路由注册失败：${errText(error)}`)
  }
}
