/**
 * dsh-ct-norm 的独立功能测试。
 *
 * 用真实的 @deepseek-ai/dsh-tools 的 defineTool 做 schema 校验，用 mock ctx 代替 DSH 运行时。
 *
 * 前置条件：`dsh-ct-norm/node_modules/@deepseek-ai/dsh-tools` 必须可解析。
 * 该包由 DSH 自带、不随插件发布，测试前建一个 junction：
 *
 *   $tools = Join-Path $env:LOCALAPPDATA 'Programs\ds-harness-desktop\runtime\host\node_modules\@deepseek-ai'
 *   New-Item -ItemType Directory -Force -Path .\dsh-ct-norm\node_modules\@deepseek-ai
 *   New-Item -ItemType Junction -Path .\dsh-ct-norm\node_modules\@deepseek-ai\dsh-tools -Target (Join-Path $tools 'dsh-tools')
 *
 * （该 node_modules 不在 package.json 的 files 列表内，不会被打进 tgz。）
 *
 * 运行：node test-ct-norm.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { apply } from './dsh-ct-norm/lib/index.js'
import { loadLexicon, searchLexicon, buildMatcher, foldKey } from './dsh-ct-norm/lib/lexicon.js'
import { loadMeshSubset } from './dsh-ct-norm/lib/mesh.js'
import { createNormalizer } from './dsh-ct-norm/lib/normalize.js'
import { renderReport, aggregateConcepts } from './dsh-ct-norm/lib/render.js'
import { buildFillerMatcher, prepare } from './dsh-ct-norm/lib/text.js'

let checks = 0
const failures = []
function check(cond, label) {
  checks++
  if (!cond) {
    failures.push(label)
    console.log('  FAIL ', label)
  }
}
function section(t) { console.log('\n' + t) }

const ROOT = fileURLToPath(new URL('./dsh-ct-norm/', import.meta.url))
const DATA = path.join(ROOT, 'data')
const SRC = path.join(DATA, 'src')

const rules = JSON.parse(fs.readFileSync(path.join(DATA, 'ct.rules.json'), 'utf8'))
const entries = loadLexicon(path.join(DATA, 'ct.lexicon.jsonl'))
const meshSubset = loadMeshSubset(path.join(DATA, 'mesh.subset.jsonl'))
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'ct.manifest.json'), 'utf8'))
const norm = createNormalizer({ entries, meshSubset, rules })
const byUi = meshSubset.byUi

const meta = {
  version: manifest.version,
  meshRelease: manifest.mesh_release,
  entries: entries.length,
  aliases: norm.aliasCount,
  concepts: meshSubset.records.length,
}

/** 便捷：找出提及了某个 surface 的实体 */
const ent = (r, s) => r.entities.find((e) => e.surface.includes(s))
const allConcepts = (r) => r.entities.flatMap((e) => e.concepts.map((c) => c.ui))

// ===========================================================================
section('[1] 构建产物与清单一致性')
check(manifest.format === 'CTNORM1', `manifest.format 应为 CTNORM1，实际 ${manifest.format}`)
check(/^MeSH\s*\d{4}$/.test(String(manifest.mesh_release)), `mesh_release 形状异常：${manifest.mesh_release}`)
check(manifest.counts.entries === entries.length, `清单条数 ${manifest.counts.entries} ≠ 词表条数 ${entries.length}`)
check(manifest.counts.meshConcepts === meshSubset.records.length, '清单概念数与 mesh.subset 行数不一致')
check(manifest.counts.aliasesZh + manifest.counts.aliasesEn === norm.aliasCount - (rules.unmapped.terms.reduce((a, t) => a + new Set([t.term, ...(t.aliases || [])]).size, 0)),
  '清单里的别名总数与匹配表对不上')
const rulesHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, 'ct.rules.json'))).digest('hex')
check(manifest.rules.sha256 === rulesHash, 'ct.manifest.json 记录的规则 sha256 与当前 ct.rules.json 不一致（产物与规则不同版）')
for (const [f, info] of Object.entries(manifest.sources)) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(SRC, f))).digest('hex')
  check(h === info.sha256, `源文件 ${f} 与清单里的 sha256 不一致（改动后忘了重跑 build-ct-lexicon.mjs）`)
}
console.log(`  ${entries.length} 条条目 / ${norm.aliasCount} 个表面写法 / ${meshSubset.records.length} 个 MeSH 概念`)

// ===========================================================================
section('[2] 诚实性不变量：MeSH 编号只能来自 NLM 索引')

