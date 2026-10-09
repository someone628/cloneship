/**
 * dsh-ct-norm —— 确定性归一化
 *
 * 输入一段中文 CT 报告原文，输出「实体 → MeSH 概念」的对照表，外加**明确的未归一化清单**。
 *
 * ## 三条不许越过的线
 *
 * 1. **不推断。** 只有两种情况会产出概念：词表直接命中，或「部位 + 形态学词」按固定规则组合。
 *    其它一律进「未归一化」，并说明为什么。
 * 2. **不编编号。** 每个 MeSH 编号都从 `mesh.subset.jsonl`（构建期由 NLM 索引提取）取；
 *    取不到就标记完整性错误，绝不留空编一个。
 * 3. **不替用户消灭歧义。** 例如「肺结节」在 MeSH 里对应 Solitary / Multiple 两个不同描述符，
 *    数量词缺失时**如实报为歧义**并同时给出两个候选，而不是默认取一个。
 */
import {
  buildFillerMatcher, prepare, buildSegments, detectSections, sectionAt,
  extractAttributes, extractSize,
} from './text.js'
import { buildMatcher, matchMentions } from './lexicon.js'
import { briefConcept } from './mesh.js'

const MULTI_RE = /(多发|多个|数枚|数个|多处|弥漫|散在|簇状|成团)/
const SINGLE_RE = /(单发|一枚|一处)/

