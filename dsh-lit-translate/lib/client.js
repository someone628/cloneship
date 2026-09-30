// dsh-lit-translate —— 浏览器半（手写的 DSH client 模块）
//
// 模块协议：window.__ModuleLoader__.load({ id, factory })，
// factory 内用 require("react") 取 React，导出 apply / inject。
//
// 这一半是从 dsh-literature-reading 的阅读工作台里把翻译界面抠出来重做的：
// 去掉了 PDF 导入、版式渲染、文献卡片、思维导图、勾划篮，只留下翻译这一条链路——
// 粘贴/导入文本 → 切段 → 逐段翻译（带上一段作上文参考）→ 对照阅读 → 导出。
//
// 与 host 半的通信走同源 HTTP：POST /dsh-lit-translate/rpc { op, args }。
// 切段在浏览器本地做（纯函数，不烧 token），host 半也有一份同源实现用于校验，
// 两边必须保持一致——改动时一起改，测试里有对同一份样本的断言。
window.__ModuleLoader__.load({
  id: 'dsh-lit-translate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const RPC = '/dsh-lit-translate/rpc'
    const PANEL_KEY = 'lit-translate'
    const LS_KEY = 'dsh-lit-translate/doc-v1'
    /** 上文参考只取上一段末尾这么多字符：整段带上会让每次请求都白白多烧 token */
    const CONTEXT_TAIL = 1600

    /** 工厂作用域的 ctx（apply 时注入），供侧边栏图标点击时切换栏目 */
    let ctxRef = null
    /** 批量翻译的中止标志。面板同时只会跑一个批次，用工厂作用域变量即可，不必上 useRef。 */
    let abortFlag = false
    /** host 路由探活结果：false 时保存/读取直接走 localStorage，避免每次保存都发一次必失败的请求 */
    let hostOk = false

    async function rpc(op, args) {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: args || {} }),
      })
      return await res.json()
    }

    function errText(error) {
      if (error === null || error === undefined) return 'unknown'
      if (typeof error === 'string') return error
      return String(error.message || error)
    }

    // ----------------------------------------------------------------------
    // 纯函数（导出到 __test，测试直接断言）
    // ----------------------------------------------------------------------

    function uid(prefix) {
      return (prefix || 's') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }

    /** 按空行优先、超长按句子切、相邻碎块合并的方式切成可翻译的段（与 host 半同源） */
    function splitSegments(text) {
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

    /**
     * 切段，并尽量把已译内容带过去：
     * 重新切段（改了原文、或换了一次切法）时，原文完全一致的段直接沿用旧译文，
     * 免得用户改一个字就丢掉整篇的翻译成果。
     */
    function makeSegments(text, old) {
      const keep = new Map()
      const oldList = Array.isArray(old) ? old : []
      for (const seg of oldList) {
        if (seg && typeof seg.en === 'string' && typeof seg.zh === 'string' && seg.zh.length > 0) {
          keep.set(seg.en.trim(), seg.zh)
        }
      }
      return splitSegments(text).map((en) => {
        const zh = keep.get(en)
        return zh ? { id: uid(), en, zh } : { id: uid(), en, zh: '' }
      })
    }

    /** 第 index 段的上文参考：上一段原文 + 上一段译文（若已译），只留末尾一段 */
    function buildContext(segs, index) {
      if (!Array.isArray(segs) || index <= 0 || index >= segs.length) return ''
      const prev = segs[index - 1]
      if (!prev) return ''
      let out = typeof prev.en === 'string' ? prev.en : ''
      if (typeof prev.zh === 'string' && prev.zh.trim().length > 0) {
        out += '\n\n（上一段的中文译文）\n' + prev.zh
      }
      return out.slice(-CONTEXT_TAIL)
    }

    function segStats(segs) {
      const list = Array.isArray(segs) ? segs : []
      let done = 0
      let chars = 0
      let translatedChars = 0
      for (const seg of list) {
        const en = seg && typeof seg.en === 'string' ? seg.en : ''
        const zh = seg && typeof seg.zh === 'string' ? seg.zh : ''
        chars += en.length
        if (zh.length > 0) {
          done++
          translatedChars += zh.length
        }
      }
      return { total: list.length, done, pending: list.length - done, chars, translatedChars }
    }

    /** 工作稿 → Markdown。mode='pair' 原文/译文对照，mode='zh' 只要译文 */
    function toMarkdown(doc, mode) {
      const segs = doc && Array.isArray(doc.segments) ? doc.segments : []
      const lines = ['# 文献翻译（机器译文）', '']
      lines.push(
        '> 由 DSH 默认模型翻译，' +
          (doc && doc.annotate === false ? '未附英文术语原文。' : '术语首次出现时附英文原文。') +
          '仅供文献阅读参考，正式引用或做判断前请核对英文原文。',
      )
      lines.push('')
      segs.forEach((seg, i) => {
        lines.push('## 第 ' + (i + 1) + ' 段')
        lines.push('')
        if (mode !== 'zh') {
          lines.push('**原文**')
          lines.push('')
          lines.push(seg.en || '')
          lines.push('')
          lines.push('**译文**')
          lines.push('')
        }
        lines.push(seg.zh && seg.zh.length > 0 ? seg.zh : '（未翻译）')
        lines.push('')
      })
      return lines.join('\n')
    }

    /** 导出文件名：带时间戳，多次导出不会互相覆盖 */
    function exportName(kind, ext) {
      const d = new Date()
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      const stamp =
        d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes())
      return '文献翻译-' + kind + '-' + stamp + '.' + ext
    }

    function downloadText(name, text) {
      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        return true
      } catch {
        return false
      }
    }

    /** 复制到剪贴板：优先异步 API，失败时退回 textarea + execCommand */
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 落到下面的兜底 */
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }

    // ----------------------------------------------------------------------
    // 样式
    // ----------------------------------------------------------------------
    // 配色沿用 onco-lexicon 踩坑后的做法：DSH 主题暴露的变量前缀是 `--dsw-alias-*`
    // （不是 `--dsh-*`），所以显式配色 + 主题变量兜底，避免浅色主题下文字看不见。
    // 强调色取青蓝系，和术语词典的紫色区分开，一眼能认出是哪个面板。
    const CSS = `
.lt-wrap{
  --lt-ink:#0f172a;        /* 标题：最深 */
  --lt-ink-2:#1e293b;      /* 正文 */
  --lt-ink-3:#475569;      /* 次级文字 */
  --lt-accent:#0e7490;     /* 选中 / 主按钮 */
  --lt-line:var(--dsw-alias-border-l2,#cbd5e1);
  --lt-soft:var(--dsw-alias-bg-layer-1,#f8fafc);
  --lt-field:#ffffff;
  display:flex;flex-direction:column;height:100%;min-height:0;padding:14px 16px;gap:9px;
  font-size:13px;box-sizing:border-box;color:var(--lt-ink-2)}
@media (prefers-color-scheme: dark){
  .lt-wrap{
    --lt-ink:#ecfeff;
    --lt-ink-2:#cffafe;
    --lt-ink-3:#a5f3fc;
    --lt-accent:#0891b2;
    --lt-line:var(--dsw-alias-border-l2,rgba(165,243,252,.28));
    --lt-soft:var(--dsw-alias-bg-layer-1,rgba(8,145,178,.12));
    --lt-field:rgba(255,255,255,.06)}
}
.lt-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.lt-h1{font-size:14px;font-weight:600;color:var(--lt-ink)}
.lt-small{font-size:11.5px;line-height:1.6;color:var(--lt-ink-3)}
.lt-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.lt-btn{padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12.5px;font-weight:500;
  border:1px solid var(--lt-line);background:transparent;color:var(--lt-ink-2)}
.lt-btn:hover:not(:disabled){background:rgba(14,116,144,.10);border-color:var(--lt-accent)}
.lt-btn:disabled{opacity:.5;cursor:default}
.lt-btn-primary{background:var(--lt-accent);border-color:var(--lt-accent);color:#fff}
.lt-btn-primary:hover:not(:disabled){background:#155e75;border-color:#155e75}
.lt-btn-mini{padding:2px 8px;font-size:11px;border-radius:99px}
.lt-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--lt-ink-2);cursor:pointer;
  user-select:none}
.lt-ta{width:100%;min-height:96px;max-height:230px;resize:vertical;padding:8px 10px;border-radius:6px;
  border:1px solid var(--lt-line);background:var(--lt-field);color:var(--lt-ink);
  font-size:12.5px;line-height:1.65;font-family:inherit;outline:none;box-sizing:border-box}
.lt-ta::placeholder{color:var(--lt-ink-3);opacity:.7}
.lt-ta:focus{border-color:var(--lt-accent);box-shadow:0 0 0 2px rgba(14,116,144,.18)}
.lt-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11.5px;color:var(--lt-ink-3)}
.lt-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.lt-seg{border:1px solid var(--lt-line);border-radius:8px;padding:9px 11px;background:var(--lt-soft)}
.lt-seg.is-busy{border-color:var(--lt-accent);box-shadow:0 0 0 1px rgba(14,116,144,.25)}
.lt-seg.is-error{border-color:#dc2626}
.lt-seg-h{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px}
.lt-idx{font-size:11px;font-weight:600;color:var(--lt-ink);background:rgba(14,116,144,.14);
  border:1px solid rgba(14,116,144,.34);border-radius:99px;padding:1px 7px}
.lt-chip{font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--lt-line);color:var(--lt-ink-3)}
.lt-chip.is-done{color:var(--lt-ink);background:rgba(14,116,144,.14);border-color:rgba(14,116,144,.34)}
.lt-chip.is-warn{color:#b45309;border-color:rgba(180,83,9,.45);background:rgba(180,83,9,.10)}
.lt-spacer{flex:1}
.lt-en{font-size:12px;line-height:1.7;color:var(--lt-ink-3);white-space:pre-wrap;word-break:break-word;
  cursor:pointer;border-left:2px solid rgba(14,116,144,.28);padding-left:8px}
.lt-en.is-closed{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lt-zh{font-size:12.5px;line-height:1.8;color:var(--lt-ink);white-space:pre-wrap;word-break:break-word;margin-top:7px}
.lt-none{font-size:12px;color:var(--lt-ink-3);font-style:italic;margin-top:7px}
.lt-err{font-size:12px;line-height:1.6;color:#b91c1c;margin-top:7px;word-break:break-word}
.lt-notice{font-size:12px;line-height:1.55;padding:6px 9px;border-radius:6px;word-break:break-word;
  color:var(--lt-ink);background:rgba(14,116,144,.10);border:1px solid rgba(14,116,144,.30)}
.lt-bad{font-size:12px;line-height:1.55;padding:6px 9px;border-radius:6px;word-break:break-word;
  color:#b91c1c;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.32)}
.lt-empty{font-size:12px;color:var(--lt-ink-3);line-height:1.7}
.lt-icon{display:flex;align-items:center;justify-content:center;width:100%;height:100%;
  background:transparent;border:0;cursor:pointer;color:var(--lt-ink-3,#64748b);font-size:12px;font-weight:600}
.lt-icon:hover{color:var(--lt-accent,#0e7490)}
.lt-icon-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  border-radius:6px;border:1px solid rgba(14,116,144,.45);background:rgba(14,116,144,.14);
  color:var(--lt-accent,#0e7490);font-size:12px;font-weight:700;line-height:1}
`

    function ensureCss() {
      try {
        if (document.getElementById('lit-translate-css')) return
        const el = document.createElement('style')
        el.id = 'lit-translate-css'
        el.textContent = CSS
        document.head.appendChild(el)
      } catch {
        /* 没有 document（测试环境）就跳过 */
      }
    }

    // ----------------------------------------------------------------------
    // 组件
    // ----------------------------------------------------------------------

    /** 面板自己的错误不该连累整个界面：兜住并记录，其余界面照常 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try {
          console.error('[dsh-lit-translate] panel failed:', error)
        } catch {
          /* ignore */
        }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'lt-wrap' },
            h('div', { className: 'lt-bad' }, '文献翻译面板出错：' + errText(this.state.error)),
            h('div', { className: 'lt-small' }, '插件其它部分不受影响；刷新页面可重试。'),
          )
        }
        return this.props.children
      }
    }

    function SegmentCard(props) {
      const seg = props.seg
      const index = props.index
      const zh = typeof seg.zh === 'string' ? seg.zh : ''
      const err = typeof seg.error === 'string' ? seg.error : ''
      const status = seg.busy === true ? '翻译中…' : err.length > 0 ? '失败' : zh.length > 0 ? '已译' : '未译'
      const chipClass = 'lt-chip' + (zh.length > 0 && err.length === 0 ? ' is-done' : '')
      const segClass = 'lt-seg' + (seg.busy === true ? ' is-busy' : '') + (err.length > 0 ? ' is-error' : '')
      const bits = [String((seg.en || '').length) + ' 字']
      if (zh.length > 0) bits.push('译文 ' + zh.length + ' 字')
      if (seg.model) bits.push(seg.model)
      return h(
        'div',
        { className: segClass },
        h(
          'div',
          { className: 'lt-seg-h' },
          h('span', { className: 'lt-idx' }, '第 ' + (index + 1) + ' 段'),
          h('span', { className: chipClass }, status),
          seg.warn === true ? h('span', { className: 'lt-chip is-warn', title: '译文在模型输出上限处被截断' }, '可能被截断') : null,
          h('span', { className: 'lt-small' }, bits.join(' · ')),
          h('span', { className: 'lt-spacer' }),
          zh.length > 0
            ? h(
                'button',
                { className: 'lt-btn lt-btn-mini', title: '复制本段译文', onClick: () => props.onCopy(index) },
                '复制',
              )
            : null,
          h(
            'button',
            {
              className: 'lt-btn lt-btn-mini',
              disabled: props.busy === true || (seg.en || '').trim().length === 0,
              title: zh.length > 0 ? '重新翻译这一段（会覆盖现有译文）' : '翻译这一段',
              onClick: () => props.onTranslate(index),
            },
            zh.length > 0 ? '重译' : '翻译',
          ),
          h(
            'button',
            {
              className: 'lt-btn lt-btn-mini',
              title: seg.open === true ? '收起原文' : '展开原文',
              onClick: () => props.onToggle(index),
            },
            seg.open === true ? '收起' : '原文',
          ),
        ),
        h(
          'div',
          {
            className: 'lt-en' + (seg.open === true ? '' : ' is-closed'),
            title: '点一下展开 / 收起原文',
            onClick: () => props.onToggle(index),
          },
          seg.en || '',
        ),
        err.length > 0 ? h('div', { className: 'lt-err' }, '翻译失败：' + err) : null,
        zh.length > 0
          ? h('div', { className: 'lt-zh' }, zh)
          : seg.busy === true
            ? h('div', { className: 'lt-none' }, '正在翻译…')
            : h('div', { className: 'lt-none' }, '（尚未翻译）'),
      )
    }

    function TranslatePanel() {
      const [src, setSrc] = React.useState('')
      /** 切段时用的原文快照：src 与它不一致说明「原文改了但还没重新切段」 */
      const [snapshot, setSnapshot] = React.useState('')
      const [segs, setSegs] = React.useState([])
      const [annotate, setAnnotate] = React.useState(true)
      const [useContext, setUseContext] = React.useState(true)
      const [view, setView] = React.useState('pair') // pair | zh
      const [busy, setBusy] = React.useState(false)
      const [prog, setProg] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [info, setInfo] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)

      const stale = snapshot.length > 0 && src !== snapshot

      // 启动：探活 + 恢复上次的工作稿（host 数据目录优先，读不到再用浏览器本地）
      React.useEffect(() => {
        let alive = true
        const boot = async () => {
          let ping = null
          try {
            ping = await rpc('ping')
          } catch (error) {
            ping = { ok: false, error: '连不上插件后端：' + errText(error) }
          }
          if (!alive) return
          hostOk = !!(ping && ping.ok === true)
          setInfo(ping && ping.ok === true ? ping : null)
          if (!hostOk) {
            setErr('连不上插件后端（' + ((ping && ping.error) || 'unknown') + '）：翻译不可用，界面与导出仍可用。')
          } else if (ping.model === null) {
            setErr('没有可用的默认模型（' + (ping.modelError || 'unknown') + '）：请在 DSH 里配置模型后再翻译。')
          }

          let doc = null
          let from = ''
          if (hostOk) {
            try {
              const res = await rpc('load')
              if (res && res.ok === true && res.doc) {
                doc = res.doc
                from = '数据目录'
              }
            } catch {
              /* 退到 localStorage */
            }
          }
          if (!doc) {
            try {
              const raw = window.localStorage.getItem(LS_KEY)
              if (raw) {
                doc = JSON.parse(raw)
                from = '浏览器本地'
              }
            } catch {
              /* 没有就算了 */
            }
          }
          if (!alive) return
          if (doc && typeof doc === 'object') {
            setSrc(typeof doc.source === 'string' ? doc.source : '')
            setSnapshot(typeof doc.snapshot === 'string' ? doc.snapshot : '')
            setSegs(Array.isArray(doc.segments) ? doc.segments : [])
            setAnnotate(doc.annotate !== false)
            setUseContext(doc.useContext !== false)
            setMsg('已恢复上次的工作稿（' + from + '）')
          }
          setLoaded(true)
        }
        void boot()
        return () => {
          alive = false
        }
      }, [])

      // 自动保存：改动停下 900ms 再写，避免每敲一个字都落一次盘
      React.useEffect(() => {
        if (!loaded) return undefined
        const doc = {
          source: src,
          snapshot,
          annotate,
          useContext,
          updatedAt: Date.now(),
          segments: segs.map((s) => ({
            id: s.id,
            en: s.en,
            zh: s.zh || '',
            open: s.open === true,
            warn: s.warn === true,
          })),
        }
        const timer = setTimeout(async () => {
          if (hostOk) {
            try {
              const res = await rpc('save', { doc })
              if (res && res.ok === true) return
            } catch {
              /* 落到 localStorage */
            }
          }
          try {
            window.localStorage.setItem(LS_KEY, JSON.stringify(doc))
          } catch {
            /* 存不下就算了：不影响当前会话里的内容 */
          }
        }, 900)
        return () => clearTimeout(timer)
      }, [src, snapshot, segs, annotate, useContext, loaded])

      function patchSegs(next, note) {
        setSegs(next)
        if (note) setMsg(note)
      }

      function doSplit(text) {
        const next = makeSegments(text, segs)
        const kept = next.filter((s) => s.zh && s.zh.length > 0).length
        setSnapshot(text)
        patchSegs(
          next,
          next.length === 0
            ? '没有切出任何段落：先粘贴或导入原文'
            : '已切成 ' + next.length + ' 段' + (kept > 0 ? '（沿用 ' + kept + ' 段已有译文）' : ''),
        )
        return next
      }

      async function translateAt(index) {
        const seg = segs[index]
        if (!seg) return
        if (!seg.en || seg.en.trim().length === 0) {
          setErr('第 ' + (index + 1) + ' 段是空的')
          return
        }
        setErr('')
        setBusy(true)
        setProg({ done: 0, total: 1 })
        let working = segs.map((s, i) => (i === index ? Object.assign({}, s, { busy: true, error: '' }) : s))
        setSegs(working)
        const context = useContext ? buildContext(working, index) : ''
        let res = null
        try {
          res = await rpc('translate', { text: seg.en, annotate, context })
        } catch (error) {
          res = { ok: false, error: errText(error) }
        }
        setBusy(false)
        setProg(null)
        if (!res || res.ok !== true) {
          const message = (res && res.error) || 'unknown'
          setSegs(working.map((s, i) => (i === index ? Object.assign({}, s, { busy: false, error: message }) : s)))
          setErr('翻译失败（第 ' + (index + 1) + ' 段）：' + message)
          return
        }
        setSegs(
          working.map((s, i) =>
            i === index
              ? Object.assign({}, s, {
                  busy: false,
                  error: '',
                  zh: res.text,
                  warn: res.truncated === true,
                  model: (res.provider || '?') + '/' + (res.model || '?'),
                })
              : s,
          ),
        )
        setMsg('第 ' + (index + 1) + ' 段翻译完成' + (res.truncated === true ? '（译文可能被截断，建议切小一段重译）' : ''))
      }

      /** 批量翻译：mode='pending' 只翻未译的段，mode='all' 全部重译 */
      async function runBatch(mode) {
        let list = segs
        if (list.length === 0) {
          if (src.trim().length === 0) {
            setErr('原文是空的：先粘贴文献正文，或点「导入 txt / md」')
            return
          }
          list = doSplit(src)
          if (list.length === 0) return
        }
        const targets = []
        list.forEach((s, i) => {
          const hasZh = typeof s.zh === 'string' && s.zh.length > 0
          if (mode === 'all' || !hasZh) targets.push(i)
        })
        if (targets.length === 0) {
          setMsg('所有段落都已翻译（想重来一遍用「全部重译」）')
          return
        }
        abortFlag = false
        setErr('')
        setMsg('')
        setBusy(true)
        setProg({ done: 0, total: targets.length })
        let working = list.slice()
        let done = 0
        let stopped = false
        for (const index of targets) {
          if (abortFlag) {
            stopped = true
            break
          }
          const seg = working[index]
          if (!seg || (seg.en || '').trim().length === 0) continue
          working = working.map((s, i) => (i === index ? Object.assign({}, s, { busy: true, error: '' }) : s))
          setSegs(working)
          const context = useContext ? buildContext(working, index) : ''
          let res = null
          try {
            res = await rpc('translate', { text: seg.en, annotate, context })
          } catch (error) {
            res = { ok: false, error: errText(error) }
          }
          if (!res || res.ok !== true) {
            const message = (res && res.error) || 'unknown'
            working = working.map((s, i) => (i === index ? Object.assign({}, s, { busy: false, error: message }) : s))
            setSegs(working)
            setProg(null)
            setBusy(false)
            setErr('翻译失败（第 ' + (index + 1) + ' 段，已翻 ' + done + ' 段）：' + message)
            return
          }
          done++
          working = working.map((s, i) =>
            i === index
              ? Object.assign({}, s, {
                  busy: false,
                  error: '',
                  zh: res.text,
                  warn: res.truncated === true,
                  model: (res.provider || '?') + '/' + (res.model || '?'),
                })
              : s,
          )
          setSegs(working)
          setProg({ done, total: targets.length })
        }
        setProg(null)
        setBusy(false)
        setMsg(stopped ? '已停止：本次翻完 ' + done + ' / ' + targets.length + ' 段' : '翻译完成：' + done + ' 段')
      }

      function stop() {
        abortFlag = true
        setMsg('正在停止…（当前这一段翻完就停）')
      }

      async function onCopyAll() {
        const st = segStats(segs)
        if (st.done === 0) {
          setErr('还没有任何译文可复制')
          return
        }
        const ok = await copyText(segs.map((s) => s.zh || '').filter((t) => t.length > 0).join('\n\n'))
        setMsg(ok ? '已复制 ' + st.done + ' 段译文' : '复制失败：浏览器不允许访问剪贴板，请改用「导出」')
      }

      async function onCopyOne(index) {
        const seg = segs[index]
        if (!seg || !seg.zh) return
        const ok = await copyText(seg.zh)
        setMsg(ok ? '已复制第 ' + (index + 1) + ' 段译文' : '复制失败：浏览器不允许访问剪贴板，请改用「导出」')
      }

      function onExport(mode) {
        const st = segStats(segs)
        if (st.done === 0) {
          setErr('还没有任何译文可导出')
          return
        }
        const text = toMarkdown({ segments: segs, annotate }, mode)
        const ok = downloadText(exportName(mode === 'zh' ? '译文' : '对照', 'md'), text)
        setMsg(ok ? '已开始下载导出文件' : '导出失败：浏览器拦下了下载')
      }

      function onImportFile(file) {
        if (!file) return
        setErr('')
        setMsg('正在读取 ' + (file.name || '文件') + ' …')
        const reader = new FileReader()
        reader.onerror = () => setErr('读取文件失败：' + errText(reader.error))
        reader.onload = () => {
          const text = String(reader.result === null || reader.result === undefined ? '' : reader.result)
          setSrc(text)
          const next = makeSegments(text, segs)
          setSnapshot(text)
          patchSegs(next, '已导入 ' + (file.name || '文件') + '，切成 ' + next.length + ' 段')
        }
        reader.readAsText(file, 'utf-8')
      }

      function onClear() {
        try {
          if (!window.confirm('清空原文与全部译文？此操作不可撤销。')) return
        } catch {
          /* 没有 confirm 就照清 */
        }
        setSrc('')
        setSnapshot('')
        setSegs([])
        setErr('')
        setMsg('已清空')
      }

      const st = segStats(segs)
      const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0
      const modelLine = info && info.model ? info.model.provider + ' / ' + info.model.model : '（未知模型）'

      return h(
        'div',
        { className: 'lt-wrap' },
        h(
          'div',
          { className: 'lt-head' },
          h('span', { className: 'lt-h1' }, '文献翻译'),
          h('span', { className: 'lt-small' }, '英译中 · 学术文献口径 · 由默认模型翻译'),
          h('span', { className: 'lt-spacer' }),
          h('span', { className: 'lt-small', title: info && info.dataFile ? '工作稿保存位置：' + info.dataFile : '' }, modelLine),
        ),

        h(
          'div',
          { className: 'lt-bar' },
          h(
            'label',
            { className: 'lt-btn', title: '导入 .txt / .md 文件（编码按 UTF-8 读）' },
            '导入 txt / md',
            h('input', {
              type: 'file',
              accept: '.txt,.md,.markdown,text/plain,text/markdown',
              style: { display: 'none' },
              onChange: (ev) => {
                const file = ev.target && ev.target.files ? ev.target.files[0] : null
                onImportFile(file)
                try {
                  ev.target.value = ''
                } catch {
                  /* ignore */
                }
              },
            }),
          ),
          h(
            'button',
            { className: 'lt-btn', disabled: busy, onClick: () => doSplit(src), title: '按空行切段，超长按句子切；原文一致的段会沿用已有译文' },
            '切段',
          ),
          h(
            'button',
            {
              className: 'lt-btn lt-btn-primary',
              disabled: busy,
              onClick: () => void runBatch('pending'),
              title: '只翻还没译的段；没切段时先自动切段',
            },
            busy ? '翻译中…' : '翻译未译段',
          ),
          h(
            'button',
            { className: 'lt-btn', disabled: busy || segs.length === 0, onClick: () => void runBatch('all'), title: '把所有段重译一遍（会覆盖现有译文）' },
            '全部重译',
          ),
          busy ? h('button', { className: 'lt-btn', onClick: stop }, '停止') : null,
        ),

        h(
          'div',
          { className: 'lt-bar' },
          h(
            'label',
            { className: 'lt-check', title: '开：术语首次出现写成「中文（English）」；关：纯中文译文' },
            h('input', {
              type: 'checkbox',
              checked: annotate,
              disabled: busy,
              onChange: (ev) => setAnnotate(!!(ev.target && ev.target.checked)),
            }),
            '术语附英文原文',
          ),
          h(
            'label',
            { className: 'lt-check', title: '把上一段原文（与其译文）作为上文参考，减少同一术语前后译法不一致' },
            h('input', {
              type: 'checkbox',
              checked: useContext,
              disabled: busy,
              onChange: (ev) => setUseContext(!!(ev.target && ev.target.checked)),
            }),
            '带上一段作参考',
          ),
          h('span', { className: 'lt-spacer' }),
          h(
            'button',
            { className: 'lt-btn', onClick: () => setView(view === 'zh' ? 'pair' : 'zh'), title: '在「原文+译文对照」与「只看译文」之间切换' },
            view === 'zh' ? '看对照' : '只看译文',
          ),
          h('button', { className: 'lt-btn', onClick: () => void onCopyAll(), title: '把所有已译段落连起来复制' }, '复制译文'),
          h('button', { className: 'lt-btn', onClick: () => onExport('pair'), title: '导出 Markdown：原文 / 译文对照' }, '导出对照'),
          h('button', { className: 'lt-btn', onClick: () => onExport('zh'), title: '导出 Markdown：只要译文' }, '导出译文'),
          h('button', { className: 'lt-btn', onClick: onClear, disabled: busy }, '清空'),
        ),

        h('textarea', {
          className: 'lt-ta',
          value: src,
          placeholder:
            '把英文文献正文粘到这里（摘要、正文、讨论都可以），再点「翻译未译段」。\n\n' +
            '空行分段是首选切法；一段超过 1400 字符会按句子再切，过短的相邻碎块会合并。',
          onChange: (ev) => setSrc(String((ev.target && ev.target.value) || '')),
        }),

        stale
          ? h('div', { className: 'lt-notice' }, '原文改过了：点「切段」重新切分才会生效（原文完全一致的段会保留已有译文）。')
          : null,
        prog !== null
          ? h('div', { className: 'lt-notice' }, '翻译中 ' + prog.done + ' / ' + prog.total + ' 段…')
          : null,
        err.length > 0 ? h('div', { className: 'lt-bad' }, err) : null,
        msg.length > 0 && err.length === 0 ? h('div', { className: 'lt-notice' }, msg) : null,

        h(
          'div',
          { className: 'lt-meta' },
          h('span', null, '共 ' + st.total + ' 段 · 已译 ' + st.done + ' 段（' + pct + '%）· 原文 ' + st.chars + ' 字 · 译文 ' + st.translatedChars + ' 字'),
          st.pending > 0 && st.total > 0 ? h('span', null, '未译 ' + st.pending + ' 段') : null,
        ),

        h(
          'div',
          { className: 'lt-list' },
          segs.length === 0
            ? h(
                'div',
                { className: 'lt-empty' },
                '还没有分段。粘贴原文后点「翻译未译段」（会先自动切段），或先点「切段」看看分段效果。',
                h('br'),
                '译文由 DSH 默认模型产出，是机器翻译，仅供阅读参考；正式引用请核对英文原文。',
              )
            : segs.map((seg, index) =>
                h(SegmentCard, {
                  key: seg.id || String(index),
                  seg: view === 'zh' && seg.zh && seg.zh.length > 0 ? Object.assign({}, seg, { open: false }) : seg,
                  index,
                  busy,
                  onTranslate: (i) => void translateAt(i),
                  onCopy: (i) => void onCopyOne(i),
                  onToggle: (i) =>
                    setSegs(
                      segs.map((s, k) => (k === i ? Object.assign({}, s, { open: s.open !== true }) : s)),
                    ),
                }),
              ),
        ),
      )
    }

    function PanelSafe() {
      return h(Boundary, null, h(TranslatePanel, null))
    }

    /** 侧边栏图标：用「译」字徽标，不依赖外部图片资源，装到哪台机器都不会缺图 */
    function PanelIcon() {
      return h(
        'button',
        {
          className: 'lt-icon',
          title: '文献翻译',
          'aria-label': '文献翻译',
          onClick: () => {
            try {
              if (ctxRef && ctxRef.layout) ctxRef.layout.selectPanel(PANEL_KEY)
            } catch {
              /* ignore */
            }
          },
        },
        h('span', { className: 'lt-icon-badge' }, '译'),
      )
    }

    exports.inject = ['slots', 'layout']

    exports.apply = (ctx) => {
      ctxRef = ctx
      ensureCss()
      ctx.effect(
        () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, PanelSafe)),
        'lit-translate: main panel',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 50, label: '文献翻译' }, PanelIcon),
          ),
        'lit-translate: sidebar entry',
      )
    }

    // 冒烟测试钩子：让测试能在没有浏览器与 react-dom 的情况下直接渲染这些组件。
    exports.__test = {
      splitSegments,
      makeSegments,
      buildContext,
      segStats,
      toMarkdown,
      exportName,
      TranslatePanel,
      SegmentCard,
      Boundary,
      PanelIcon,
    }

    return module.exports
  },
})