// 2a. 源文件里**不允许**出现任何 MeSH 编号——编号一律由构建脚本反解
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.json'))
let handWrittenCodes = 0
for (const f of srcFiles) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8')
  const m = text.match(/\bD\d{6}\b/g)
  if (m) { handWrittenCodes += m.length; console.log(`  !! ${f} 里出现手写 MeSH 编号：${m.slice(0, 5).join(',')}`) }
}
check(handWrittenCodes === 0, `源词表里出现了 ${handWrittenCodes} 处手写 MeSH 编号（编号必须由构建脚本反解，不得手写）`)

// 2b. 词表引用的每一个概念都必须在随包子集里（否则运行时可能产出"空壳概念"）
let missing = 0
for (const e of entries) {
  const refs = [e.mesh, e.neoplasm, e.lymphaticMesh, ...Object.values(e.candidates || {})].filter(Boolean)
  for (const ref of refs) {
    if (!ref.ui) { missing++; console.log(`  !! ${e.id} 的某个概念引用缺 ui`); continue }
    if (!byUi.has(ref.ui)) {
      missing++
      console.log(`  !! ${e.id} 引用的 ${ref.ui} 不在 mesh.subset.jsonl 里`)
      continue
    }
    if (byUi.get(ref.ui).name !== ref.name) {
      missing++
      console.log(`  !! ${e.id} 里 ${ref.ui} 的名字(${ref.name}) 与子集(${byUi.get(ref.ui).name}) 不一致`)
    }
  }
}
check(missing === 0, `有 ${missing} 处概念引用与 mesh.subset.jsonl 不一致`)

// 2c. 子集里每条都必须是形状正确的 MeSH 描述符
let badSubset = 0
for (const r of meshSubset.records) {
  if (!/^D\d{6,}$/.test(r.ui)) { badSubset++; continue }
  if (typeof r.name !== 'string' || !r.name) badSubset++
  if (r.kind !== 'descriptor') badSubset++
}
check(badSubset === 0, `mesh.subset.jsonl 里有 ${badSubset} 条形状异常（应为 D###### 描述符且有规范名）`)
check(manifest.mesh_index.records === 355232, '清单未记录全量索引规模')
console.log(`  子集 ${meshSubset.records.length} 条，全部来自 NLM 索引（${manifest.mesh_release}）`)

// 2d. 端到端：归一化产出的每个编号都必须在子集里
const BIGREPORT = `检查技术：腹盆腔CT平扫+增强扫描。
检查所见：
肝内见多发低密度灶，考虑转移瘤可能；肝门区见肿大淋巴结。
胆囊壁增厚，胆囊内见结石影。胰腺形态尚可，胰管未见扩张。
脾脏增大，脾实质密度均匀。双肾见多发囊肿，较大者约2.1cm。
腹膜后见多发肿大淋巴结，最大短径约1.8cm。腹腔见少量积液。
双侧胸腔见少量积液，双肺见多发小结节。
腰椎见骨质破坏，考虑骨转移瘤。脑内见多发结节，考虑脑转移。
甲状腺右叶见结节，考虑甲状腺结节。
所见骨质未见明确骨折征象。双肾上腺未见异常。
诊断意见：
1. 肝多发转移瘤；
2. 腹膜后淋巴结转移；
3. 腹腔及双侧胸腔积液；
4. 腰椎骨转移；
5. 脑转移瘤。`
const bigR = norm.normalize(BIGREPORT)
const badUi = allConcepts(bigR).filter((ui) => !byUi.has(ui))
check(badUi.length === 0, `归一化产出了子集之外的 MeSH 编号：${badUi.join(',')}`)
for (const e of bigR.entities) {
  for (const c of e.concepts) {
    check(byUi.get(c.ui)?.name === c.name, `${e.surface} → ${c.ui} 的名字与子集不一致（${c.name}）`)
  }
}
check(bigR.integrityErrors.length === 0, `大报告出现完整性错误：${bigR.integrityErrors.join('；')}`)
console.log(`  大报告：实体 ${bigR.stats.entities}，概念 ${bigR.stats.concepts}，未归一化 ${bigR.stats.unmapped}，全部编号都在子集内`)

// ===========================================================================
section('[3] 修饰词屏蔽与最长优先')

const filler = buildFillerMatcher(rules)
const c1 = prepare('右侧胸腔少量积液', filler)
check(c1.compact === '胸腔积液', `「右侧胸腔少量积液」骨架文本应为「胸腔积液」，实际「${c1.compact}」`)
const c2 = prepare('胸腔见少量积液', filler)
check(c2.compact === '胸腔积液', `「胸腔见少量积液」骨架文本应为「胸腔积液」，实际「${c2.compact}」`)