export function createNormalizer({ entries, meshSubset, rules, config = {} }) {
  const filler = buildFillerMatcher(rules)
  const matcher = buildMatcher(entries, rules?.unmapped?.terms ?? [], { maskWords: filler.words })

  const cfg = {
    defChars: config.defChars ?? 200,
    siteGap: rules?.binding?.siteGap ?? 4,
    maxBindingDistance: config.siteLookback ?? rules?.binding?.maxBindingDistance ?? 40,
  }

  const byUi = meshSubset?.byUi ?? new Map()
  const byName = new Map()
  for (const r of meshSubset?.records ?? []) byName.set(r.name, r)

  const resolveConcept = (ref, integrityErrors, source) => {
    if (!ref || !ref.ui) return null
    const rec = byUi.get(ref.ui)
    if (!rec) {
      integrityErrors.push(`概念 ${ref.ui}（${ref.name ?? '?'}）不在 mesh.subset.jsonl 里——构建产物不完整，请重跑 build-ct-lexicon.mjs`)
      return { ui: ref.ui, name: ref.name ?? '', cat: ref.cat ?? '', tree: ref.tree ?? '', kind: 'unknown', def: '', source, missingInSubset: true }
    }
    return { ...briefConcept(rec, cfg.defChars), source }
  }

  function normalize(text) {
    const raw = String(text ?? '')
    const integrityErrors = []
    const result = {
      ok: true,
      chars: raw.length,
      entities: [],
      unmapped: [],
      sites: [],
      stats: {},
      integrityErrors,
    }
    if (!raw.trim()) {
      result.stats = emptyStats()
      return result
    }

    const prep = prepare(raw, filler)
    const { segments, segOfRaw } = buildSegments(raw, rules)
    const segIdOfCompact = prep.compactRawStart.map((o) => segOfRaw[o])
    // 折叠文本的逐字符小句号：给「含屏蔽词的别名」那条通道用
    const segIdOfFold = prep.rawStart.map((o) => segOfRaw[o])
    const mentions = matchMentions(prep, segIdOfCompact, segIdOfFold, matcher, raw)
    const sectionMarks = detectSections(raw, rules)
    const attrsOfSeg = segments.map((s) => extractAttributes(s.text, rules))

    const siteMentions = mentions
      .filter((m) => m.type === 'site')
      .map((m) => ({ ...m, entry: entries[m.entryIndex] }))
    const usedSite = new Set()

    const clauseIndexOf = (m) => segments[m.segIndex]?.clauseIndex ?? -1
    const sentenceIndexOf = (m) => segments[m.segIndex]?.sentenceIndex ?? -1

    /** 同小句内、紧邻在概念之前的「部位串」（允许 ≤ siteGap 的间隔） */
    const prefixSites = (concept) => {
      const run = []
      let cursor = concept.start
      for (let k = siteMentions.length - 1; k >= 0; k--) {
        const s = siteMentions[k]
        if (s.end > concept.start) continue
        if (s.segIndex !== concept.segIndex) break
        if (cursor - s.end > cfg.siteGap) break
        run.unshift(s)
        cursor = s.start
      }
      return run
    }

    /** 同句内、距离概念最近的前置部位（用于「肝内多发低密度灶，考虑转移瘤可能」这类跨小句写法） */
    const nearestSiteInSentence = (concept) => {
      let best = null
      for (const s of siteMentions) {
        if (s.end > concept.start) continue
        if (sentenceIndexOf(s) !== sentenceIndexOf(concept)) continue
        if (concept.start - s.end > cfg.maxBindingDistance) continue
        if (!best || s.end > best.end) best = s
      }
      return best
    }

    /** 概念之后紧跟的部位（「转移至肝」） */
    const suffixSites = (concept) => {
      const out = []
      let cursor = concept.end
      for (const s of siteMentions) {
        if (s.start < concept.end) continue
        if (s.segIndex !== concept.segIndex) break
        if (s.start - cursor > cfg.siteGap) break
        out.push(s)
        cursor = s.end
      }
      return out
    }

    /** 检查方法 / 评估类条目不挂部位：「胸部CT」里的「胸部」不是 CT 的解剖定位 */
    const BINDS_SITE = new Set(['finding', 'neoplasm', 'morphology'])

    /**
     * 统一解析「这个提及绑定了哪些部位」。三条策略按优先级：
     *   同小句紧邻（clause）→ 同句内最近的部位（sentence）→ 概念之后紧邻的部位（after）。
     * 绑定方式会原样回显，因为跨小句绑定比同小句绑定弱，需要人工多看一眼。
     */
    const resolveSites = (concept, allowSite) => {
      let sites = []
      let binding = null
      if (allowSite) {
        sites = prefixSites(concept)
        if (sites.length) binding = 'clause'
        else {
          const one = nearestSiteInSentence(concept)
          if (one) { sites = [one]; binding = 'sentence' }
        }
        if (!sites.length) {
          const post = suffixSites(concept)
          if (post.length) { sites = post; binding = 'after' }
        }
        markUsed(sites)
      }
      return { sites, binding }
    }

    const siteBrief = (s, position) => {
      const rec = byUi.get(s.entry.mesh?.ui)
      return {
        surface: s.surface,
        ui: s.entry.mesh?.ui ?? null,
        name: rec?.name ?? s.entry.mesh?.name ?? '',
        tree: rec?.tree ?? s.entry.mesh?.tree ?? '',
        approx: s.approx,
        position,
        neoplasm: s.entry.neoplasm ? { ui: s.entry.neoplasm.ui, name: s.entry.neoplasm.name } : null,
      }
    }

    /**
     * 未归一化的提及也尽量把部位挂上——「胸膜增厚」虽无 MeSH 概念，但「部位=胸膜」是确定信息。
     *
     * 部位来源有两种，优先级从高到低：
     *   1. 该未归一化写法在 ct.rules.json 里**声明**的部位（如「胸膜增厚」→ Pleura）。
     *      声明值来自词表，不靠猜。
     *   2. 同小句内紧邻的部位。
     * **不做**跨小句/跨句绑定：未归一化项本身就缺概念，再给它配一个隔壁小句的部位，
     * 会把「右肺上叶见磨玻璃影，边缘毛刺，胸膜增厚」里的「胸膜增厚」错配成肺。
     */
    const pushUnmapped = (m, kind, term, reason, attrs, declaredSiteName) => {
      let site = null
      let binding = null
      if (declaredSiteName) {
        const rec = byName.get(declaredSiteName)
        if (rec) {
          site = {
            surface: declaredSiteName, ui: rec.ui, name: rec.name, tree: rec.tree,
            approx: false, position: 'declared', neoplasm: null, declared: true,
          }
          binding = 'declared'
        }
      }
      if (!site) {
        const sameClause = prefixSites(m)
        if (sameClause.length) {
          site = siteBrief(sameClause[sameClause.length - 1], 'before')
          binding = 'clause'
          markUsed(sameClause)
        }
      }
      result.unmapped.push({
        surface: m.surface,
        start: m.start,
        end: m.end,
        kind,
        term,
        reason,
        site,
        binding,
        attrs: pickAttrs(attrs),
      })
    }

    /** 提及所在小句 / 整句的字符区间，用于把尺寸搜索限制在合理的语境内 */
    const clauseRange = (m) => {
      const s = segments[m.segIndex]
      return s ? { from: s.start, to: s.end } : null
    }
    const sentenceRange = (m) => {
      const si = sentenceIndexOf(m)
      let from = Infinity
      let to = -Infinity
      for (const s of segments) {
        if (s.sentenceIndex !== si) continue
        if (s.start < from) from = s.start
        if (s.end > to) to = s.end
      }
      return Number.isFinite(from) ? { from, to } : null
    }
    /** 先在本小句里找尺寸，找不到再放宽到整句（「双肺多发结节，较大者约5mm」） */
    const sizeFor = (m) => extractSize(raw, m.start, rules, clauseRange(m)) ?? extractSize(raw, m.start, rules, sentenceRange(m))

    for (const m of mentions) {
      const attrs = attrsOfSeg[m.segIndex] ?? extractAttributes('', rules)
      const seg = segments[m.segIndex]

      if (m.type === 'unmapped') {
        const g = matcher.unmapped[m.entryIndex]
        pushUnmapped(m, 'sign', g.term, g.reason, attrs, g.site)
        continue
      }
      if (m.type === 'site') continue

      // ---- 概念类提及 ----
      const entry = entries[m.entryIndex]
      const size = sizeFor(m)
      const entity = {
        surface: m.surface,
        start: m.start,
        end: m.end,
        entryId: entry.id,
        entryKind: entry.kind,
        alias: m.alias,
        section: sectionAt(sectionMarks, m.start),
        sentenceIndex: sentenceIndexOf(m),
        clauseIndex: clauseIndexOf(m),
        match: 'lexicon',
        binding: null,
        approx: m.approx,
        concepts: [],
        sites: [],
        attrs: pickAttrs(attrs),
        size,
        caveats: [],
      }

      const addConcept = (ref, source) => {
        if (!ref) return
        const c = resolveConcept(ref, integrityErrors, source)
        if (c && !entity.concepts.some((x) => x.ui === c.ui)) entity.concepts.push(c)
      }

      if (entry.kind !== 'morphology') {
        addConcept(entry.mesh, 'lexicon')
        const bound = resolveSites(m, BINDS_SITE.has(entry.kind))
        entity.binding = bound.binding
        for (const s of bound.sites) entity.sites.push(siteBrief(s, bound.binding === 'after' ? 'after' : 'before'))
      } else {
        // ---- 形态学词：按固定规则组合 ----
        entity.match = 'composition'
        const bound = resolveSites(m, true)
        const sites = bound.sites
        entity.binding = bound.binding
        for (const s of sites) entity.sites.push(siteBrief(s, bound.binding === 'after' ? 'after' : 'before'))

        const siteNeoplasms = sites
          .filter((s) => s.entry.neoplasm)
          .map((s) => ({ ref: s.entry.neoplasm, surface: s.surface }))

        const action = entry.action
        if (action === 'metastasis') {
          const lymph = sites.some((s) => s.entry.id === 'lymph-nodes')
          if (lymph && entry.lymphaticMesh) addConcept(entry.lymphaticMesh, 'lymphatic')
          else addConcept(entry.mesh, 'morphology')
          for (const sn of siteNeoplasms) addConcept(sn.ref, 'site-derived')
          if (!sites.length) entity.caveats.push('未识别到部位：「转移」未限定到具体器官，只给出 Neoplasm Metastasis。')
          else entity.caveats.push('「转移 + 部位」按规则给出该部位的肿瘤概念（如 Liver Neoplasms）与 Neoplasm Metastasis；规则外推，建议人工确认。')
        } else if (action === 'neoplasm') {
          if (siteNeoplasms.length) {
            for (const sn of siteNeoplasms) addConcept(sn.ref, 'site-derived')
            addConcept(entry.mesh, 'morphology')
            entity.caveats.push('「' + m.surface + '」是泛化形态学写法，已按「部位 + 形态学词」规则升级为该部位肿瘤概念；规则外推，建议人工确认。')
          } else {
            addConcept(entry.mesh, 'morphology')
          }
        } else if (action === 'recurrence') {
          addConcept(entry.mesh, 'morphology')
          for (const sn of siteNeoplasms) addConcept(sn.ref, 'site-derived')
        } else if (action === 'mass') {
          if (siteNeoplasms.length) {
            for (const sn of siteNeoplasms) addConcept(sn.ref, 'site-derived')
            entity.caveats.push('「' + m.surface + '」是影像描述词（MeSH 无对应概念），这里的映射是「部位 + 占位」的规则外推，**不等于病理诊断**，需人工确认。')
          } else {
            pushUnmapped(m, 'no-site', entry.zh[0] ?? entry.id,
              '识别到「占位/肿块」类病变词，但同一句内没有可供绑定的部位，无法归一化', attrs)
            continue
          }
        } else if (action === 'nodule') {
          // 先看该部位有没有专门的结节概念（甲状腺结节）——这是查表，不是猜。
          // 「甲状腺右叶结节」中间夹着修饰词，字面别名接不上，只能靠这条规则。
          const siteSpecific = sites
            .map((s) => s.entry.mesh?.ui)
            .map((ui) => (ui && entry.siteCandidates ? entry.siteCandidates[ui] : null))
            .find((x) => x)
          const lung = sites.find((s) => s.entry.id === 'lung')
          if (siteSpecific) {
            addConcept(siteSpecific, 'site-derived')
          } else if (!lung || !entry.candidates) {
            pushUnmapped(m, 'nodule-nonlung', entry.zh[0] ?? entry.id,
              lung
                ? 'MeSH 无对应的肺结节描述符候选'
                : '「结节」在 MeSH 里只有肺结节与甲状腺结节两个概念；本例未绑定到这两个部位，无法归一化',
              attrs)
            continue
          } else {
            const multi = attrs.count && MULTI_RE.test(attrs.count)
            const single = attrs.count && SINGLE_RE.test(attrs.count)
            if (multi) addConcept(entry.candidates.multiple, 'morphology')
            else if (single) addConcept(entry.candidates.single, 'morphology')
            else {
              addConcept(entry.candidates.single, 'morphology')
              addConcept(entry.candidates.multiple, 'morphology')
              entity.ambiguity = {
                field: 'count',
                question: '报告没写单发还是多发——MeSH 把它拆成了两个不同描述符，本工具不替你选。',
                candidates: entity.concepts.map((c) => ({ ui: c.ui, name: c.name })),
              }
              entity.caveats.push('数量词缺失，Solitary / Multiple Pulmonary Nodules 二者无法判定，已同时列出。')
            }
          }
        } else if (action === 'lesion') {
          pushUnmapped(m, 'generic-lesion', entry.zh[0] ?? entry.id,
            '「病灶/病变」不表明性质（可为炎症、囊肿、肿瘤），任何映射都是猜测；本插件据此一律不映射', attrs)
          continue
        }
      }

      if (entity.concepts.length === 0) {
        result.unmapped.push({
          surface: m.surface, start: m.start, end: m.end, kind: 'no-concept',
          term: entry.id,
          reason: `条目 ${entry.id} 的规则未产出任何概念`,
          attrs: pickAttrs(attrs),
        })
        continue
      }
      result.entities.push(entity)
    }

    // 未被任何概念用到的部位提及
    for (const s of siteMentions) {
      if (usedSite.has(s)) continue
      result.sites.push({
        surface: s.surface,
        start: s.start,
        end: s.end,
        ui: s.entry.mesh?.ui ?? null,
        name: s.entry.mesh?.name ?? '',
        approx: s.approx,
        sentenceIndex: sentenceIndexOf(s),
      })
    }

    result.entities.sort((a, b) => a.start - b.start)
    result.unmapped.sort((a, b) => a.start - b.start)
    result.sites.sort((a, b) => a.start - b.start)

    const uiSet = new Set()
    for (const e of result.entities) for (const c of e.concepts) uiSet.add(c.ui)
    result.stats = {
      chars: raw.length,
      clauses: segments.length,
      sentences: segments.reduce((a, s) => Math.max(a, s.sentenceIndex + 1), 0),
      siteMentions: siteMentions.length,
      entities: result.entities.length,
      concepts: uiSet.size,
      negated: result.entities.filter((e) => e.attrs.negated).length,
      uncertain: result.entities.filter((e) => e.attrs.uncertain).length,
      ambiguous: result.entities.filter((e) => e.ambiguity).length,
      unmapped: result.unmapped.length,
      orphanSites: result.sites.length,
      integrityErrors: integrityErrors.length,
    }
    return result

    function markUsed(list) {
      for (const s of list) usedSite.add(s)
    }
  }

  return {
    normalize,
    matcher,
    entries,
    unmappedGroups: matcher.unmapped,
    config: cfg,
    aliasCount: matcher.aliasCount,
    maxSurfaceLength: matcher.maxLen,
  }
}

function pickAttrs(attrs) {
  const out = {
    negated: attrs.negated,
    uncertain: attrs.uncertain,
    cues: attrs.cues,
    severity: attrs.severity,
    count: attrs.count,
    laterality: attrs.laterality,
    change: attrs.change,
  }
  return out
}

function emptyStats() {
  return {
    chars: 0, clauses: 0, sentences: 0, siteMentions: 0, entities: 0, concepts: 0,
    negated: 0, uncertain: 0, ambiguous: 0, unmapped: 0, orphanSites: 0, integrityErrors: 0,
  }
}
