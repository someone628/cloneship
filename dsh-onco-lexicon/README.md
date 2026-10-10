# dsh-onco-lexicon

DSH 肿瘤学术语词典插件。**两半组成**：

* **host 半**（`lib/index.js`）：向智能体提供四个查询 / 对照工具、注入"先查词典、不许编造"的提示词约束，
  并为浏览器栏目提供同源 HTTP 查询接口。
* **client 半**（`lib/client.js`）：在 Web GUI 侧边栏加一个「术语词典」栏目，可交互检索与术语对照。

**取数策略是「本地优先、联网兜底」**（0.7.0 起）：

* 本地词典命中时**一个网络请求都不发**，离线可用性与查询延迟与 0.6.1 完全一致；
* 只有 `onco_term` / `onco_abbr` 本地**查不到**时，才由 `lib/online.js` 去查
  NCI EVS（NCIt）与 NLM MeSH，结果单独成段标注为「【联网兜底】」；
* `onco_browse` / `onco_translate` 只作用于本地词典，**不联网**；
* 联网失败（超时 / 断网 / 上游退役）一律如实说明"没查成"，**不会退化成猜一个答案**。
  详见[联网兜底](#联网兜底本地优先)。

## 工具（host 半，给智能体用）

| 工具 | 作用 |
| --- | --- |
| `onco_term` | 按中文名 / 英文名 / 缩写 / 别名 / 外部编码 / 中英混输查询术语；可选 `category`、`source`、`ncitType` 筛查。**本地未收录时联网兜底**（0.7.0） |
| `onco_abbr` | 查询缩写的**全部**义项，用于消歧（OS、PD、MM 等均有多个含义）；可选 `category`、`source` 筛查。**本地未收录时联网补查**，但召回不保证完整（0.7.0） |
| `onco_browse` | 按类别浏览词条，或确认词典覆盖范围；`category` 可留空表示全部类别，另可选 `source`、`ncitType`。**不联网** |
| `onco_translate` | **术语级**中英对照：给一个术语的中英名，或从一段文本里找出所有命中术语并逐条对照。**不是机器翻译**，见 0.6.0。**不联网** |

`category` 取值：`disease` / `concept` / `biomarker` / `drug` / `endpoint` / `method` / `treatment`；
`source` 取值：`NCIt` / `自建库`；`ncitType` 取 NCIt 权威语义类型（如 `Neoplastic Process`、
`Pharmacologic Substance`）。命中被筛查时，输出开头会回显「【已按 … 筛查】」，
免得模型误以为结果被截断。

## 联网兜底（本地优先）

0.7.0 新增。目标是**在不削弱"本地离线、未收录就如实说"这两条底线的前提下**，
让本地查不到的术语还能有一条权威退路。

### 触发条件

* 只对 `onco_term`（术语）与 `onco_abbr`（缩写）生效；`onco_browse` 是"翻本地词典"，
  `onco_translate` 是术语级对照，两者都不联网。
* **只在本地零命中时触发**。本地命中时一个请求都不发，延迟与 0.6.1 相同。
* 若命中是被**筛查条件**挡掉的（本地不加筛查时有结果），**不去联网**——
  联网结果没有本地那套 `category` / `source` / `ncitType` 字段，拿一份不受筛查约束的结果回来
  只会让人误以为筛查生效了。此时输出会明确写"被当前筛查条件排除"。
* 面板侧同理，且允许单次请求带 `online: false` 关掉。

### 两个上游

| 上游 | 端点 | 取什么 |
| --- | --- | --- |
| NCI EVS REST | `https://api-evsrest.nci.nih.gov/api/v1` | 规范名、NCIt 编码（C-code）、版本号、同义词、释义 |
| NLM MeSH Lookup | `https://id.nlm.nih.gov/mesh` | 主题词标签、MeSH 编码（D-code）、入口词 |

取数口径上有两个刻意的选择：

* **NCIt 侧用 `include=summary`**：这个口径一次就带回 `synonyms` + `definitions`，
  比"先 search 再逐个取 concept"少 N 次往返（实测 3 条候选 1 次调用 ≈ 0.8–3 s）。
* **NCIt 侧先 `type=match` 再退回 `type=contains`**：前者返回集小、精度高；
  只有真的空手而归时才付第二次往返。用 `contains` 时输出会额外提示"命中范围偏宽，请按规范名核对"。

> **踩过的坑：退役域名会返回 HTTP 200 + HTML。**
> 教程里常见的老域名 `evsrestapi.nci.nih.gov` 已退役，它对**任意路径**都返回一张 HTML 门户页，
> 状态码是 200。只按 `res.ok` 判断就会把这张网页当成成功响应，再去 `JSON.parse` 一个 `<html>`。
> `lib/online.js` 因此对 `content-type` 与 `JSON.parse` 都做了显式校验，
> 并把这个失败归类为 `non-json`（输出里写"上游返回的不是 JSON（域名可能已迁移或退役）"）。

### 中文边界（重要限制）

**联网兜底补不了中文名。** NCIt 与 MeSH 都是英文词表：

* 实测 `term=肺癌` 在 NCIt 返回 `total=0`，纯中文查询拿不到任何东西；
* 因此**纯中文查询直接跳过网络**（不付往返代价），只回一句说明，让模型请用户给英文名 / 缩写；
  中英混输（如 `PD-L1 表达`）则只用其中的英文片段检索，并在输出里注明；
* 本机实测 **Wikidata 不可达**（zh 标签与 SPARQL 均 TCP 超时），所以也没有可用的免鉴权中文名来源。
  词典的中文名仍然只有人工整理的那 106 条。

### 失败如何表现

有界延迟（默认单次预算 6000 ms，配置项 `online.timeoutMs`）+ 如实说明：

| 情况 | 归类 | 输出措辞 |
| --- | --- | --- |
| 预算耗尽 | `timeout` | 请求超时 |
| DNS / 连接失败 | `network` | 网络不可达 |
| HTTP 非 2xx | `http` | 上游返回了错误状态码 |
| 200 + HTML（退役域名） | `non-json` | 上游返回的不是 JSON（域名可能已迁移或退役） |
| 上层取消（`exec.signal`） | `cancelled` | 调用已被取消 |
| 上游正常但没有条目 | `empty` | 上游没有返回条目 |

任何失败都写成"**这次没查成**"，绝不写成"该术语不存在"——一次超时推不出这个结论。
失败结果只缓存 60 s（`errorTtlMs`），成功结果缓存 6 h（`cacheTtlMs`，LRU，默认 200 条）。

> 这一条是有教训的：初版在"多口径检索全失败"时统一返回 `empty`，
> 于是超时和断网都被渲染成"上游没有返回条目"——把没查成说成了不存在。
> 现在按信息量排序取最能说明问题的那个（`unavailable > cancelled > timeout > network > non-json > http > empty`）。

### 缩写兜底的召回限制

NCIt 的检索是**按字符串排序**的，不是按"这个缩写有多常用"：

```
term=MM  →  前 10 条候选：Millimeter / Per Millimeter / Myanmar / Morular Metaplasia…
            Multiple Myeloma 不在其中；把 pageSize 放宽到 50（60 KB 载荷、4.1 s）依然不在。
```

所以缩写兜底只认「该缩写确实出现在候选条目的同义词里」（`type=match` 的返回集很小，正合适），
并在输出里明确写出**这不等于该缩写的全部义项**。它只作补充线索，不能当穷尽列表转述。

### 配置

```yaml
- insert:
    - id: dsh-onco-lexicon
      name: dsh-onco-lexicon
      config:
        dictPath: null
        topK: 5
        fuzzy: true
        online:                 # false 可整体关闭；也可写成扁平字段 onlineEnabled
          enabled: true
          timeoutMs: 6000       # 单次兜底总预算（含所有上游）
          cacheTtlMs: 21600000  # 成功结果缓存 6 h
          errorTtlMs: 60000     # 失败结果缓存 60 s
          cacheMax: 200
```

`online: false` 时行为与 0.6.1 **完全一致**（连工具声明的 `timeoutMs` 都不声明），
适合需要严格离线的环境。

### 工具调用的时间预算

`defineTool` 的 `timeoutMs` 只是声明，真正武装截止时间的是 `dsh-tool-call-timeout-policy`，
而它**只在 `timeoutMs` 存在时才设期限**。联网兜底会把一次调用的最坏耗时从毫秒级拉到
`online.timeoutMs`，所以 `onco_term` / `onco_abbr` 显式声明 `online.timeoutMs + 15000` 的外层预算，
同时把 `exec.signal` 接进联网层——上层取消能立刻传导到正在飞的 `fetch`，不必等自己的预算耗尽。

联网耗时**不计入**面板的本地检索性能统计（网络往返不是检索性能），在「性能统计」里单列一组。

## 栏目（client 半，给人用）

侧边栏出现「术语词典」入口，点开是一个独立面板，含五种模式：

* **术语检索** —— 中文 / 英文 / 缩写 / 别名 / 编码，回车即查。本地零命中时自动显示**联网兜底卡片**（0.7.0）
* **翻译** —— 术语或整段文本的中英对照（`Ctrl/Cmd + Enter` 触发），见 0.6.0
* **缩写消歧** —— 列出某缩写的全部义项；本地零命中时同样有联网兜底卡片（0.7.0）
* **类别浏览** —— 按类别下拉浏览（类别可留空＝全部）
* **性能统计** —— 见 0.5.0（索引规模 / 内存 / 本次会话查询耗时）

三种查询模式下都有一条**筛查栏**，可按三个维度收窄结果，有条件时出现「清除筛查」
（**翻译模式不挂筛查条**：段落对照要的是「原文里有什么」，按类别筛掉一半术语只会让标注看起来漏词）：

* **类别** —— 7 个粗桶（由 NCIt 语义类型汇总而来），见 0.4.0
* **出处** —— NCIt / 自建库
* **NCIt 类型** —— 权威语义类型（122 种，按词条数降序，带计数）

查询模式下还有两个动作按钮：

* **模糊检索** —— 开关式，按编辑距离（≤2）召回拼写相近的术语（`cisplatni` → `Cisplatin`），见 0.5.0
* **导出 TXT** —— 把当前结果导出为带 BOM + CRLF 的纯文本（Windows 记事本可直接打开），见 0.5.0。
  联网兜底结果也可以导出，在文件里单独成段（`# ---- 联网兜底 … ----`），不会混进本地词条列表（0.7.0）

每张词条卡片上有**出处徽标**（`NCIt` / `自建库` / `中文` / `MeSH` 等），显示完整的 `来源：` 文字，
以及 `NCIt 类型：`——便于判断归类是否可信；右上角的**关联**按钮展开「上位概念 / 下位概念 /
名称近似」三组推荐，点任一项可继续外扩（见 0.5.0）。

面板数据来自 host 半已建好的内存索引，走同源 `POST /dsh-onco-lexicon/rpc`，
不向浏览器传输词典本身（全量 77.9 MiB，不适合下发）。

| 实现要点 | 说明 |
| --- | --- |
| 模块协议 | `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 内 `require("react")` |
| 导出 | `exports.inject = ['slots', 'layout']` + `exports.apply(ctx)` |
| 栏目注册 | `ctx.slots.register({ name: 'main', key: 'onco-lexicon' }, 组件)` |
| 侧边栏入口 | `ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, 图标)` |
| 切栏目 | 图标点击调 `ctx.layout.selectPanel('onco-lexicon')` |
| 渲染兜底 | 面板包了 React error boundary，渲染出错不会影响 GUI 其它部分 |

## 安装

**必须打成 tgz 安装，不能用 `link:`。**

```powershell
# 1) 打包（staging 目录下放 package/，内含 lib、data、package.json、cordis.patch.yml…）
tar -czf ..\dsh-onco-lexicon-0.2.0.tgz -C <staging> package
#    或用 npm pack（注意：npm 需要一个可写的 cache 目录）