const r1 = norm.normalize('右侧胸腔少量积液')
const e1 = ent(r1, '胸腔少量积液')
check(!!e1, '未识别出「右侧胸腔少量积液」')
check(e1 && e1.concepts[0].ui === 'D010996', `应为 Pleural Effusion(D010996)，实际 ${e1 && e1.concepts[0].ui}`)
check(e1 && e1.attrs.laterality === '右侧', `侧别应为「右侧」，实际 ${e1 && e1.attrs.laterality}`)
check(e1 && e1.attrs.severity === '少量', `程度应为「少量」，实际 ${e1 && e1.attrs.severity}`)
check(e1 && e1.approx === false, '「胸腔积液」是精确对应，不该标近似')

const r2 = norm.normalize('纵隔淋巴结肿大')
check(r2.entities.length === 1, `「纵隔淋巴结肿大」应命中 1 个实体，实际 ${r2.entities.length}`)
check(r2.entities[0]?.concepts[0]?.ui === 'D000072281', `应为 Lymphadenopathy(D000072281)，实际 ${r2.entities[0]?.concepts[0]?.ui}`)
check(r2.entities[0]?.sites[0]?.ui === 'D008482', '应绑定部位 Mediastinum(D008482)')

// 未归一化征象词要比泛化形态学词优先（磨玻璃结节 ≠ 结节）
const r3 = norm.normalize('右肺磨玻璃结节')
check(r3.unmapped.some((u) => u.term === '磨玻璃影'), `「磨玻璃结节」应进未归一化(磨玻璃影)，实际 ${JSON.stringify(r3.unmapped.map((u) => u.term))}`)
check(!r3.entities.some((e) => e.entryId === 'morph-nodule'), '「磨玻璃结节」不该被再当成泛化「结节」处理')

// ===========================================================================
section('[4] 极性：否定 vs 不确定（中文最容易反转语义的一处）')

const n1 = norm.normalize('未见胸腔积液')
check(n1.entities[0]?.attrs.negated === true, '「未见胸腔积液」应判为否定')
check(n1.entities[0]?.attrs.uncertain === false, '「未见胸腔积液」不该判为不确定')

const n2 = norm.normalize('不除外转移')
check(n2.entities[0]?.attrs.uncertain === true, '「不除外转移」应判为不确定')
check(n2.entities[0]?.attrs.negated === false,
  '「不除外转移」被误判成否定——这是语义反转（不除外 = 有可能），必须优先匹配 uncertainty')

const n3 = norm.normalize('考虑转移瘤可能')
check(n3.entities[0]?.attrs.uncertain === true && n3.entities[0]?.attrs.negated === false, '「考虑…可能」应为不确定')

const n4 = norm.normalize('未见明确骨质破坏')
check(n4.entities[0]?.attrs.negated === true, '「未见明确骨质破坏」应判为否定')

const n5 = norm.normalize('排除转移')
check(n5.entities[0]?.attrs.negated === true, '「排除转移」应判为否定')

// 并列顿号不切断否定作用域
const n6 = norm.normalize('未见胸腔积液、腹水')
check(n6.entities.length === 2 && n6.entities.every((e) => e.attrs.negated),
  '「未见胸腔积液、腹水」两项都应被否定（顿号不切断否定作用域）')

// 逗号两侧极性相反
const n7 = norm.normalize('未见胸腔积液，肝内见转移灶')
const ne = ent(n7, '胸腔')
const pe = ent(n7, '转移')
check(ne && ne.attrs.negated === true, '逗号前半句应否定')
check(pe && pe.attrs.negated === false, '逗号后半句不该被前面的否定带走')

// ===========================================================================
section('[5] 组合规则：部位 + 形态学词')

const m1 = norm.normalize('肝转移瘤')
const uis1 = m1.entities[0]?.concepts.map((c) => c.ui) ?? []
check(uis1.includes('D009362'), `「肝转移瘤」应含 Neoplasm Metastasis(D009362)，实际 ${uis1}`)
check(uis1.includes('D008113'), `「肝转移瘤」应含 Liver Neoplasms(D008113)，实际 ${uis1}`)
check(m1.entities[0]?.match === 'composition', '「肝转移瘤」应标为规则组合')
check((m1.entities[0]?.caveats ?? []).some((c) => c.includes('规则外推')), '规则外推必须带 caveat')

const m2 = norm.normalize('腹膜后淋巴结转移')
const uis2 = m2.entities[0]?.concepts.map((c) => c.ui) ?? []
check(uis2.includes('D008207'), `「淋巴结转移」应用更精确的 Lymphatic Metastasis(D008207)，实际 ${uis2}`)
check(!uis2.includes('D009362'), '「淋巴结转移」不该同时给泛用的 Neoplasm Metastasis')

