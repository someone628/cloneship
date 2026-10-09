/**
 * dsh-ct-norm —— MeSH 概念子集
 *
 * 插件运行时**只**读这一份子集（`data/mesh.subset.jsonl`），不读 74 MiB 的全量索引。
 * 子集由 `build-ct-lexicon.mjs` 从 NLM 的 MeSH 2026 索引里，按词表引用到的概念逐个提取而来。
 *
 * 这带来一条硬性质：**插件在物理上产不出子集之外的 MeSH 编号**。
 * 归一化结果里的每个 `mesh:D######` 都必然来自 NLM 索引、且在构建期就固定下来，
 * 不存在运行时猜测或编造的可能。
 */
import { readFileSync } from 'node:fs'

export const KIND_LABEL = {
  descriptor: '描述符',
  qualifier: '限定词',
  supplemental: '补充概念',
  unknown: '未知',
}

/** MeSH 的类别是构建脚本由树号首字母推导的自有粗分类，不是 NLM 的语义类型 */
export const CAT_LABEL = {
  disease: '疾病',
  drug: '药物',
  method: '方法',
  treatment: '治疗',
  concept: '概念',
}

export function parseMeshSubset(text) {
  const byUi = new Map()
  const records = []
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('//')) return
    let r
    try { r = JSON.parse(t) } catch (e) {
      throw new Error(`mesh.subset.jsonl 第 ${i + 1} 行不是合法 JSON：${e.message}`)
    }
    if (!r || typeof r.ui !== 'string' || typeof r.name !== 'string') {
      throw new Error(`mesh.subset.jsonl 第 ${i + 1} 行缺少 ui / name`)
    }
    byUi.set(r.ui, r)
    records.push(r)
  })
  return { byUi, records }
}

export function loadMeshSubset(file) {
  const text = readFileSync(file, 'utf8')
  const parsed = parseMeshSubset(text)
  if (parsed.records.length === 0) throw new Error('MeSH 子集是空的')
  return parsed
}

/** 概念在输出里的标准写法：MeSH 规范名 + 编号 + 树号 */
export function conceptLabel(rec) {
  if (!rec) return '(未知概念)'
  const bits = [`${rec.name}`, `mesh:${rec.ui}`]
  if (rec.tree) bits.push(rec.tree.split(',')[0])
  return bits.join(' ')
}

export function briefConcept(rec, defChars = 200) {
  if (!rec) return null
  const def = rec.def && rec.def.length > defChars
    ? rec.def.slice(0, Math.max(0, defChars - 1)).trimEnd() + '…'
    : (rec.def || '')
  return {
    ui: rec.ui,
    name: rec.name,
    cat: rec.cat,
    tree: rec.tree,
    kind: rec.kind,
    def,
  }
}