# 2) 安装到 web profile
dsh plugin --profile web add file:<tgz 的绝对路径>
```

> 升级时**务必先 `remove` 再 `add`**，并**递增版本号**，否则 pnpm 会认为「Already up to date」
> 而复用旧包（详见下方 lockfile 残留一节）。

### 为什么 `link:` 行不通

`dsh plugin add link:<目录>` 会在 profile 的 `node_modules` 里建一个 **junction 指回源目录**。
而 Node 解析裸模块说明符（bare specifier）时用的是**真实路径**，于是会从源目录向上查找
`node_modules`：

```
<源目录>/node_modules  ->  <上层目录>/node_modules  ->  ...
```

而 DSH 自身的 `@deepseek-ai/*` 包位于 profile 的**上一级**：

```
~/.ds-harness-desktop/dsh-home/profiles/node_modules/@deepseek-ai/
```

源目录在工作区、profile 在用户目录下时，这条向上链永远走不到那里，加载时会直接报：

```
Cannot find package '@deepseek-ai/dsh-tools'
```

以 tgz（或 `file:` 目录复制）安装时，包会被**复制进** `profiles/web/node_modules/`，
向上查找自然命中 `profiles/node_modules/@deepseek-ai/`，与已装的 `dsh-plugin-save-token`
（同样写 `import { defineTool } from '@deepseek-ai/dsh-tools'`）行为一致。

**踩坑提示**：pnpm 会把首次 `link:` 的解析结果写进 `pnpm-lock.yaml`（`version: link:...`）。
后续即使改用 `file:...tgz`，只要 lockfile 里那条残留，pnpm 就会认为「Already up to date」
并继续生成 junction。必须先 `dsh plugin --profile web remove dsh-onco-lexicon` 再 add，
才能强制重新解析。

安装后需重启 DSH 才会加载。

## 词典数据

插件启动时按以下顺序自动探测词典：

1. 配置项 `dictPath`（`cordis.patch.yml` 中显式指定）
2. `data/onco.ncit.jsonl` —— **随包发布的主词典，185,885 条**
3. `data/onco.seed.jsonl` —— 种子词典（106 条，作为兜底）

词条格式为 JSONL，每行一条：

```json
{"id":"onco:nsclc","en":"Non-Small Cell Lung Carcinoma","zh":"非小细胞肺癌",
 "abbr":["NSCLC"],"aliases":["非小细胞肺癌"],"def":"…",
 "category":"disease","codes":{"mesh":"D002289"},"source":"人工整理（演示用）"}
```

`zh` / `abbr` / `aliases` / `def` / `codes` / `parents` / `source` 均为可选字段。

### 主词典是怎么合成的（185,885 条）

单用任一来源都不够：

* 全量 NCIt 有 185,880 条，但**纯英文**——直接用它会让中文查询从"能用"退回"查不到"。
* 种子词典只有 106 条，但中英双语、带 MeSH 编码，是中文入口。

因此 `build-plugin-dict.py` 做了**按概念合并**（不是追加，见 0.2.4）：

| 来源 | 条数 | 作用 |
| --- | --- | --- |
| NCIt 全量（`onco-ncit-dsh.jsonl`） | 185,880 | 英文覆盖面（作为骨架，含权威语义类型） |
| ↳ 其中并入自建库字段的 | 101 | 补中文名 / 中文释义 / MeSH 编码 / 人工类别 |
| 自建库独有（NCIt 无对应概念） | 5 | 中文入口 |
| 合计 | **185,885** | 77.9 MiB |

两套 id 命名空间不同（`ncit:` / `onco:`），不会冲突。

效果：查「非小细胞肺癌」命中**唯一一条** `ncit:c2926`，中英两条路都通，且不会出重复卡片。

### 启动代价（实测，如实记录）

词典在插件初始化时**一次性同步载入内存**：

| 指标 | 实测 |
| --- | --- |
| 读 + 解析 + 建索引 | **2.61 s** |
| 常驻内存 RSS | **821 MB** |
| 单次查询 | 平均 **7.6 ms**（p95 19.3 ms） |

这些数字现在不用靠猜——面板的「性能统计」模式（0.5.0）会实时显示同一组指标。

769 MB 常驻不轻，但本机 31.5 GB 内存下可以接受。若你在小内存机器上部署，建议改用
`dictPath` 指向精简词典，或直接把 `data/onco.ncit.jsonl` 换成 `data/onco.seed.jsonl`。

## 检索实现

纯 ESM JavaScript，无第三方依赖（仅依赖 DSH 运行时的 `@deepseek-ai/dsh-tools`）。

- **归一化**：NFKC → 小写 → 标点转空格 → 压缩空白。标点规则用 Unicode 属性
  `[^\p{L}\p{N}+]+` 实现，特意保留 `+`，因为 `ER+` / `HER2+` 是独立概念，不应与 `ER-` 合并。
- **切词**：拉丁文按空格切；中文用 `Intl.Segmenter('zh-Hans')` 分词，**并额外产出字符二元组**，
  以保证「肺癌」能召回「非小细胞肺癌」这类长名称。
- **候选集**：精确键 ∪ 排序键数组上的前缀二分扫描 ∪ 倒排 token 表。
- **打分**：精确 1000 > 前缀 820 > 包含 700 > 反向包含 660 > 关键词覆盖率 400 > 模糊 260。
  模糊匹配（编辑距离 ≤ 2）**仅在没有像样命中时**才启用，避免噪声。

## 相对原始 TypeScript 设计的改动

原项目为 TypeScript，本次交付做了四处必要调整：

1. **改为纯 JavaScript**：本机 DSH 运行时未附带 `tsc`/`esbuild`，无法在安装期编译，
   故直接交付 `lib/index.js` / `lib/client.js`（Node 24 原生执行 ESM；客户端由
   `window.__ModuleLoader__` 加载）。
2. **去掉 `bundle.skill` 声明**：当前 DSH 的 `dsh-package-manifest` 不支持该键，
   声明它可能导致校验失败。`skill.md` 仍随包发布，行为约束改由插件内的
   `ctx.systemPrompt.section()` 注入实现（功能等价）。
3. **修正标点正则**：原 `PUNCT_RE` 字符类在转录中已损坏（`\u2015_-/` 构成反向区间，
   会让正则抛 `SyntaxError`），改用 `[^\p{L}\p{N}+]+`。
4. **新增最低分阈值 `MIN_SCORE = 45`**：原实现对生造词会返回假命中——实测
   「完全不存在的术语xyz」仅凭 6% 的字符二元组覆盖率就得到 25.1 分并被当成结果。
   对术语词典而言这比"查无此词"更糟：提示词要求模型未收录时如实说明，而假命中会让它照抄。
   阈值取自实测分界：噪声命中 25.1，合法弱匹配（「抗肿瘤药物」）55.8。可用 `config.minScore` 覆盖。

此外**新增了浏览器栏目**（原设计只有给智能体用的工具），见上文「栏目」一节。

## 已知缺陷与修复记录

### 0.2.1 —— 栏目一查就"渲染出错"

**症状**：侧边栏点开面板后，一点「查询」就显示"术语词典面板渲染出错（已拦下）"。

**根因**：host 与 client 对命中结果的**形状约定不一致**。host 的 `serializeHit` 返回的是
**扁平对象**（`{...entry, score, via}`），而客户端却按 `hit.entry` 取值：

```js
h(Card, { entry: hit.entry, ... })   // hit.entry === undefined
```

`Card` 里随即对 `e.abbr` 解引用 undefined 抛 `TypeError`，被自带的 error boundary 接住，
面板于是显示崩溃信息。**「类别浏览」是好的**——那条路径 host 返回 `entries` 数组、
客户端又包了一层 `{ entry: e }`，恰好对上了。

**修复**：客户端加 `normalizeHit()`，两种形状都收敛成 `entry`；`Card` 对 `entry` 缺失时
返回 `null` 而不是抛错。

**为什么之前没测出来**：`test-panel.mjs` 只覆盖 host 侧的 RPC，**从未真正渲染过客户端组件**。
为此新增 `test-client.mjs`：用一个极小的 React 替身（`createElement` / `useState` /
`useEffect` / `Component`）把组件真正跑起来，stub 掉 `fetch`，走完「输入关键词 → 点查询 →
渲染结果」整条链路。

该测试已用**故意复现旧 bug** 的方式验证过有效性——重新引入 `entry: raw.entry` 后，
它会准确报出「查询结果未渲染词条 / 未渲染缩写」两项失败。

### 0.2.2 —— 浅色主题下文字几乎看不见；改为紫色

**症状**：面板文字过浅、难以辨认。

**根因（两个叠加）**：

1. **主题变量前缀写错**。DSH 主题暴露的是 `--dsw-alias-*`
   （`--dsw-alias-label-primary` / `--dsw-alias-border-l2` / `--dsw-alias-bg-layer-1` …），
   而 CSS 里写的是 `--dsh-text` / `--dsh-border` / `--dsh-accent` 等**并不存在的名字**，
   于是每个 `var()` 都静默落到 fallback；而 fallback 是按**深色**主题写的
   （`color:#e6e6e6` 近白文字）。本机 `AppsUseLightTheme = 1`，DSH 跟随系统即浅色主题，
   近白文字落在浅色背景上自然读不清。
2. **次级文字靠 `opacity` 淡化**（`.onco-meta{opacity:.65}`、`.onco-k{opacity:.55}` 等），
   在浅色下进一步变淡。

**修复**：

* 改用真实变量 `--dsw-alias-*`，让面板能跟随主题明暗。
* 正文与次级文字改成**显式深紫**，不再用 `opacity` 淡化：
  标题 `#4c1d95`、正文 `#5b21b6`、次级/标签 `#6d28d9`、选中态填充 `#7c3aed`。
* 补 `@media (prefers-color-scheme: dark)` 一套浅紫（`#ede9fe` / `#ddd6fe` / `#c4b5fd`），
  避免切到深色主题后深紫又变得不可读。

`test-client.mjs` 增加了 25 项 CSS 断言：不得再出现那些不存在的 `--dsh-*` 名字、
必须使用 `--dsw-alias-*`、四个紫色值必须存在、必须有深色适配，
以及那几个次级文字样式**不得再出现 `opacity`**。

### 0.2.3 —— 侧边栏改用图片图标

把一张 200×200 的手绘线稿做成栏目图标（原先只是一个"词典"文字按钮）。

生成方式（`build-icon.ps1`，可重复运行）：

1. 缩放到 **64×64**，并施加 **gamma 2.2** —— 源图是浅灰线稿，不加深对比度的话
   缩到侧边栏的 ~20px 会糊成一团；
2. 输出 `assets/icon.png`（9.3 KB）；
3. 转 base64（12.4 KB）写进 `lib/client.js` 的 `ICON_B64_START/END` 标记之间。

**为什么内嵌 data URI 而不是走静态路由**：图标随包走，不依赖运行时的额外请求，
也不会因为路由未注册而变成裂图。代价是 `client.js` 从 12.7 KB 增到 27 KB，可以接受。

**两个细节**：

* 边框放在外层 `.onco-icon-badge` 上，而不是图片本身 —— 因为深色主题要对图片做
  `filter:invert(1)`（白底黑线 → 黑底白线），若边框和图片在同一元素上，紫色边框会被一起反相成怪色。
* 图片加载不出来时不会变成裂图：`ICON_DATA_URI` 为空则回退成 `词典` 文字。

`test-client.mjs` 增加了 10 项图标断言：必须渲染 `<img>` 而非文字回退、`src` 必须是
合法的内嵌 PNG data URI、`alt` 与 `draggable` 正确、必须有外层圆形容器、
必须有深色反相，以及 base64 长度 > 1000（脚本注入失败的典型表现是留空）。

### 0.2.4 —— 自建术语库与 NCIt 术语库真正合并

**问题**：旧版只是把自建库（106 条）**追加**在 NCIt（185,880 条）之后，同一个概念会出两条：

```
非小细胞肺癌（Lung Non-Small Cell Carcinoma）   <- NCIt，无 MeSH
非小细胞肺癌（Non-Small Cell Lung Carcinoma）   <- 自建，有 MESH:D002289
```

面板上查一次就出两张重复卡片。

**改法**：`build-plugin-dict.py` 改为**按概念合并**——以 NCIt 条目为骨架，把自建库中
对应概念的字段并进去：

| 字段 | 取舍 |
| --- | --- |
| `id` / `en` / `parents` | 用 NCIt 的（权威规范名与层级） |
| `zh` | 用自建库的（NCIt 没有中文） |
| `aliases` | NCIt 英文同义词 + 自建库中文别名 + **自建库的旧英文名**（否则旧叫法搜不到） |
| `abbr` | 两边合并 |
| `codes` | 两边合并（自建库补上 NCIt 缺失的 MeSH） |
| `category` | **用自建库的**。自建库是人工整理，而 NCIt 的类别是名称正则粗判的——例如终点类概念正则只会给 `concept` |
| `def` | 中文释义在前、空行、英文释义在后 |
| `source` | `NCIt OBO Edition + 人工整理`，便于追溯 |

自建库 106 条 = 并入 101 + 无 NCIt 对应而独立保留 5 条。

**结果**：185,885 条（旧版 185,986），**消除 101 张重复卡片**，**中文名重复数为 0**。
tgz 也从 15.09 MB 降到 14.54 MB。

`verify-merge.py` 独立校验：总数、id 唯一、中文名不重复、抽样字段并入、
旧英文名仍在 aliases 里。`test-panel.mjs` 增至 24 项，新增「同一概念只有 1 条」
「`onco:nsclc` 不得再作为重复条目存在」以及各合并字段的断言。

面板侧配套：`def` 现在是中英两段，`.onco-def` 加 `white-space:pre-wrap` 以保留换行。

### 0.2.5 —— 外部编码可直接检索

0.2.4 时编码只作展示字段，拿 `D002289` 查是查不到的。现在 `collectKeys` 把 `codes` 的
**裸值**并入检索键：

| 查询 | 结果 |
| --- | --- |
| `D002289` | `ncit:c2926`（精确命中，得 1000 分） |
| `mesh:D002289` / `MESH:D002289` | 同样命中 `c2926` 且排第一 |
| `D999999`（不存在） | 0 条 |

**为什么只放裸值、不放 `mesh:D002289` 这种带前缀的键**：`normalize` 会把冒号转成空格，
所以带前缀的查询本身就能经 token 路径命中同一个词条；把它再做成键属于冗余。
`onco_term` 的工具描述也补上了"支持外部编码"。

**一个查证出来的细节（我最初的判断是错的）**：我原以为带前缀查询多带出两条是
"`mesh` 成了 token 导致匹配所有 MeSH 词条"，实测并非如此——多出的两条是
`ncit:c71222`（英文名就叫 **Mesh**）和 `ncit:c160148`（**Brass Mesh Bolus**），
"mesh" 是 NCIt 里真实存在的词，属于正常匹配，不是副作用。

`test-panel.mjs` 增至 28 项，覆盖裸码、带前缀、大小写、以及不存在编码应返回 0 条。

### 0.2.6 —— 图标在别人电脑上加载不出来

**症状**：装到另一台机器、重启后插件能用，但侧边栏图标不显示。

**两个原因（都很隐蔽）**：

1. **图标只有一个来源**。内嵌 base64 依赖构建期 `build-icon.ps1` 的注入。只要这个环节
   在别的机器上没跑到（重新打包、只拷源码目录、构建中断等），`ICON_DATA_URI` 就是空串，
   图标直接退化成"词典"两个字。本地看不出来，因为本地这份 client.js 是注入过的。
2. **深色主题下会反相**。0.2.3 给图片加了 `@media (prefers-color-scheme: dark){filter:invert(1)}`，
   但源图是**浅灰线稿 + 白底**，反相后成了**浅灰线 + 黑底**，在深色侧边栏上糊成一片，
   效果就是"图标没加载"。本机是浅色主题，所以一直没暴露。

**改法**：

* 图标改为**双来源按序回退**：内嵌 data URI → host 半的静态路由 `/dsh-onco-lexicon/icon.png`
  → 文字。用 `onError` 逐级降级，因为"能不能加载"只有浏览器试过才知道
  （data URI 可能被 CSP 拦、路由可能没注册）。
* host 半新增一条图标路由，**按需从同包的 `assets/icon.png` 读取**，不依赖任何构建产物。
  为此把 `assets/icon.png` 加进 `package.json` 的 `files`（此前没随包发布，路由会 404）。
* **去掉深色反相**，改为在外层 `.onco-icon-badge` 固定白底 + 紫色描边，
  明暗两种主题下都是清晰的白底圆形徽标。

**验证**：`verify-installed-icon.mjs` 直接针对**已安装副本**跑——从 profile 的
`node_modules` 加载插件，确认它能经 `import.meta.url` 找到同包的 `assets/icon.png`
并供出合法 PNG（200 / image/png / 9296 字节）。这正是"别人电脑上"必须成立的那一环。

`test-client.mjs` 增至 75 项，含**回退链的三级验证**（data URI 失败 → 静态路由 →
文字），以及"不得再出现 `filter:invert`"。`test-panel.mjs` 增至 34 项，
新增图标路由必须返回合法 PNG、且 `files` 必须包含 `assets`。

> 修这一版时还顺带发现**测试替身自身的 bug**：假 React 原先用一个全局 hooks 数组，
> SearchPanel（9 个 hook）跑过之后，PanelIcon 的 `useState` 拿到了别人的槽位
> （值是 `'search'`），于是 `ICON_SOURCES['search']` 为 undefined——
> 测出来的"回退失效"其实是测试的错，不是插件的错。已改为按组件隔离 hook 状态。

### 0.3.0 —— 术语出处标识 + 分类筛查

**出处标识**。原先 `source` 只是数据里的一个字符串（`NCIt OBO Edition` /
`NCIt OBO Edition + 人工整理` / `人工整理（演示用）`），**面板卡片根本不显示**，
也没法据它过滤。现在 `build-plugin-dict.py` 额外产出结构化的 `sources` 数组：

| sources | 条数 | 含义 |
| --- | --- | --- |
| `["NCIt"]` | 185,779 | 纯 NCIt 本体 |
| `["NCIt","自建库"]` | 101 | 两边合并（有中文名、中文释义、MeSH 编码） |
| `["自建库"]` | 5 | 自建库独有，NCIt 无对应概念 |

面板卡片据此打出徽标：`NCIt` / `自建库`（强调色）/ `中文`（有中文名时）/ `MeSH`（有该词表编码时），
并显示完整的 `来源：` 文字。工具文本输出只在**确实合并过**（`sources` 长度 > 1）时
才单独标一行 `出处：NCIt + 自建库（已合并）`——185k 条纯 NCIt 都标一遍只是噪声。

**分类筛查**。原先只有「类别浏览」模式能选类别，**检索与缩写模式完全没法按类别收窄**。
现在：

* 面板三种模式下都有一条筛查栏，按**类别**（7 类）与**术语出处**（NCIt / 自建库）收窄，
  有条件时出现「清除筛查」。
* 三个工具都支持 `category` 与 `source` 参数，并在输出开头回显「【已按 … 筛查】」。
* `onco_browse` 的 `category` 改为可选（留空＝全部类别）。

**一个实现要点**：筛查条件**必须传进候选循环**，不能事后过滤结果——事后过滤会让 topK
被不符条件的条目占满，实际只返回几条残渣。为此 `Lexicon.search` / `lookupAbbr` / `browse`
都增加了可选的 `filter` 谓词。测试里用「类别=drug 查肺癌」这种基本无交集的条件验证：
正确地返回 0 条，而不是返回几条被事后过滤剩下的。

`test-panel.mjs` 增至 60 项、`test-client.mjs` 增至 100 项、`test-onco-lexicon.mjs` 增至 48 项，
覆盖：筛查在候选层生效、`sources` 是数组（合并条目同时属于两个出处）、
`stats.bySource` 计数（自建库 106 / NCIt 185,880）、徽标渲染、筛查参数随请求发出且互不覆盖、
「清除筛查」复位。

> 写这一版时又踩了两次**选择器**的坑（和之前「查询」按钮那次同源）：
> 激活态的模式按钮 className 是 `onco-btn on` 而非 `onco-btn`，按后者找会漏掉，
> 于是"点了模式切换"其实没点中，后续断言全跟着错。测试里已注明只按文案找。

### 0.3.1 —— 打包优化

**先测再砍，而且必须看压缩后的体积**——只看未压缩会得出错误结论。

| 方案 | 未压缩 | 压缩后 | 压缩后省 |
| --- | --- | --- | --- |
| A 现状 | 85.4 MB | 14.58 MB | — |
| **B 去掉 `text`** | 68.8 MB | **12.41 MB** | **2.17 MB（14.9%）** |
| C 再去掉 `source` | 63.9 MB | 12.28 MB | 仅再省 0.13 MB |
| D 再缩短字段名 | 58.9 MB | 12.11 MB | 仅再省 0.17 MB |

**只做 B**：

* `text` **插件从不读取**——它按 `en` / `zh` / `abbr` / `aliases` / `codes` 建检索键，`text` 只有
  Python 侧知识库（`onco_kb.py`）用。放在插件词典里纯属白占 2.17 MB 压缩体积。
* `source` 是近乎常量（185,779 条都是同一串），gzip 后几乎不占体积：未压缩看着能省 5 MB，
  压缩后只有 0.13 MB，不值得为它改代码去从 `sources` 推导。
* 缩短字段名能省 26.5 MB **未压缩**，但压缩后只多省 0.17 MB，却要牺牲 JSONL 的可读性。

结果：**tgz 14.66 → 12.54 MB（−14.5%）**，词典 88.6 → 71.7 MiB，功能零变化。

`build-plugin-dict.py` 默认丢弃 `text`，`--keep-text` 可保留（Python 侧需要时）。
**注意**：插件词典（`dsh-onco-lexicon/data/onco.ncit.jsonl`）现在不含 `text`，
要给 `onco_kb.py` 用请改用 `onco-ncit-dsh.jsonl`（源文件保留 `text`）。

`test-panel.mjs` 增加「打包精简不变量」，防止这个优化被无意改回去：
插件词典不得含 `text`、必须含 `sources`、体积需 < 80 MiB。

### 打包流程固化为脚本

`build-package.ps1` 取代了此前手敲的 staging + tar 序列（那条流程曾让我误写 BOM）。
打包前强制校验四条**曾经出过事**的不变量：

1. 6 个随包文本文件不得带 BOM（DSH 是 `JSON.parse(readFileSync(pkg,'utf8'))`，带 BOM 直接抛错）
2. `assets/icon.png` 必须随包（否则图标路由 404，客户端只剩文字回退）
3. 词典必须精简（无 `text`、含 `sources`）
4. `package.json` 必须声明 `./client` 与 `dsh.client.platform=web`

**脚本自身必须存为 UTF-8 with BOM**：Windows PowerShell 5.1 对无 BOM 的 `.ps1` 会按 GBK 解码，
中文会乱掉并破坏字符串终止符——本脚本第一次写好时就因此直接解析失败。脚本头部已写明该注意点
（用外部编辑器改过后要确认 BOM 仍在）。

顺带否掉一个想当然的优化：Windows 自带的 tar 是 **bsdtar**，不支持 GNU 的 `-I "gzip -9"`；
且实测 9 级相对默认 6 级**只省 0.08 MB（0.6%）**，不值得为此引入平台差异。

### 0.4.0 —— 类别精准（改用 NCIt 权威语义类型）

**问题**：`category` 原先是**按名称正则粗判**的。实测它被名字里的词系统性带偏：

| 条目 | 正则判 | 权威类型 | 实际 |
| --- | --- | --- | --- |
| `SOAPP-R - Others Suggested Drug or Alcohol Problem` | **drug** | Intellectual Product | 量表条目 |
| `BPI - Pain Due to Present Disease` | **disease** | Intellectual Product | 量表条目 |
| `MDS-UPDRS - Medication for Parkinson's Disease` | **disease** | Intellectual Product | 量表条目 |
| `Alzheimer's Disease Assessment Scale…` | **disease** | Intellectual Product | 评估量表 |

**改法**：改用 NCIt 自带的 **Semantic_Type**（OBO 里的 `property_value: NCIT:P106`）。
实测覆盖 **100%** 词条（185,880/185,880）、共 **122 种取值**，绝大多数字段只有 1 个类型。

映射到 7 个类别（`TYPE_TO_CATEGORY`），多类型时按 `drug > disease > biomarker > treatment > method`
取优先级——像 `Recombinant Amphiregulin` 同时是「蛋白」和「药物」，对查词典的人来说「这是药」更有用。
未列入映射表的类型一律归 `concept`。

类别分布前后对比：

| 类别 | 旧（正则） | 新（语义类型） |
| --- | --- | --- |
| concept | 148,037 | 97,779 |
| disease | 16,595 | 26,814 |
| drug | 5,151 | **22,786** |
| biomarker | 14,691 | 22,626 |
| method | 1,406 | **9,158** |
| treatment | 0 | **6,704** |
| endpoint | 0 | 18 |

**一个关键决定：不能保留正则作兜底。** 我原本让「类型推不出类别」的条目回落到正则结果，
结果 52.6% 的词条走兜底，把上面那些量表条目全判成了 drug/disease。核对样本后确认
**正则在这些情况是系统性错的**，于是改成：有权威类型就以它为准，映射表未覆盖就归 `concept`；
只有完全没有类型时才用正则（本语料 0 条）。现在 **99.9% 的类别来自语义类型，正则兜底 0%**。

**「临床试验终点」推不出来，只能靠人工整理。** 实测 NCIt 语义类型不区分终点：

| 术语 | NCIt 语义类型 |
| --- | --- |
| Overall Survival | `Conceptual Entity` |
| Hazard Ratio | `Quantitative Concept` |
| Adverse Event | `Finding` |

它们和大量非终点概念同型。所以 `endpoint` 仅来自自建库的 18 条人工整理条目——
这也正是合并时「合并条目沿用人工类别」的原因。

**新增精确筛选维度**：把权威类型本身作为第三维筛查（面板下拉 + 工具 `ncitType` 参数），
比 7 个粗桶精确得多。词条卡片上也直接显示 `NCIt 类型：`，便于判断归类是否可信。

代价：词典 71.7 → 77.9 MiB，tgz 12.54 → 12.89 MB（仅 +0.35 MB）。

`test-panel.mjs` 增至 75 项、`test-client.mjs` 增至 109 项，覆盖：`stats.byType` 类型数、
按类型筛查不混入其他类型、类别+类型叠加、`drug + Neoplastic Process` 应无交集、
量表条目必须归 `concept`、9 个常见药/病/靶点/疗法的类别抽查、清除筛查复位三个下拉。

### 0.5.0 —— 性能统计 / 模糊检索 / 关联推荐 / 导出 TXT

四项一起做，因为它们共用同一批索引（`byLength`、`childrenOf`、`byId`）与同一个 RPC 通道。

**① 性能统计面板**（第 4 个模式）。新增 RPC `op=perf`，返回三组：

| 组 | 内容 |
| --- | --- |
| 索引 / 词典 | 词典名、加载耗时、词典体积、词条数、检索键数、词项数、倒排项数、NCIt 类型数、下位索引键数 |
| 内存 / 进程 | RSS / heapUsed / heapTotal / external、运行时长、Node 版本与平台 |
| 查询耗时（本次会话） | 次数、最近一次、平均、p50 / p95、最慢、样本数 |

查询耗时靠 `recordQuery()` 在每次 RPC 里记一笔（**排除 `perf` / `stats` 自身**，
否则一打开面板就把统计污染了），样本环形保留最近 300 次。字节与毫秒都做了人类可读格式化
（`13526630` → `12.9 MB`），测试里专门断言"不得再显示裸字节数"。

**② 模糊检索**。原先模糊匹配只在"没有像样命中时"自动兜底，用户无法主动触发。现在加了
**模糊检索**开关，`search(q, topK, filter, { fuzzy: true })` 强制走编辑距离。

> **修掉一个真实 bug**：模糊扫描原先在**按字典序排序的键数组**上取前 `fuzzyScanLimit`（8000）个。
> 而 `cisplatin` 排在 14,303 位——**永远扫不到**。查询 `cisplatni` 因此返回空，
> 看起来"模糊检索没用"。改为按**长度分桶**（`byLength`：编辑距离 ≤2 的候选只可能落在
> 长度 ±2 的桶里）后，全量 51.7 万个键**22 ms 扫完**，`cisplatni` 正确命中 `Cisplatin`(180 分)。
> 这个 bug 只有在"字母序靠后 + 拼写错误"的组合下才暴露，是我写诊断脚本逐桶比对时才发现。

**③ 关联推荐**。新增 RPC `op=related`，以某词条为中心给出三组：

* **上位概念** —— 数据里的 `parents` 反查（名称 → 词条）
* **下位概念** —— 建索引时预先算好的 `childrenOf`（谁把我列为 parent）
* **名称近似** —— 复用倒排表按共享 token 数排序（只保留共享 ≥1 个 token 的）

界面上面板卡片右上角出现**关联**按钮，点开后展示三组（各带条数），每组是一个可点的术语胶囊，
**点任一项就以该项为中心继续外扩**，形成可探索的关联网。「关闭关联」只收起关联视图，不动检索结果。

`related()` 有三条不变量，测试逐条验：结果**不含自身**、**不重复**、**顺序单调**
（名称近似的相似度必须非递增）。用 `Lung Carcinoma` 实测：上位 2 / 下位 8 / 名称近似 8。

**④ 导出 TXT**。新增 RPC `op=export`，由 **host 半写文件**（浏览器不碰文件系统），
返回落盘路径，面板显示"已导出 N 条到 …"。导出内容含词典名、模式、查询词、时间、条数，
每条词条带相关度、匹配原因、类别、NCIt 类型、缩写、别名、上位概念、编码、释义、出处、ID，
结尾附"仅供参考、不构成诊疗建议"的免责行。

两个细节：

* 文本用 **UTF-8 BOM + CRLF**——否则 Windows 记事本打开中文是乱码、换行会挤成一行。
* 文件名**必须净化**：`name` 来自浏览器，`..` 会让 `path.join(dir, '..')` 直接跳到上级目录。
  现在的处理是：先去掉 `[\\/:*?"<>|]`，再把**开头的点串**中和掉，最后再校验
  `path.dirname(resolve(file)) === resolve(dir)` 兜一次底。导出目录**不接受 RPC 传参**
  （那等于把任意路径写权限交给浏览器），只认环境变量 `ONCO_LEXICON_EXPORT_DIR`、否则 `Downloads`。
  测试覆盖 `..`、`../../evil.txt`、空内容三条路径。

`test-panel.mjs` 增至 111 项、`test-client.mjs` 增至 210 项（0.4.0 时分别是 75 / 109），
新增的部分覆盖：性能字段齐全且格式化正确、模糊开关随请求发出且可关掉、
关联请求带 id 且可二级外扩、关闭关联不清结果、导出文本的 BOM/CRLF/免责行与文件名净化、
无结果时导出按钮禁用。

> 写这一版时又踩了一次**同类**的坑：加 RPC 分支时，我在 `abbr` / `browse` 之前
> **多写了一个 `return { ok:false, error:'unknown op' }` 作为兜底**，于是这两个 op 全被它截住，
> 面板一开就报 `unknown op: browse`。教训是兜底 `return` 必须放在**所有分支之后**——
> 这类错误不会报语法错，只会静默吃掉后面所有分支。

### 0.6.0 —— 翻译功能（中英术语对照 + 长文本术语标注）

先说清楚它**不是**什么，因为这一点决定了整个实现：

> **这不是机器翻译。** 本插件的翻译路径不联网，本机也没有翻译模型（0.7.0 加入的联网兜底
> 只用于 `onco_term` / `onco_abbr` 的未命中查询，翻译不碰网络）。它能做的是**术语级对照**——
> 把文本里命中的术语换成词典标准名；它做不了语序调整、语法重组、整句润色。
> 硬要装成能翻译，只会产出「读起来很顺但内容是错的」译文，对医学文本比「看不懂」更危险。
> 因此界面、导出文件、工具输出三处都写明了这一条，系统提示词里也加了一条禁止把对照结果包装成译文。

**两种用法**：

1. **单术语中英对照** —— 输入「非小细胞肺癌」给 `Lung Non-Small Cell Carcinoma`，
   输入 `NSCLC` 给「非小细胞肺癌」。短输入额外给一条「最相近词条」（走 `search` 的打分路径）。
2. **长文本术语标注** —— 粘贴一整段（中英均可），把命中的术语逐条列出对照，
   并在原文里高亮可对照的术语；可导出为 txt。

新增 RPC `op=translate`，新增工具 `onco_translate`，面板新增第 5 个模式「翻译」。

**算法：最长匹配 + 词边界 + 位置映射**

与 `search` 的方向正好相反：`search` 是「拿查询找词条」，翻译是「拿词条找文本里的出现位置」，
所以必须给出原文下标才能高亮。三步：

1. `normalizeWithMap()` 逐码点做与 `normalize()` 相同的转换，同时记下每个归一化字符来自
   原文的哪一段（`mapS` / `mapE`）。ASCII 走快路径，不逐字符跑 NFKC + 正则。
2. 在每个合法起点上从长到短试键。长度表按**首字符**预建（`keyLens`），
   只试「该首字符真实存在的长度」，而不是从最长键一路试下来。
3. 归一化下标 → 原文下标。结束位置取「最后一个命中字符的结束下标」而不是下一个字符的起始下标——
   否则折叠出来的空格会被一起圈进高亮范围。

**词边界规则**（两条都不能少）：拉丁词内部不许起止，否则 `her2` 会命中 `her2neu` 里的片段；
中文字符**自身**构成边界，否则中文没有空格，`非小细胞肺癌` 在中文句子里永远匹配不上
（后面总跟着「的」「患者」）。等价说法是：边界 = 串首串尾 / 空格 / **书写系统切换**。

**一个刻意的取舍：只有「能给出目标语言名」的命中才在原文里高亮。**

词典 185,885 条里绝大多数是纯英文 NCIt，带中文名的只有 106 条（人工整理）。若把所有命中都高亮，
一段英文摘要里的 `And` / `With` / `Patient` / `Cell` / `Dose` 会全部亮起来——它们是货真价实的
NCIt 概念，但亮成一片反而盖住了真正能翻译的那几个术语。所以：

* 可对照的命中 → 原文高亮 + 悬停显示「原文 → 对照名」
* 无译名的命中 → **不隐藏**，收在「展开 N 个无译名命中」清单里，原文中保持纯文本

**中文覆盖是这套功能的硬上限**，必须如实说明：中文原文只认词典里真实存在的中文名，
而带中文名的条目只有 106 条。实测一段中文长句「非小细胞肺癌患者接受顺铂治疗」能标出 2 个术语、
覆盖 57% 字符；而「本研究采用回顾性队列设计，共纳入患者三百例」命中 0 个——
术语刚好都在那 106 条里才行。中文段落建议改用「术语检索」逐个查（那条路径有二元组覆盖率打分，宽容得多）。
英译中同理：`Lung Carcinoma` 在词典里确实**没有**中文名，此时只标「（词典未收录中文名）」
并保留英文原名，绝不替它编一个。

#### 这一版查出的两个真 bug

**① 反向包含规则制造假命中（既有 bug，不是本版引入）。**

`scoreDoc` 里有一条「查询包含键」的反向匹配规则，本意是让「非小细胞肺癌患者」能命中
「非小细胞肺癌」。但它对键的长度没有任何要求，于是：

| 查询 | 修复前 | 修复后 |
| --- | --- | --- |
| `完全不存在的术语xyz` | `ncit:c45977 XY Genotype`，**得分 615** | 0 条 |

机理：`XY Genotype` 有个键 `xy`，而 `q.includes('xy')` 成立（生造词里的 `xyz` 含 `xy`），
拿到 `W_REVERSE 660` 减去惩罚后仍有 615 分，轻松越过 `MIN_SCORE = 45`。
**这是 README 之前声称已经解决的那类「假命中」**——0.2.x 只堵住了 token 覆盖率那条路径，
反向包含这条一直漏着，而且是靠翻译功能给的 `primary`（最相近词条）才暴露出来的：
输入生造词，面板会一本正经地推荐一个 `XY Genotype`。

修法：反向包含要求 `key.length * 3 >= q.length`（键至少覆盖查询的 1/3）。
「非小细胞肺癌的」→「非小细胞肺癌」照样命中（18 ≥ 7），而 2 字符的 `xy` 匹配 11 字符查询被拒（6 < 11）。

**② 我自己写的边界判定与注释不符。**

`canEndAt()` 的注释写着规则是「空格**或汉字**旁边」，实现却只判断了空格：

```js
if (norm[end] === ' ') return true          // 漏掉了 norm[end] 是汉字的情形
return isCJKChar(norm[end - 1])
```

后果是**混合书写场景整片失效**：`her2阳性` 里的 `her2` 匹配不上（因为 `her2` 的最后一个字符是 `2`，
而下一个字符 `阳` 是汉字——旧实现两个条件都不满足）。`her2` 是 ERBB2 的常用写法，
肿瘤学文本里 `HER2阳性` 这种混写极常见。探针脚本打印 `matchAt -> null` 时才发现。
修法是抽出 `isBreakChar()`（空格或汉字），起止两侧都用它，与注释里的规则一致。

两个 bug 都补了**针对性回归断言**：`完全不存在的术语xyz` 必须 0 命中且 `primary === null`；
`her2neu` 必须 0 命中、`her2阳性` 必须命中且键为 `her2`。

`test-panel.mjs` 增至 153 项、`test-client.mjs` 增至 289 项、`test-onco-lexicon.mjs` 增至 56 项
（0.5.0 时分别是 111 / 210 / 48），新增部分覆盖：方向自动判定与手动覆盖、`missing` 标记
（无中文名不得编造）、分段拼接必须与原文逐字符一致、覆盖率、假命中回归、词边界回归、
工具层输出必须含「不是机器翻译」、非法方向由 schema 拦下、对照表与原文标注的取舍、
对照结果导出（BOM + CRLF + 免责行 + 无译名不标对照名）。

**另加一个跨两半的集成测试 `test-translate-integration.mjs`（157 项）**：起真实的 host 半、
加载真实词典、打真实 RPC，再把**真实 payload 交给真实的客户端组件**渲染。
之所以要单独做这一步——host 侧测试用真词典、client 侧测试用 stub，两边各自都通过，
但「host 真实返回的翻译结果能否被客户端渲染」没人验过。0.2.1 那次形状不匹配正是这样漏出去的。
它逐字段校验客户端会读的每个 key 都真实存在，并断言渲染出的对照行数 / 高亮数
等于 payload 里的 `translatedTerms`、每个译名都真的出现在渲染结果里。

### 已知限制

* **只有约 101 条词条带外部编码**。编码来自自建库，而 NCIt 源文件里没有 MeSH
  （`xref` 仅 IMDRF / UBERON），所以绝大多数 NCIt 条目**本地字段**查不到编码。
  0.7.0 起，本地未收录的术语可以经联网兜底拿到 NCIt C-code / MeSH D-code，
  但本地词条的 `codes` 字段本身没有变化，仍是"仅供线索"。
* `mesh:D002289` 这类带前缀查询，除目标词条外还会带出英文名含 "Mesh" 的词条
  （如上）。目标词条稳定排第一，属正常词面匹配。
* **`endpoint` 只有 18 条**，且全部来自人工整理——NCIt 语义类型不区分临床试验终点
  （见 0.4.0）。要把终点做全，只能继续扩充自建库。
* `category` 是语义类型的**粗粒度汇总**，仍有取舍：例如 `Cell or Molecular Dysfunction`
  被归入 `disease`，但 `Microsatellite Instability` 这类在临床上更常当标志物用。
  需要精确判断时请用 `ncitType` 维度，而不是 `category`。
* **翻译是术语级对照，不是机器翻译**（见 0.6.0）。它不做语序调整与语法重组，
  未被词典收录的部分原样保留。
* **中文覆盖只有 106 条**，这是中文段落术语标注的硬上限：中文原文只认词典里真实存在的中文名。
  中文段落若命中很少，请改用「术语检索」逐个查。
  **联网兜底也补不了中文名**：NCIt / MeSH 都是英文词表，纯中文查询直接跳过网络（见
  [中文边界](#中文边界重要限制)）。
* **翻译只做精确键匹配**，没有词形还原。NCIt 的英文同义词恰好覆盖了多数常见变形
  （`Patients` 命中 `Patient`、`received` 命中 `Receive`），但生僻变形可能漏。
  拼写有误时用「术语检索」+ 模糊检索。

### 0.6.1 —— 许可与署名落地

**没有任何代码或数据变化**，只补许可与包元数据：

* 新增 `LICENSE`（MIT，版权署名 `evilfies`）；
* 新增 `THIRD-PARTY-NOTICES.md`：NCIt OBO Edition 的 CC BY 4.0 署名文字、**本插件对其做的修改清单**
  （筛除 obsolete、`def` 截断至 400 字符、同义词与上位概念裁剪、按概念合并、打包版删除 `text`），
  以及「`NCI Thesaurus` 是商标、与 NCI 无隶属关系」的说明；
* 许可段把**代码（MIT）**与**随包数据（NCIt 侧为 CC BY 4.0）**分开写清 —— 之前只有一行 "MIT"，
  对外发布时会被误读成数据也是 MIT；
* `package.json` 补 `author` / `repository` / `homepage` / `bugs`
  （仓库：`someone628/cloneship`，本插件位于其 `dsh-onco-lexicon/` 子目录，故 `repository.directory` 指向该目录）；
* 打包脚本随包 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`，并把两者纳入"随包文本不得带 BOM"的校验清单
  （清单从 6 个文件扩到 8 个）。

> 起因：检索发现两个插件此前**既没有 LICENSE 文件，也没有 `repository` 字段**，
> 许可只以 `package.json` 里一行 `"license": "MIT"` 和 README 末尾一行 "MIT" 存在。

### 0.7.0 —— 联网兜底（本地优先）

新增 `lib/online.js`，把词典从"纯离线"改成"本地优先、联网兜底"。要点与实测见
[联网兜底](#联网兜底本地优先)一节，这里只记**改动清单**与**踩到的坑**：

* 新文件 `lib/online.js`（零依赖，用 Node 22+ 内置 `fetch`）：NCIt / MeSH 取数、TTL+LRU 缓存、
  错误归类、文本渲染、面板摘要；
* `onco_term` / `onco_abbr` 改为 async `execute`，本地零命中时接联网段；
  两者新增 `timeoutMs` 声明并把 `exec.signal` 接进联网层（取消可即时传导）；
* 系统提示词扩写：要求区分"本地词条"与"联网兜底"、写明联网源是英文词表、
  写明缩写联网召回不完整；
* 面板 RPC 的 `search` / `abbr` 在本地零命中时挂 `online` 字段（不计入本地检索耗时统计）；
  `stats` / `perf` 增加联网状态；客户端新增联网卡片、导出联网段、性能面板单列一组；
* 新增 `test-onco-online.mjs`：95 项（含真实网络 + 注入式故障），`--offline` 时 60 项纯离线可跑。

**写这一版踩到的三个坑**（都留在测试里当回归）：

1. **注入的 `fetchImpl` 没传进 ctx**。故障测试本来是"注入一个永不 resolve 的 fetch，
   验证超时降级"，但 `onlineLookup` 没把 `options.fetchImpl` 放进调用上下文，
   于是测试实际打的是真网络——"断网"用例因为真查到了结果而失败，反倒暴露了注入点是坏的。
   **教训：故障注入测试必须能证明注入真的生效**（否则它只是另一个 happy path）。
2. **把"没查成"说成了"不存在"**。多口径检索全失败时统一返回 `empty`，
   于是超时 / 断网都渲染成"上游没有返回条目"。现在按信息量取最能说明问题的错误码。
3. **`setTimeout(...).unref()` 让超时机制失效**。`unref()` 之后事件循环可能在定时器触发前就空了，
   表现为 Node 报 `unsettled top-level await`，整个兜底既不超时也不返回。
   这个定时器正是"有界延迟"的实现手段，**不能 unref**；生命周期交给 `finally` 里的 `clearTimeout`。

> 另有一处**既有**的不一致被顺手修掉：搜索模式的「导出 TXT」按钮用的是 `!hits.length`，
> 而 `doExport` 的判断已放宽到"有联网结果也可导出"，会出现"能导出但按钮是灰的"。

### 0.7.1 —— 噪声命中、假总数与缓存串号

这一版修的都是「看起来有结果、其实答错了」的缺陷：

* **联网缓存按有损键取值，返回了别的查询的结果**。缓存键用过 `normKey`（把非字母数字一律抹成
  空格），于是所有纯中文查询都塌成同一个空键——查过「高血压」再查「糖尿病」，会拿到「高血压」
  那段兜底结果（连 `query` 都回显着上一个词）；`ER+` 与 `ER` 同样撞键。现在缓存键用实际查询
  文本，只做大小写与空白归一。
* **中文查询靠一个汉字就算命中**。「磨玻璃结节」曾以 13% 覆盖率、51.9 分越过阈值，把
  「结直肠癌」「前哨淋巴结」当成结果返回——真正的「未收录」提示（以及本地零命中才触发的
  联网兜底）被这些噪声命中挡住。现在查询里有 ≥2 个汉字时，命中的汉字 token 至少要 2 个字
  才算数；共享二元组的合法弱匹配（「肝转移」→「转移」）不受影响。
* **`onco_abbr` 谎报义项数，并把别的缩写当义项**。结果被切到 10 条后，头部写「共有 10 个义项」，
  而 `PR` 的真实义项有 21 个；`MM` 的列表里混着 MMP-2 / MM-151 ——那是**别的缩写**。
  现在分「义项」与「同前缀的其它缩写」两栏，头部报真实总数，并新增 `topK`（默认 20，上限 50）。
* **筛查条件被绕过**。`onco_term` 带 `category` / `source` / `ncitType` 时，联网段曾挂着
  「已按…筛查」的横幅，而联网结果根本没有这些字段；面板 RPC 在「本地有命中、只是被筛查条件
  排除」时也会联网。两处现在都如实标注 / 不联网。
* **`onco_translate` 把英文功能词当术语**。`The patient received osimertinib; … was 50%`
  曾被标成 6 个术语、覆盖率 79.7%，其中 `was` → WAS 基因、`50` → Fifty、`received` → Receive。
  现在英译中方向先摘掉功能词与纯数字；`MET` / `ATM` 这类与基因同形的实词**不**屏蔽。
* **Windows 绝对路径 `dictPath` 让插件完全不可用**。`C:\…` 不是「以 `/` 开头」，被交给
  `new URL` 后 `c:` 被当成协议名，`fileURLToPath` 抛错，四个工具全部回答「词典不可用」。
  改用 `path.isAbsolute` + `pathToFileURL`。
* `onco_browse` 空结果不再一律归咎于类别：关键词 / 类型 / 出处筛空时分别说明是哪个条件筛空的。

## 许可

**代码**：MIT，全文见 [`LICENSE`](LICENSE)。版权署名：`evilfies`（Copyright (c) 2026 evilfies）。

**随包数据不在 MIT 覆盖范围内**：

| 数据 | 来源 | 许可 |
| --- | --- | --- |
| `data/onco.ncit.jsonl` | NCI Thesaurus OBO Edition（`ncit.obo`，NCI Enterprise Vocabulary Services 生产） | **CC BY 4.0**（须署名 + 标明修改） |
| `data/onco.seed.jsonl` | 本插件作者人工整理（106 条） | MIT（同 `LICENSE`） |

NCIt 是 **CC BY 4.0，不是 MIT**：本插件对它做了筛选、释义截断（≤ 400 字符）、同义词与上位概念裁剪、
以及与自建库按概念合并，因此**再分发时必须保留 NCIt 署名并说明这些修改**。
完整的署名文字、修改清单与商标说明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
`NCI Thesaurus` 是商标；本插件与 NCI 无隶属关系，也未获其认可。

种子词典里的 `codes.mesh` 只是 MeSH 描述符编号（如 `D002289`）引用，**未收录 MeSH 文本内容**。