const m3 = norm.normalize('脑骨多发转移')
const uis3 = m3.entities[0]?.concepts.map((c) => c.ui) ?? []
check(uis3.includes('D001932'), `「脑骨转移」应含 Brain Neoplasms(D001932)，实际 ${uis3}`)
check(uis3.includes('D001859'), `「脑骨转移」应含 Bone Neoplasms(D001859)，实际 ${uis3}`)

const m4 = norm.normalize('肝占位')
check(m4.entities[0]?.concepts[0]?.ui === 'D008113', `「肝占位」应规则外推为 Liver Neoplasms，实际 ${m4.entities[0]?.concepts[0]?.ui}`)
check((m4.entities[0]?.caveats ?? []).some((c) => c.includes('不等于病理诊断')), '「占位」外推必须提示不等于病理诊断')

const m5 = norm.normalize('占位性病变')
check(m5.entities.length === 0, '无部位的「占位」不该产出概念')
check(m5.unmapped.some((u) => u.kind === 'no-site'), `无部位的「占位」应进未归一化(no-site)，实际 ${JSON.stringify(m5.unmapped.map((u) => u.kind))}`)

const m6 = norm.normalize('肝内病灶')
check(m6.entities.length === 0, '泛化「病灶」不该产出概念')
check(m6.unmapped.some((u) => u.kind === 'generic-lesion'), '「病灶」应进未归一化(generic-lesion)')
check(m6.unmapped[0]?.site?.ui === 'D008099', '未归一化项也应带上部位（肝）')

const m7 = norm.normalize('转移至肝')
check((m7.entities[0]?.concepts ?? []).some((c) => c.ui === 'D008113'), '「转移至肝」部位在后也应绑定成功')

// ===========================================================================
section('[6] 歧义：不替用户选')

const a1 = norm.normalize('右肺上叶结节')
check(a1.entities[0]?.ambiguity?.field === 'count', '「肺结节」缺数量词时应报歧义')
check((a1.entities[0]?.concepts ?? []).length === 2, '歧义时应同时给出 Solitary 与 Multiple 两个候选')
check((a1.entities[0]?.concepts ?? []).some((c) => c.ui === 'D003074') && (a1.entities[0]?.concepts ?? []).some((c) => c.ui === 'D055613'),
  '歧义候选应为 D003074 与 D055613')

const a2 = norm.normalize('双肺多发结节')
check(a2.entities[0]?.ambiguity === undefined, '「双肺多发结节」有数量词，不该报歧义')
check(a2.entities[0]?.concepts.length === 1 && a2.entities[0].concepts[0].ui === 'D055613',
  `「双肺多发结节」应唯一命中 Multiple Pulmonary Nodules(D055613)，实际 ${JSON.stringify(a2.entities[0]?.concepts.map((c) => c.ui))}`)

const a3 = norm.normalize('右肺单发结节')
check(a3.entities[0]?.concepts.length === 1 && a3.entities[0].concepts[0].ui === 'D003074',
  `「单发结节」应唯一命中 Solitary Pulmonary Nodule(D003074)，实际 ${JSON.stringify(a3.entities[0]?.concepts.map((c) => c.ui))}`)

const a4 = norm.normalize('甲状腺右叶结节')
check(a4.entities[0]?.concepts[0]?.ui === 'D016606', `「甲状腺结节」应为 Thyroid Nodule(D016606)，实际 ${a4.entities[0]?.concepts[0]?.ui}`)
check(a4.entities[0]?.ambiguity === undefined, '甲状腺结节有独立条目，不该报肺结节的歧义')

// 「甲状腺右叶结节」中间夹了修饰词，字面别名接不上——必须靠「部位 -> 结节概念」查表兜住
const a5 = norm.normalize('甲状腺右叶见结节')
check(a5.entities[0]?.concepts.some((c) => c.ui === 'D016606'),
  `「甲状腺右叶见结节」应查表归到 Thyroid Nodule，实际 ${JSON.stringify(a5.entities[0]?.concepts.map((c) => c.ui))}`)
check(a5.unmapped.length === 0, `「甲状腺右叶见结节」不该落进未归一化，实际 ${JSON.stringify(a5.unmapped.map((u) => u.term))}`)

// ===========================================================================
section('[7] 未归一化：如实报出且给理由')

