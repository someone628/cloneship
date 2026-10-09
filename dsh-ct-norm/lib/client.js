// dsh-ct-norm —— 浏览器半（手写的 DSH client 模块）
//
// 模块协议：window.__ModuleLoader__.load({ id, factory })，
// factory 内用 require("react") 取 React，导出 apply / inject。
//
// 与 host 半的通信走同源 HTTP：POST /dsh-ct-norm/rpc { op, args }。
// host 半已把词表与 MeSH 子集载入内存，这里只负责输入、渲染与导出。
//
// 界面上刻意把「归一化结果」与「未归一化」并排放：一份只显示命中的界面，
// 会让人以为报告里每个描述都已被规范化——那是这个工具最危险的误用方式。
window.__ModuleLoader__.load({
  id: 'dsh-ct-norm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const RPC = '/dsh-ct-norm/rpc'
    const PANEL_KEY = 'ct-norm'
    const ICON_URL = '/dsh-ct-norm/icon.png'

    const SAMPLE = `检查技术：胸部CT平扫+增强扫描。
检查所见：
右肺上叶见一大小约2.3cm结节影，边缘毛糙，可见分叶，考虑周围型肺癌可能。
双肺另见多发小结节，较大者约5mm。
纵隔及右肺门见多发肿大淋巴结，最大短径约1.5cm。
右侧胸腔见少量积液，胸膜未见明显增厚。
肝内见多发低密度灶，考虑转移瘤可能；腹膜后未见肿大淋巴结。
所见骨质未见明确破坏征象。
诊断意见：
1. 右肺上叶结节，考虑周围型肺癌；
2. 双肺多发结节，考虑转移瘤可能；
3. 纵隔及右肺门淋巴结肿大；
4. 右侧胸腔少量积液；
5. 肝内多发低密度灶，考虑转移瘤。`

    const KINDS = [
      ['anatomy', '解剖部位'],
      ['finding', '征象 / 病变'],
      ['neoplasm', '肿瘤概念'],
      ['assessment', '疗效评估'],
      ['imaging', '检查方法'],
      ['morphology', '泛化形态学词'],
    ]
    const KIND_LABEL = Object.fromEntries(KINDS)

    const CSS = `
.ctn-wrap{
  --ctn-ink:#0f766e;
  --ctn-ink-2:#115e59;
  --ctn-ink-3:#0d9488;
  --ctn-accent:#0d9488;
  --ctn-warn:#b45309;
  --ctn-neg:#b91c1c;
  --ctn-line:var(--dsw-alias-border-l2,#99f6e4);
  --ctn-bg:var(--dsw-alias-bg-base,#ffffff);
  --ctn-bg-2:var(--dsw-alias-bg-l2,#f0fdfa);
  color:var(--ctn-ink-2);
  font-size:13px;
  line-height:1.6;
  padding:10px 12px 40px;
  box-sizing:border-box;
  overflow:auto;
  height:100%;
}
.ctn-wrap *{box-sizing:border-box}
.ctn-title{color:var(--ctn-ink);font-size:15px;font-weight:600;margin:0 0 2px}
.ctn-sub{color:var(--ctn-ink-3);font-size:12px;margin:0 0 10px}
.ctn-tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.ctn-tab{
  border:1px solid var(--ctn-line);background:var(--ctn-bg);color:var(--ctn-ink-2);
  border-radius:14px;padding:3px 12px;font-size:12px;cursor:pointer
}
.ctn-tab[data-on="1"]{background:var(--ctn-accent);border-color:var(--ctn-accent);color:#fff}
.ctn-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.ctn-btn{
  border:1px solid var(--ctn-line);background:var(--ctn-bg-2);color:var(--ctn-ink-2);
  border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer
}
.ctn-btn:hover{border-color:var(--ctn-accent)}
.ctn-btn[disabled]{opacity:.5;cursor:default}
.ctn-btn-primary{background:var(--ctn-accent);border-color:var(--ctn-accent);color:#fff}
.ctn-textarea{
  width:100%;min-height:150px;border:1px solid var(--ctn-line);border-radius:8px;
  padding:8px 10px;font-size:13px;line-height:1.6;resize:vertical;
  background:var(--ctn-bg);color:var(--ctn-ink-2);font-family:inherit
}
.ctn-input,.ctn-select{
  border:1px solid var(--ctn-line);border-radius:6px;padding:4px 8px;font-size:12px;
  background:var(--ctn-bg);color:var(--ctn-ink-2)
}
.ctn-card{
  border:1px solid var(--ctn-line);border-radius:8px;padding:8px 10px;margin-bottom:8px;
  background:var(--ctn-bg)
}
.ctn-card-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}
.ctn-surface{color:var(--ctn-ink);font-weight:600;font-size:13.5px}
.ctn-arrow{color:var(--ctn-ink-3)}
.ctn-concept{color:var(--ctn-ink-2);font-weight:600}
.ctn-mesh{color:var(--ctn-ink-3);font-size:11.5px;font-weight:400}
.ctn-meta{color:var(--ctn-ink-3);font-size:11.5px}
.ctn-def{color:var(--ctn-ink-3);font-size:11.5px;margin-top:3px}
.ctn-chip{
  display:inline-block;border:1px solid var(--ctn-line);border-radius:10px;
  padding:0 7px;font-size:11px;margin:1px 4px 1px 0;color:var(--ctn-ink-3);background:var(--ctn-bg-2)
}
.ctn-chip-neg{border-color:var(--ctn-neg);color:var(--ctn-neg)}
.ctn-chip-warn{border-color:var(--ctn-warn);color:var(--ctn-warn)}
.ctn-note{color:var(--ctn-warn);font-size:11.5px;margin-top:2px}
.ctn-sec{margin:14px 0 6px;color:var(--ctn-ink);font-weight:600;font-size:13px}
.ctn-empty{color:var(--ctn-ink-3);font-size:12px}
.ctn-unmapped{border-left:3px solid var(--ctn-warn);padding-left:8px;margin-bottom:6px}
.ctn-danger{border-left:3px solid var(--ctn-neg);padding-left:8px;margin-bottom:6px}
.ctn-pre{
  white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;
  border:1px solid var(--ctn-line);border-radius:8px;padding:8px 10px;background:var(--ctn-bg-2);
  color:var(--ctn-ink-2);max-height:420px;overflow:auto;margin:8px 0 0
}
.ctn-crash{color:var(--ctn-neg);font-size:12px;white-space:pre-wrap}
.ctn-icon{
  border:0;background:transparent;cursor:pointer;padding:2px;display:flex;align-items:center
}
.ctn-icon-img{width:22px;height:22px;border-radius:5px;display:block}
.ctn-icon-text{
  width:22px;height:22px;border-radius:5px;background:var(--ctn-accent,#0d9488);
  color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center
}
.ctn-legend{color:var(--ctn-ink-3);font-size:11.5px;margin:4px 0 0}
`

    let ctxRef = null
    let cssDone = false

    function ensureCss() {
      if (cssDone || typeof document === 'undefined') return
      if (document.getElementById('ct-norm-css')) { cssDone = true; return }
      const el = document.createElement('style')
      el.id = 'ct-norm-css'
      el.textContent = CSS
      document.head.appendChild(el)
      cssDone = true
    }

    async function rpc(op, args) {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: args || {} }),
      })
      return await res.json()
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        if (this.state.error) {
          return h('div', { className: 'ctn-crash' },
            'CT 归一化面板渲染出错（已拦下，其余界面不受影响）：\n' +
            String((this.state.error && this.state.error.stack) || this.state.error))
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------------
    // 归一化结果渲染
    // ---------------------------------------------------------------------

    function Chips(props) {
      const e = props.entity
      const chips = []
      if (e.attrs && e.attrs.negated) chips.push(['否定：' + (e.attrs.cues && e.attrs.cues.negation ? e.attrs.cues.negation : '?'), 'ctn-chip-neg'])
      if (e.attrs && e.attrs.uncertain) chips.push(['可疑：' + (e.attrs.cues && e.attrs.cues.uncertainty ? e.attrs.cues.uncertainty : '?'), 'ctn-chip-warn'])
      if (e.approx) chips.push(['近似映射', 'ctn-chip-warn'])
      if (e.match === 'composition') chips.push(['规则组合', 'ctn-chip-warn'])
      if (e.binding === 'sentence') chips.push(['部位绑定：同句（较弱）', ''])
      if (e.ambiguity) chips.push(['歧义待定', 'ctn-chip-warn'])
      const a = e.attrs || {}
      if (a.severity) chips.push(['程度：' + a.severity, ''])
      if (a.count) chips.push(['数量：' + a.count, ''])
      if (a.laterality) chips.push(['侧别：' + a.laterality, ''])
      if (a.change) chips.push(['变化：' + a.change, ''])
      if (e.size) chips.push(['尺寸：' + e.size.text + (e.size.unit === 'cm' ? ' (' + e.size.mm + 'mm)' : ''), ''])
      if (!chips.length) return null
      return h('div', null, chips.map((c, i) => h('span', { key: i, className: 'ctn-chip ' + c[1] }, c[0])))
    }

    function EntityCard(props) {
      const e = props.entity
      return h('div', { className: 'ctn-card' },
        h('div', { className: 'ctn-card-h' },
          h('span', { className: 'ctn-surface' }, '「' + e.surface + '」'),
          h('span', { className: 'ctn-arrow' }, '→'),
          e.concepts.map((c, i) => h('span', { key: c.ui },
            i > 0 ? h('span', { className: 'ctn-arrow' }, ' ＋ ') : null,
            h('span', { className: 'ctn-concept' }, c.name),
            h('span', { className: 'ctn-mesh' }, ' mesh:' + c.ui + (c.tree ? ' · ' + String(c.tree).split(',')[0] : '')),
          )),
        ),
        h('div', { className: 'ctn-meta' },
          '部位：' + (e.sites && e.sites.length
            ? e.sites.map((s) => s.name + (s.approx ? '(近似)' : '')).join(' / ')
            : '—') +
          '｜词条：' + e.entryId +
          '｜来源：' + (e.match === 'composition' ? '部位+形态学词规则组合' : '词表直接命中')),
        h(Chips, { entity: e }),
        e.concepts.filter((c) => c.def).map((c) => h('div', { key: 'd' + c.ui, className: 'ctn-def' }, c.name + '：' + c.def)),
        e.ambiguity ? h('div', { className: 'ctn-note' }, '⚠ ' + e.ambiguity.question) : null,
        (e.caveats || []).map((cv, i) => h('div', { key: 'c' + i, className: 'ctn-note' }, '⚠ ' + cv)),
      )
    }

    function UnmappedCard(props) {
      const u = props.item
      return h('div', { className: u.attrs && u.attrs.negated ? 'ctn-danger' : 'ctn-unmapped' },
        h('div', null,
          h('span', { className: 'ctn-surface' }, '「' + u.surface + '」'),
          u.site ? h('span', { className: 'ctn-meta' }, ' 部位：' + u.site.name) : null,
          u.attrs && u.attrs.negated ? h('span', { className: 'ctn-chip ctn-chip-neg' }, '否定') : null,
          u.attrs && u.attrs.uncertain ? h('span', { className: 'ctn-chip ctn-chip-warn' }, '可疑') : null,
        ),
        h('div', { className: 'ctn-meta' }, u.reason),
      )
    }

    function ResultView(props) {
      const r = props.result
      const meta = props.meta || {}
      const s = r.stats || {}
      const agg = React.useMemo(() => aggregate(r), [r])
      return h('div', null,
        h('div', { className: 'ctn-card' },
          h('div', { className: 'ctn-meta' },
            '词表 ' + (meta.version || '?') + '：' + (meta.entries || '?') + ' 条条目 / ' + (meta.aliases || '?') +
            ' 个表面写法 / ' + (meta.concepts || '?') + ' 个 MeSH 概念；词表基于 MeSH ' + (meta.meshRelease || '?')),
          h('div', { className: 'ctn-meta' },
            '原文 ' + s.chars + ' 字，切分 ' + s.sentences + ' 句 / ' + s.clauses + ' 小句；命中 ' + s.entities +
            ' 个实体（' + s.concepts + ' 个 MeSH 概念），未归一化 ' + s.unmapped + ' 处，仅识别到部位 ' + s.orphanSites + ' 处。'),
          h('div', { className: 'ctn-meta' },
            '属性：否定 ' + s.negated + '、可疑 ' + s.uncertain + '、歧义 ' + s.ambiguous + '。'),
          h('div', { className: 'ctn-legend' },
            '注：侧别/程度/数量/变化 取自实体所在的小句，不保证每个词都直接修饰该实体；请以原文为准复核。'),
        ),

        (r.integrityErrors && r.integrityErrors.length)
          ? h('div', { className: 'ctn-danger' },
              h('b', null, '完整性错误（构建产物可能损坏，请重跑 build-ct-lexicon.mjs）'),
              r.integrityErrors.map((x, i) => h('div', { key: i, className: 'ctn-meta' }, x)))
          : null,

        h('div', { className: 'ctn-sec' }, '一、归一化结果（' + r.entities.length + ' 条）'),
        r.entities.length === 0
          ? h('div', { className: 'ctn-empty' }, '无。原文里没有命中词表的写法——这不代表报告正常，只代表词表没收录这些写法。')
          : r.entities.map((e, i) => h(EntityCard, { key: i, entity: e })),

        h('div', { className: 'ctn-sec' }, '二、未归一化（' + r.unmapped.length + ' 处）'),
        r.unmapped.length === 0
          ? h('div', { className: 'ctn-empty' }, '无')
          : r.unmapped.map((u, i) => h(UnmappedCard, { key: i, item: u })),
        r.unmapped.length
          ? h('div', { className: 'ctn-legend' },
              '这一栏是刻意保留的：MeSH 以疾病实体为粒度，磨玻璃影、毛刺、低密度灶这类影像描述性征象在 MeSH 里没有对应概念，硬映射只会造出看着规范、实则错误的编码。')
          : null,

        h('div', { className: 'ctn-sec' }, '三、概念汇总（按 MeSH 编号去重，' + agg.length + ' 个）'),
        agg.length === 0
          ? h('div', { className: 'ctn-empty' }, '无')
          : agg.map((c) => h('div', { key: c.ui, className: 'ctn-meta' },
              '· ' + c.name + '（mesh:' + c.ui + (c.tree ? '，' + String(c.tree).split(',')[0] : '') + '）出现 ' + c.count + ' 次' +
              (c.negated ? '（否定 ' + c.negated + '）' : '') + (c.uncertain ? '（可疑 ' + c.uncertain + '）' : ''))),

        h('div', { className: 'ctn-sec' }, '四、仅识别到部位、未绑定病变（' + r.sites.length + ' 处）'),
        r.sites.length === 0
          ? h('div', { className: 'ctn-empty' }, '无')
          : r.sites.map((x, i) => h('div', { key: i, className: 'ctn-meta' },
              '· 「' + x.surface + '」→ ' + x.name + '（mesh:' + x.ui + (x.approx ? '，近似' : '') + '）')),

        props.report ? h('pre', { className: 'ctn-pre' }, props.report) : null,
      )
    }

    function aggregate(r) {
      const map = new Map()
      for (const e of r.entities || []) {
        for (const c of e.concepts || []) {
          if (!map.has(c.ui)) map.set(c.ui, { ui: c.ui, name: c.name, tree: c.tree, count: 0, negated: 0, uncertain: 0 })
          const t = map.get(c.ui)
          t.count += 1
          if (e.attrs && e.attrs.negated) t.negated += 1
          if (e.attrs && e.attrs.uncertain) t.uncertain += 1
        }
      }
      return [...map.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    }

    // 纯函数形式的报告文本，供导出/复制（与 host 半的 renderReport 同结构，便于无浏览器环境下测试）
    function resultToText(result, meta) {
      const lines = []
      const s = result.stats || {}
      lines.push('CT 报告实体归一化（dsh-ct-norm ' + (meta.version || '?') + '；MeSH ' + (meta.meshRelease || '?') + '）')
      lines.push('命中 ' + s.entities + ' 个实体（' + s.concepts + ' 个 MeSH 概念），未归一化 ' + s.unmapped + ' 处。')
      lines.push('')
      ;(result.entities || []).forEach((e, i) => {
        lines.push((i + 1) + '. 「' + e.surface + '」→ ' + e.concepts.map((c) => c.name + '（mesh:' + c.ui + '）').join(' ＋ '))
        const bits = []
        if (e.sites && e.sites.length) bits.push('部位：' + e.sites.map((x) => x.name).join('/'))
        if (e.attrs && e.attrs.negated) bits.push('否定')
        if (e.attrs && e.attrs.uncertain) bits.push('可疑')
        if (e.attrs && e.attrs.laterality) bits.push('侧别：' + e.attrs.laterality)
        if (e.size) bits.push('尺寸：' + e.size.text)
        if (bits.length) lines.push('   ' + bits.join('｜'))
        if (e.ambiguity) lines.push('   ⚠ ' + e.ambiguity.question)
      })
      lines.push('')
      lines.push('未归一化（' + (result.unmapped || []).length + ' 处）：')
      ;(result.unmapped || []).forEach((u) => lines.push('- 「' + u.surface + '」—— ' + u.reason))
      return lines.join('\n')
    }

    // ---------------------------------------------------------------------
    // 归一化面板
    // ---------------------------------------------------------------------
    function NormalizePanel() {
      const [text, setText] = React.useState('')
      const [out, setOut] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState(null)
      const [info, setInfo] = React.useState(null)

      const run = async () => {
        if (!text.trim()) { setErr('请先粘贴 CT 报告原文。'); return }
        setBusy(true); setErr(null); setInfo(null)
        try {
          const r = await rpc('normalize', { text })
          if (!r.ok) { setErr(r.error || '归一化失败'); setOut(null) }
          else setOut(r)
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      const copy = async () => {
        if (!out) return
        const t = resultToText(out.result, out.meta)
        try {
          await navigator.clipboard.writeText(t)
          setInfo('已复制精简结果到剪贴板。')
        } catch {
          setErr('剪贴板不可用（浏览器可能未授权），请改用「导出 TXT」。')
        }
      }

      const doExport = async () => {
        if (!out) return
        setErr(null); setInfo(null)
        try {
          const r = await rpc('export', { text: out.report, name: 'ct-norm-report.txt' })
          if (!r.ok) setErr(r.error || '导出失败')
          else setInfo('已写入：' + r.path)
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
      }

      return h('div', null,
        h('div', { className: 'ctn-row' },
          h('button', { className: 'ctn-btn ctn-btn-primary', onClick: run, disabled: busy },
            busy ? '归一化中…' : '归一化'),
          h('button', { className: 'ctn-btn', onClick: () => { setText(SAMPLE); setOut(null); setErr(null) } }, '填入示例报告'),
          h('button', { className: 'ctn-btn', onClick: () => { setText(''); setOut(null); setErr(null); setInfo(null) } }, '清空'),
          out ? h('button', { className: 'ctn-btn', onClick: copy }, '复制精简结果') : null,
          out ? h('button', { className: 'ctn-btn', onClick: doExport }, '导出 TXT') : null,
        ),
        h('textarea', {
          className: 'ctn-textarea',
          placeholder: '把 CT 报告原文整段粘贴到这里（含「检查所见」「诊断意见」也可），然后点「归一化」。',
          value: text,
          onChange: (ev) => setText(ev.target.value),
        }),
        err ? h('div', { className: 'ctn-danger' }, err) : null,
        info ? h('div', { className: 'ctn-meta' }, info) : null,
        out ? h(ResultView, { result: out.result, meta: out.meta, report: out.report }) : null,
      )
    }

    // ---------------------------------------------------------------------
    // 词表面板
    // ---------------------------------------------------------------------
    function EntryRow(props) {
      const e = props.entry
      const approx = new Set(Array.isArray(e.approx) ? e.approx : [])
      const mark = (a) => (approx.has(a) ? a + '*' : a)
      return h('div', { className: 'ctn-card' },
        h('div', { className: 'ctn-card-h' },
          h('span', { className: 'ctn-concept' }, e.mesh ? e.mesh.name : '(无 MeSH 概念)'),
          e.mesh ? h('span', { className: 'ctn-mesh' }, ' mesh:' + e.mesh.ui + (e.mesh.tree ? ' · ' + String(e.mesh.tree).split(',')[0] : '')) : null,
          h('span', { className: 'ctn-chip' }, KIND_LABEL[e.kind] || e.kind),
          e.action ? h('span', { className: 'ctn-chip ctn-chip-warn' }, '组合规则：' + e.action) : null,
        ),
        h('div', { className: 'ctn-meta' }, '条目 ' + e.id + (e.region ? '｜区域 ' + e.region : '')),
        h('div', { className: 'ctn-meta' }, '中文写法：' + (e.zh || []).map(mark).join('、')),
        (e.en && e.en.length) ? h('div', { className: 'ctn-meta' }, '英文写法：' + e.en.map(mark).join('、')) : null,
        e.neoplasm ? h('div', { className: 'ctn-meta' }, '该部位肿瘤概念：' + e.neoplasm.name + '（mesh:' + e.neoplasm.ui + '）') : null,
        e.note ? h('div', { className: 'ctn-def' }, e.note) : null,
        props.via ? h('div', { className: 'ctn-legend' }, '命中方式：' + props.via) : null,
      )
    }

    function LexiconPanel() {
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [hits, setHits] = React.useState([])
      const [meta, setMeta] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [unmapped, setUnmapped] = React.useState(null)
      const [err, setErr] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        rpc('stats', {}).then((r) => {
          if (!alive) return
          if (r.ok) setStats(r)
          else setErr(r.error)
        }).catch((e) => { if (alive) setErr(String((e && e.message) || e)) })
        return () => { alive = false }
      }, [])

      const search = async () => {
        setErr(null)
        try {
          const r = await rpc('lexicon', { q, kind: kind || undefined, limit: 50 })
          if (!r.ok) setErr(r.error || '检索失败')
          else { setHits(r.hits || []); setMeta(r.meta) }
        } catch (e) { setErr(String((e && e.message) || e)) }
      }

      const showUnmapped = () => {
        setUnmapped(stats && stats.unmapped ? stats.unmapped : [])
      }

      return h('div', null,
        h('div', { className: 'ctn-row' },
          h('input', {
            className: 'ctn-input',
            style: { minWidth: '220px' },
            placeholder: '写法 / MeSH 规范名 / D010996 / 条目 id',
            value: q,
            onChange: (ev) => setQ(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') search() },
          }),
          h('select', { className: 'ctn-select', value: kind, onChange: (ev) => setKind(ev.target.value) },
            h('option', { value: '' }, '全部类别'),
            KINDS.map(([k, l]) => h('option', { key: k, value: k }, l))),
          h('button', { className: 'ctn-btn ctn-btn-primary', onClick: search }, '检索'),
          h('button', { className: 'ctn-btn', onClick: showUnmapped }, '未归一化征象词表'),
        ),
        stats ? h('div', { className: 'ctn-meta' },
          '词表 ' + (stats.meta.version || '?') + '：' + (stats.meta.entries || '?') + ' 条条目 / ' +
          (stats.meta.aliases || '?') + ' 个表面写法 / ' + (stats.meshConcepts || '?') + ' 个 MeSH 概念；' +
          Object.entries(stats.byKind || {}).map(([k, v]) => (KIND_LABEL[k] || k) + ' ' + v).join('，')) : null,
        err ? h('div', { className: 'ctn-danger' }, err) : null,

        unmapped ? h('div', null,
          h('div', { className: 'ctn-sec' }, '未归一化征象词表（' + unmapped.length + ' 组）'),
          h('div', { className: 'ctn-legend' },
            '这些写法在 MeSH 主题词表里**没有**对应概念（MeSH 以疾病实体为粒度，不收录影像征象）。ct_norm 会把它们如实报进「未归一化」栏，而不是硬塞一个编号。'),
          unmapped.map((t, i) => h('div', { key: i, className: 'ctn-unmapped' },
            h('div', null, h('span', { className: 'ctn-surface' }, t.term),
              h('span', { className: 'ctn-meta' }, '（词表写法：' + (t.aliases || []).join('、') + '）')),
            h('div', { className: 'ctn-meta' }, t.reason))),
        ) : null,

        hits.length ? h('div', null,
          h('div', { className: 'ctn-sec' }, '词表条目（' + hits.length + ' 条）'),
          h('div', { className: 'ctn-legend' }, '带 * 的写法是**近似映射**（外延与 MeSH 概念不完全一致）。'),
          hits.map((e, i) => h(EntryRow, { key: e.id + i, entry: e, via: e.via })),
        ) : null,
      )
    }

    // ---------------------------------------------------------------------
    // 外壳
    // ---------------------------------------------------------------------
    function Panel() {
      const [tab, setTab] = React.useState('norm')
      return h('div', { className: 'ctn-wrap' },
        h('div', { className: 'ctn-title' }, 'CT 报告实体归一化'),
        h('div', { className: 'ctn-sub' },
          '把中文 CT 报告里的自由描述映射到 MeSH 标准概念。本地词表 + MeSH 子集，全程离线、不做推断；' +
          '未收录的写法单列一栏，不硬映射。'),
        h('div', { className: 'ctn-tabs' },
          h('button', { className: 'ctn-tab', 'data-on': tab === 'norm' ? '1' : '0', onClick: () => setTab('norm') }, '归一化'),
          h('button', { className: 'ctn-tab', 'data-on': tab === 'lex' ? '1' : '0', onClick: () => setTab('lex') }, '词表'),
        ),
        tab === 'norm' ? h(NormalizePanel, null) : h(LexiconPanel, null),
      )
    }

    function PanelSafe() { return h(Boundary, null, h(Panel, null)) }

    function PanelIcon() {
      const [failed, setFailed] = React.useState(false)
      return h('button', {
        className: 'ctn-icon',
        title: 'CT 报告归一化',
        'aria-label': 'CT 报告归一化',
        onClick: () => {
          try { if (ctxRef && ctxRef.layout) ctxRef.layout.selectPanel(PANEL_KEY) } catch { /* ignore */ }
        },
      }, failed
        ? h('span', { className: 'ctn-icon-text' }, 'CT')
        : h('img', {
            className: 'ctn-icon-img',
            src: ICON_URL,
            alt: 'CT 归一化',
            draggable: false,
            onError: () => setFailed(true),
          }))
    }

    exports.inject = ['slots', 'layout']

    exports.apply = (ctx) => {
      ctxRef = ctx
      ensureCss()
      ctx.effect(
        () => ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, PanelSafe)),
        'ct-norm: main panel',
      )
      ctx.effect(
        () => ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 46, label: 'CT 归一化' },
            PanelIcon,
          )),
        'ct-norm: sidebar entry',
      )
    }

    // 冒烟测试钩子：让测试能在没有浏览器与 react-dom 的情况下直接渲染这些组件。
    exports.__test = { Panel, NormalizePanel, LexiconPanel, ResultView, Boundary, resultToText, aggregate }

    return module.exports
  },
})