const u1 = norm.normalize('右肺上叶见磨玻璃影，边缘毛刺，胸膜增厚')
const terms = u1.unmapped.map((u) => u.term)
check(terms.includes('磨玻璃影'), `未归一化应含磨玻璃影，实际 ${JSON.stringify(terms)}`)
check(terms.includes('毛刺') || terms.includes('边缘毛糙'), `未归一化应含毛刺类，实际 ${JSON.stringify(terms)}`)
check(terms.includes('胸膜增厚'), `未归一化应含胸膜增厚，实际 ${JSON.stringify(terms)}`)
check(u1.unmapped.every((u) => typeof u.reason === 'string' && u.reason.length > 8), '每条未归一化都必须带可读理由')
const thick = u1.unmapped.find((u) => u.term === '胸膜增厚')
check(thick?.site?.ui === 'D010994', `「胸膜增厚」应绑定部位 Pleura(D010994)，实际 ${thick?.site?.ui}`)

const u2 = norm.normalize('肝内低密度灶')
check(u2.unmapped.some((u) => u.term === '低密度灶'), '「低密度灶」应进未归一化')
check(!u2.entities.length, '「低密度灶」不该产出任何 MeSH 概念')

// ===========================================================================
section('[8] 属性与尺寸归属')

const s1 = norm.normalize('纵隔见肿大淋巴结，最大短径约1.5cm。\n右侧胸腔见少量积液，胸膜未见增厚。')
const ln = ent(s1, '肿大淋巴结')
const pe2 = ent(s1, '积液')
check(ln?.size?.mm === 15, `1.5cm 应归到淋巴结，实际 ${JSON.stringify(ln?.size)}`)
check(pe2?.size === null || pe2?.size === undefined, `积液不该继承上一句的 1.5cm，实际 ${JSON.stringify(pe2?.size)}`)

const s2 = norm.normalize('双肺见多发小结节，较大者约5mm')
check(s2.entities[0]?.size?.mm === 5, `跨小句同句的 5mm 应归到结节，实际 ${JSON.stringify(s2.entities[0]?.size)}`)

const s3 = norm.normalize('右肺上叶见一大小约2.3cm结节影')
check(s3.entities[0]?.size?.mm === 23, `2.3cm 应换算为 23mm，实际 ${JSON.stringify(s3.entities[0]?.size)}`)

// ===========================================================================
section('[9] 近似标记必须精确到位')

const approxOf = (id) => {
  const e = entries.find((x) => x.id === id)
  return new Set(Array.isArray(e?.approx) ? e.approx : [])
}
check(!approxOf('abscess').has('脓肿'), '「脓肿」→ Abscess 是精确对应，不该标近似')
check(approxOf('abscess').has('化脓性病变'), '「化脓性病变」比 Abscess 宽，必须标近似')
check(!approxOf('lung-neoplasms').has('肺癌'), '「肺癌」→ Lung Neoplasms 是精确对应，不该标近似')
check(approxOf('lung-neoplasms').has('肺门肿块'), '「肺门肿块」是近似映射，必须标近似')
check(approxOf('lung').has('肺门'), '「肺门」→ Lung 是近似，必须标近似')
check(!approxOf('lung').has('肺'), '「肺」→ Lung 是精确对应，不该标近似')
const wholeTrue = entries.filter((e) => e.approx === true).length
check(wholeTrue === 0, `不应再有"整条近似"的条目（${wholeTrue} 条），近似必须精确到具体别名`)

const ap1 = norm.normalize('肝内见脓肿')
check(ap1.entities[0]?.approx === false, '「脓肿」不该让整个实体带近似标记')

// ===========================================================================
section('[10] 确定性与边界')

const t = '双肺多发结节，肝内见转移瘤，右侧胸腔少量积液。'
const A = JSON.stringify(norm.normalize(t))
const B = JSON.stringify(norm.normalize(t))
check(A === B, '同一输入两次归一化结果不一致（存在非确定性）')
check(JSON.stringify(norm.normalize('')) === JSON.stringify(norm.normalize('')), '空文本处理不确定')
check(norm.normalize('').stats.chars === 0, '空文本应返回空 stats')
check(norm.normalize('   ').stats.entities === 0, '纯空白不该产出实体')
const junk = norm.normalize('这是一段与影像完全无关的文字，只用来测试不崩溃。')
check(junk.entities.length === 0, '无关文字不该产出实体')
check(norm.normalize('###@@@ 12345 !!!').stats.chars > 0, '纯符号输入不该崩')

// 报告渲染必须同时出现三栏与免责
const rep = renderReport(bigR, meta)
check(rep.includes('一、归一化结果'), '报告缺少"归一化结果"栏')
check(rep.includes('二、未归一化'), '报告缺少"未归一化"栏')
check(rep.includes('三、概念汇总'), '报告缺少"概念汇总"栏')
check(rep.includes('四、仅识别到部位'), '报告缺少"仅识别到部位"栏')
check(rep.includes('五、边界与免责'), '报告缺少"边界与免责"栏')
check(rep.includes('MeSH') && !rep.includes('MeSH MeSH'), '报告里 MeSH 版本被重复拼写')
check(rep.includes('只有英文'), '报告必须说明 MeSH 只有英文、不产出中文译名')
const agg = aggregateConcepts(bigR)
check(agg.length === new Set(allConcepts(bigR)).size, '概念汇总去重数与实际不同概念数不符')

// ===========================================================================
section('[11] apply() 与真实 defineTool 校验')

const registered = []
const sections = []
const routes = []
const mockCtx = {
  logger: { info: () => {} },
  tools: { register: (t) => registered.push(t) },
  systemPrompt: { section: (s) => sections.push(s) },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get: () => undefined,
  effect: (fn) => { fn() },
}
apply(mockCtx, {})
check(registered.length === 2, `应注册 2 个工具，实际 ${registered.length}`)
check(['ct_norm', 'ct_lexicon'].every((n) => registered.some((t) => t.name === n)), '工具名不齐')
check(sections.length === 1 && sections[0]?.name === 'ct-norm-usage', '应注入 1 段系统提示词')
check(routes.some((r) => r.path === '/dsh-ct-norm/rpc'), '未注册面板 RPC 路由')
check(routes.some((r) => r.path === '/dsh-ct-norm/icon.png'), '未注册图标路由')

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
check(String(JSON.stringify(byName.ct_norm.parameters)).includes('"json"'), 'ct_norm 缺少 format=json 枚举')
check(String(JSON.stringify(byName.ct_lexicon.parameters)).includes('"morphology"'), 'ct_lexicon 缺少 kind 枚举')

const toolOut = String(await byName.ct_norm.execute({ text: '右肺上叶见2.3cm结节，考虑周围型肺癌可能。未见胸腔积液。' }))
check(toolOut.includes('归一化结果'), 'ct_norm 未返回归一化结果栏')
check(toolOut.includes('未归一化'), 'ct_norm 未返回未归一化栏')
check(toolOut.includes('mesh:D'), 'ct_norm 未给出 MeSH 编号')

const jsonOut = JSON.parse(String(await byName.ct_norm.execute({ text: '肝转移瘤', format: 'json' })))
check(jsonOut.entities[0].concepts.some((c) => c.ui === 'D008113'), 'ct_norm json 模式结果不正确')
check(jsonOut.lexicon.entries === entries.length, 'ct_norm json 里缺少词表元信息')

const lexOut = String(await byName.ct_lexicon.execute({ query: '胸腔积液' }))
check(lexOut.includes('D010996'), 'ct_lexicon 未查到 D010996')
check(lexOut.includes('Pleural Effusion'), 'ct_lexicon 未给出 MeSH 规范名')
const lexByCode = String(await byName.ct_lexicon.execute({ query: 'mesh:D008113' }))
check(lexByCode.includes('Liver Neoplasms'), 'ct_lexicon 按 MeSH 编号检索失败')
const lexBrowse = String(await byName.ct_lexicon.execute({ kind: 'morphology' }))
check(lexBrowse.includes('morph-'), 'ct_lexicon 按类别浏览失败')
const lexMiss = String(await byName.ct_lexicon.execute({ query: '完全不存在的写法XYZ' }))
check(lexMiss.includes('未命中'), 'ct_lexicon 未命中时应如实说明')

// ===========================================================================
section('[12] 面板 RPC 端到端')

function makeReq(body) {
  const L = {}
  const req = {
    method: 'POST',
    setEncoding: () => {},
    destroy: () => {},
    on: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return req },
  }
  setTimeout(() => {
    for (const fn of L.data || []) fn(JSON.stringify(body))
    for (const fn of L.end || []) fn()
  }, 0)
  return req
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: null }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = (b) => { res.body = b }
  return res
}
const rpcRoute = routes.find((r) => r.path === '/dsh-ct-norm/rpc')
async function callRpc(op, args) {
  const res = makeRes()
  await rpcRoute.handler(makeReq({ op, args: args || {} }), res)
  await new Promise((r) => setTimeout(r, 5))
  return JSON.parse(res.body)
}
const st = await callRpc('stats')
check(st.ok === true, `stats 失败：${st.error}`)
check(st.meta.entries === entries.length, 'RPC stats 条目数不符')
check(Array.isArray(st.unmapped) && st.unmapped.length > 20, 'RPC stats 未返回未归一化征象词表')
const ALLOWED_KINDS = ['anatomy', 'finding', 'neoplasm', 'assessment', 'imaging', 'morphology']
check(
  Object.keys(st.byKind).every((k) => ALLOWED_KINDS.includes(k)),
  `byKind 出现未知类别：${Object.keys(st.byKind).join(',')}`,
)
check(
  Object.values(st.byKind).reduce((a, b) => a + b, 0) === entries.length,
  'byKind 各计数之和应等于词表条目数',
)

const nr = await callRpc('normalize', { text: '双肺多发结节，考虑转移瘤可能。右侧胸腔少量积液。' })
check(nr.ok === true && nr.result.entities.length >= 2, 'RPC normalize 结果异常')
check(typeof nr.report === 'string' && nr.report.includes('边界与免责'), 'RPC normalize 未返回报告文本')

const lx = await callRpc('lexicon', { q: '淋巴结' })
check(lx.ok === true && lx.hits.length > 0, 'RPC lexicon 检索失败')
const cp = await callRpc('concepts', { limit: 500 })
check(cp.ok === true && cp.total === meshSubset.records.length, `RPC concepts 概念数应为 ${meshSubset.records.length}，实际 ${cp.total}`)
const bad = await callRpc('nope')
check(bad.ok === false && String(bad.error).includes('unknown op'), 'RPC 未知 op 未报错')
const long = await callRpc('normalize', { text: 'x'.repeat(70000) })
check(long.ok === false && String(long.error).includes('过长'), 'RPC 未拦截超长文本')

// ===========================================================================
section('[13] 客户端 bundle')

function makeReactStub() {
  const store = new Map()
  let current = null
  const slot = (C) => {
    let s = store.get(C)
    if (!s) { s = { hooks: [], deps: [], cursor: 0 }; store.set(C, s) }
    return s
  }
  const createElement = (type, props, ...children) => {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, { children: kids }) }
  }
  const useState = (init) => {
    const s = current
    const i = s.cursor++
    if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init
    return [s.hooks[i], (v) => { s.hooks[i] = typeof v === 'function' ? v(s.hooks[i]) : v }]
  }
  const useEffect = (fn, deps) => { current.cursor++; void deps; void fn }
  const useMemo = (fn) => fn()
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(o) { this.state = Object.assign({}, this.state, o) }
  }
  Component.prototype.isReactComponent = true
  return {
    React: { createElement, useState, useEffect, useMemo, Component },
    enter(C) { const p = current; current = slot(C); current.cursor = 0; return p },
    exit(p) { current = p },
  }
}
const stub = makeReactStub()
function renderEl(el, els = []) {
  if (el === null || el === undefined || el === false || el === true) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map((c) => renderEl(c, els)).join('')
  if (typeof el !== 'object') return ''
  const { type, props } = el
  els.push(el)
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const inst = new type(props)
      return renderEl(inst.render(), els)
    }
    const prev = stub.enter(type)
    try { return renderEl(type(props), els) } finally { stub.exit(prev) }
  }
  if (typeof type === 'string') return renderEl(props.children, els)
  return ''
}

let captured = null
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
new Function('window', clientSrc)(globalThis.window)
check(captured !== null, '客户端 bundle 未调用 window.__ModuleLoader__.load')
check(captured?.id === 'dsh-ct-norm', `bundle id 应为 dsh-ct-norm，实际 ${captured?.id}`)

const clientExports = captured.factory((name) => {
  if (name === 'react') return stub.React
  throw new Error('意外 require：' + name)
})
check(Array.isArray(clientExports.inject) && clientExports.inject.includes('slots'), '客户端未声明 slots 注入')
check(typeof clientExports.apply === 'function', '客户端未导出 apply')
check(!!clientExports.__test, '客户端缺少 __test 钩子')

const T = clientExports.__test
const text1 = renderEl(stub.React.createElement(T.Panel, {}))
check(text1.includes('CT 报告实体归一化'), '面板未渲染标题')
check(text1.includes('归一化') && text1.includes('词表'), '面板缺少页签')
check(text1.includes('未收录的写法单列一栏'), '面板未说明未归一化口径')

const text2 = renderEl(stub.React.createElement(T.ResultView, { result: nr.result, meta: nr.meta, report: nr.report }))
check(text2.includes('一、归一化结果'), 'ResultView 缺少结果栏')
check(text2.includes('二、未归一化'), 'ResultView 缺少未归一化栏')
check(text2.includes('三、概念汇总'), 'ResultView 缺少概念汇总栏')
check(text2.includes('mesh:'), 'ResultView 未展示 MeSH 编号')

const t3 = T.resultToText(nr.result, nr.meta)
check(t3.includes('未归一化'), 'resultToText 缺少未归一化段')
check(t3.includes('mesh:'), 'resultToText 缺少 MeSH 编号')

// 客户端 apply 注册两个 slot
const slotRegs = []
const clientCtx = {
  layout: {},
  slots: { inject: (name, fn) => { fn(); }, register: (meta2, comp) => { slotRegs.push({ meta: meta2, comp }); return () => {} } },
  effect: (fn) => { fn() },
}
clientExports.apply(clientCtx)
check(slotRegs.length === 2, `客户端应注册 2 个 slot，实际 ${slotRegs.length}`)
check(slotRegs.some((r) => r.meta.name === 'main' && r.meta.key === 'ct-norm'), '未注册 main 面板')
check(slotRegs.some((r) => r.meta.name === 'sidebar.panellist' && r.meta.label === 'CT 归一化'), '未注册侧边栏入口')
check(typeof globalThis.document === 'undefined' || true, 'placeholder')

// 侧边栏图标在图片加载失败时应回退到文字
const iconReg = slotRegs.find((r) => r.meta.name === 'sidebar.panellist')
const iconEls = []
const iconText = renderEl(stub.React.createElement(iconReg.comp, {}), iconEls)
const img = iconEls.find((e) => e.type === 'img')
check(!!img, '图标应优先渲染 <img>')
check(typeof img.props.onError === 'function', '图标 <img> 缺少 onError 回退钩子')
void iconText

// ===========================================================================
section('[14] 词表自洽：每一个别名都真的能被匹配到')

/*
 * 这是整个套件里最有价值的一条。
 *
 * 「别名写进词表了」和「别名真的能命中」是两件事——中间隔着匹配通道、
 * 修饰词屏蔽、极性词屏蔽、最长优先、条目分工。实测中正是这条（当时还是构建脚本里的
 * 一个检查）抓出了两个致命问题：
 *
 *   - 「无病生存」「无进展生存」含「无」，在旧实现里被屏蔽掉，永远命中不了；
 *   - 「多发性骨髓瘤」含「多发」，同样永远命中不了。
 *
 * 这两条都不是「写法不规范」，而是中文里没有别的写法可选。所以修法不是删别名，
 * 而是给它们开了一条匹配通道（见 lib/lexicon.js 的 masked 桶）。
 * 这个测试保证：以后不管谁加了什么写法，只要命中不了就会被拦下。
 */
let deadAliases = 0
let aliasChecked = 0
const deadSamples = []
// 「占位/肿块」「结节」「病灶」这三类形态学词**单独出现**时本就不该产出概念
// （没有部位可组合），它们应当进「未归一化」。所以对这些 action，验收标准是
// 「出现在未归一化栏里」，而不是「产出实体」。
const EXPECT_UNMAPPED_ACTIONS = new Set(['mass', 'nodule', 'lesion'])
for (const e of entries) {
  for (const a of e.zh ?? []) {
    aliasChecked++
    const res = norm.normalize(a)
    let ok
    if (e.kind === 'anatomy') {
      // 解剖部位单独出现时不会绑定到任何病变，应作为「仅识别到部位」出现
      ok = res.sites.some((s) => s.ui === e.mesh?.ui) ||
        res.entities.some((x) => x.sites.some((s) => s.ui === e.mesh?.ui))
    } else if (e.kind === 'morphology' && EXPECT_UNMAPPED_ACTIONS.has(e.action)) {
      ok = res.entities.some((x) => x.entryId === e.id) || res.unmapped.some((u) => u.surface === a)
    } else {
      ok = res.entities.some((x) => x.entryId === e.id)
    }
    if (!ok) {
      deadAliases++
      if (deadSamples.length < 15) deadSamples.push(`${e.id} 的「${a}」`)
    }
  }
}
for (const t of rules.unmapped.terms) {
  for (const a of new Set([t.term, ...(t.aliases ?? [])])) {
    aliasChecked++
    const res = norm.normalize(a)
    if (!res.unmapped.some((u) => u.term === t.term)) {
      deadAliases++
      if (deadSamples.length < 15) deadSamples.push(`unmapped「${t.term}」的「${a}」`)
    }
  }
}
if (deadAliases) for (const s of deadSamples) console.log('  !! 死别名：' + s)
check(deadAliases === 0, `有 ${deadAliases}/${aliasChecked} 个别名命中不了（写进词表却匹配不到，等于没收录）`)
console.log(`  ${aliasChecked} 个别名逐一验证可命中（含中文别名与未归一化征象词表）`)

// ===========================================================================
console.log('\n' + '='.repeat(64))
if (failures.length === 0) {
  console.log(`全部通过：${checks} 项检查`)
} else {
  console.log(`${checks - failures.length}/${checks} 通过，${failures.length} 项失败：`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
