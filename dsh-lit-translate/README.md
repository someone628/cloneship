# dsh-lit-translate —— 文献翻译（DSH 插件）

把 **dsh-literature-reading（文献阅读）里的翻译链路单独抠出来**做成的一个配套插件。

文献阅读是个大工作台：文献卡片 13 栏、PDF 导入与文本抽取、真实版式渲染、思维导图、阅读进度……
其中「翻译」是最常单独使用的一块。这个插件只做那一块，因此可以独立安装、独立使用，
不需要文献阅读在场，也不会碰它的数据目录。

---

## 1. 它做什么 / 不做什么

**做：**

| 能力 | 说明 |
| --- | --- |
| 学术英译中 | 用 DSH 当前默认模型翻译，提示词按医学/流行病学文献口径写死（方法名、统计量、量表名、基因与蛋白名、药物名的处理规则都在里面） |
| 术语附英文 | 术语首次出现写成「中文（English）」，例如「风险比（hazard ratio, HR）」；可一键关掉换成纯中文 |
| 逐段翻译 + 上文参考 | 把上一段原文（及其译文）作为 context 传给模型，减少同一术语前后译法不一致 |
| 面板工作流 | 粘贴或导入 txt / md → 切段 → 逐段翻译 / 只翻未译 / 全部重译 / 中途停止 → 对照阅读 → 复制或导出 Markdown |
| 断点续翻 | 原文完全一致的段落会沿用已有译文；工作稿自动落盘，重开面板还在 |
| MeSH 术语约束 | 内置 MeSH 2026 离线索引（355,232 条记录）：翻译前把原文命中的术语收敛到 MeSH 规范名，附释义与 MeSH 编号一起注入提示词；面板上是「MeSH 术语约束」开关，卡片上显示本段命中数 |
| 给模型的工具 | `lit_translate`，让模型在对话里直接翻文献段落 |

**不做（都属于文献阅读插件，故意不在这里重复）：**

- PDF 导入与文本抽取、真实版式渲染
- 文献卡片、表格总览、TSV 导出
- 思维导图、阅读进度与计时

> 抠出来时的取舍：只保留翻译链路，所以这个插件**零 npm 依赖、零网络请求**（除了调用 DSH 默认模型本身）。
> 面板里的「导入 txt / md」是浏览器端读文件，不上传、不落盘到别处。
>
> 术语层是**离线索引**，不联网：随包分发 `data/mesh_index.bin`（74 MiB，MeSH 2026 派生，见
> [`data/README.md`](data/README.md) 与 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)）。

---

## 2. 安装

### 方式一：从源码目录 link（开发时用）

```powershell
dsh plugin --profile web add link:C:\path\to\cloneship\dsh-lit-translate
```

### 方式二：打包后安装（推荐发给别人时用）

```powershell
powershell -File build-package-lit-translate.ps1
dsh plugin --profile web add file:C:\path\to\cloneship\dsh-lit-translate-0.1.1.tgz
```

安装后需要**重载或重启 DSH**，侧边栏才会出现「文献翻译」入口。

> 本机 DSH 运行时未附带 TypeScript 编译器，插件以纯 ESM JavaScript 交付，入口 `lib/index.js`，
> 没有构建步骤。

---

## 3. 面板怎么用

侧边栏点「译」字徽标，或从面板列表选「文献翻译」。

1. **给原文**：把英文文献正文粘进输入框，或点「导入 txt / md」选文件（UTF-8）。
2. **切段**：空行分段是首选切法；单段超过 1400 字符会按句子再切；过短的相邻碎块会合并
   （合并是**有意**的：逐条翻几个词的碎片，中文连贯性和成本都更差）。
   也可以直接点「翻译未译段」，它会先自动切段再翻。
3. **翻译**：
   - 「翻译未译段」只翻还没有译文的段，适合中断后继续；
   - 「全部重译」把所有段重来一遍；
   - 「停止」在当前段翻完后停下，已经翻好的段落不会丢。
4. **两个开关**（外加第三个）：
   - 「术语附英文原文」：开 = 术语首次出现附英文（便于核对原文用词）；关 = 纯中文译文。
   - 「带上一段作参考」：把上一段原文与译文作为上文，建议开着。
   - 「MeSH 术语约束」：开 = 翻译前用本地 MeSH 2026 索引把原文命中的术语收敛到规范英文名
     （附释义与 MeSH 编号）注入提示词；关 = 纯翻译。索引不可用时这一项自动置灰，并在面板上说明原因。
5. **拿走结果**：「复制译文」把已译段落连起来复制；「导出对照」/「导出译文」下载 Markdown。
6. **自动保存**：改动停下约 1 秒后写入 `$DSH_HOME/lit-translate/doc.json`；
   拿不到 host 时退回浏览器 localStorage，面板会告诉你恢复自哪里。

译文由默认模型产出，是**机器翻译**，仅供阅读参考；正式引用或做判断前请核对英文原文。
界面上也这么写着。

---

## 4. 给模型的工具：`lit_translate`

和 `onco_translate`（离线词典的术语级对照）形成互补：词典工具管术语，这个工具管整段学术翻译。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 要翻译的英文内容 |
| `context` | 否 | 上一段原文（可含其译文），只用于统一术语与指代，不会被翻译 |
| `annotate` | 否 | 术语首次出现是否附英文，默认取配置项 `annotate`（默认 true） |
| `mesh` | 否 | 本次是否启用 MeSH 术语约束，默认取配置项 `mesh`（默认 true）；关掉后只做纯翻译 |

工具输出是带表头的纯文本：标明模型名、本次原文长度、是否带上文、**本次 MeSH 术语约束的命中情况**
（命中几个 / 索引不可用没生效 / 调用方主动关掉，三种状态分开写清楚），末尾声明「这是机器译文」，
并在译文被模型输出上限截断时明确警告——避免模型把一份截断的、或自己没核对过的译文
当成结论转述给用户。

插件同时往系统提示词里加了一段 `lit-translate-usage`，约定：长文按段落调用、逐段传 `context`、
查术语仍走 `onco_translate`、MeSH 只有英文不能当成中文名依据、不要把它当文献解读工具用。

### 4.1 MeSH 术语约束到底做了什么

MeSH（医学主题词表）由美国国家医学图书馆（NLM）生产，**只有英文，没有中文名**。
所以这一层做的事只有三件：

1. **收敛写法**：`progression-free survival` → 规范名 `Progression-Free Survival`（`mesh:D000077982`），
   同一篇文献里同一概念的英文写法先统一，中文译法才容易前后一致；
2. **辅助消歧**：把该条目的 ScopeNote 截断后一起给出，供模型区分同形词；
3. **可回查**：给出 MeSH 编号与类别，便于人工核对。

它**不产出任何中文译名**——MeSH 里没有中文，任何「MeSH 官方中文名」都是编的。
提示词里也写死了这条约束，`test-mesh.mjs` 与 `test-lit-translate.mjs` 各有一条断言守着它。

匹配口径（都在 `lib/mesh.js` 里，参数可调）：

| 情况 | 处理 |
| --- | --- |
| 多词短语命中（`non-small cell lung carcinoma`） | 直接采用，最长匹配优先、不重叠 |
| 单字命中 | 需同时满足：不是高频泛化词（`patients`/`study`/`blood` 等约 150 词的词表）、长度 ≥ 5、候选记录数少；**全大写缩写**（`GWAS`/`EGFR`/`IL-6`）直接放行 |
| 单字命中限定词缩写 | **一律拒绝**：`CI` 是限定词 `chemically induced` 的缩写，否则「95% CI」会被误当成术语；多词限定词（`adverse effects`）仍放行 |
| 同一概念多次出现 | 只报第一次 |
| 命中太多 | 按「词更长 → 更少见」优先，默认最多注入 40 个，块长上限 3600 字符 |

匹配本身很便宜：整段 1400 字符约 **1–2 ms**（索引整份加载约 22 ms，只在第一次翻译时加载）。

---

## 5. 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxChars` | `120000` | 单次翻译的原文上限（字符）。超过时报错并提示先切段，避免一次塞爆上下文 |
| `annotate` | `true` | 调用方没写 `annotate` 时的默认值 |
| `dataDir` | `null` | 工作稿目录；留空 = `$DSH_HOME/lit-translate` |
| `mesh` | `true` | 是否启用 MeSH 术语约束；关掉 = 纯翻译（此时术语一致性只靠 `context`） |
| `meshIndexFile` | `null` | 索引文件路径；留空 = 插件自带 `data/mesh_index.bin` |
| `meshMaxTerms` | `40` | 单次最多注入多少个术语 |
| `meshDefChars` | `120` | 每个术语释义截断到多少字符 |
| `meshMaxBlockChars` | `3600` | 术语块总长度上限（字符），防止提示词被术语表吃掉 |

想改配置，在 profile 的 `cordis.patch.yml` 里按 id 覆盖（不要改插件包里的那份）：

```yaml
- id: dsh-lit-translate
  config:
    maxChars: 60000
    annotate: false
    mesh: true
    meshMaxTerms: 25
```

---

## 6. 数据与隐私

- 工作稿：`$DSH_HOME/lit-translate/doc.json`（原文 + 各段译文 + 各开关），先写 `.tmp` 再 rename，避免写坏。
- 损坏容错：`doc.json` 坏掉时按「没存过」处理，面板照样能打开，不会因为一个坏文件就白屏。
- 翻译请求：只把原文发给你在 DSH 里配置的模型服务商；插件自身不联网、不加载任何远程资源
  （侧边栏图标是 CSS 画的「译」字，没有外部图片）。
- MeSH 术语索引：`data/mesh_index.bin`，**离线随包分发**，不联网、不上传、不写入任何数据目录；
  只在内存里读（整份约 74 MiB，首次翻译时加载，约 22 ms）。
- 导出的 Markdown 在浏览器本地生成，不上传。
- 数据来源署名：MeSH 由 NLM 生产，本插件与其无关联、未获其认可；索引是 MeSH 2026 的**快照派生件**，
  不代表 NLM 当前最新数据。条款要点、署名文字与全部改动清单见
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

---

## 7. 开发与自测

```powershell
node test-lit-translate.mjs   # 插件本身：146 项检查
node test-mesh.mjs            # MeSH 术语层：69 项检查（含与 Python 索引的跨语言一致性）
```

`test-lit-translate.mjs` 覆盖：

- host 半：三份提示词的组合、`llmTrouble` 报错人话化、工具注册与 `execute`、
  RPC 的 `ping` / `translate` / `load` / `save` / `segments`、空原文与超长原文的拒绝、
  模型报余额不足 / 空输出 / max-tokens 截断、工作稿落盘与坏文件容错；
  **MeSH 部分**：提示词里确实注入了术语块且含规范名与 MeSH 编号、块里没有中文译名、
  `mesh=false` 时不注入、工具输出区分「命中 N 个 / 未生效 / 已关闭」、
  **索引缺失时翻译照常成功并带回警告**；
- 浏览器半：切段语义（含 host 与 client 两份实现口径一致的断言）、重新切段沿用译文、
  上文参考、导出 Markdown；
- 端到端：用极小的 React 替身把面板真跑起来 + stub `fetch`，走真实交互
  （输入原文 → 点「翻译未译段」→ 三段译文出现 → 自动保存 → 复制 → 导出 → 单段重译），
  以及两条失败路径（模型报错、host 不可达）；
  MeSH 开关的勾选/取消会传到 host，卡片上的 `MeSH N` 标记随之出现/消失。

`test-mesh.mjs` 覆盖：归一化与 Python 逐例对齐、分词（撇号、连字符）、单字接受规则、
索引头/计数与清单一致、术语升序与二分自命中、**用 Python 产出的 `mesh_fixtures.json` 逐条比对命中**、
真实段落匹配（含 `CI` 误命中必须被拦住）、`maxTerms` 截断、提示词块措辞与长度上限、
以及「索引缺失 / 垃圾文件 / 过短文件」三类失败路径。

测试前置条件：插件目录下 `node_modules/@deepseek-ai/dsh-tools` 必须可解析。首次在本机跑时建一次链接：

```powershell
$host_ = "$env:LOCALAPPDATA\Programs\ds-harness-desktop\runtime\host\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path .\dsh-lit-translate\node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction -Path .\dsh-lit-translate\node_modules\@deepseek-ai\dsh-tools -Target "$host_\dsh-tools"
```

> `test-mesh.mjs` 需要 `dsh-lit-translate/data/mesh_index.bin`（随包分发，仓库里没有）；
> 文件缺失时它会明确报错并指出重建命令，而不是静默跳过。
>
> 打包脚本只复制 `lib`、`data`、`cordis.patch.yml`、`skill.md`、`README.md`、`LICENSE`、
> `THIRD-PARTY-NOTICES.md`，这个测试用的 `node_modules` 链接不会被带进 tgz。

---

## 8. 已知限制

1. **依赖默认模型可用**：没有配置模型、Key 失效、余额不足时翻译会失败。插件会翻译成人话
   （「余额/额度不足 —— 去服务商控制台充值」之类），界面与导出仍可用。
2. **不导入 PDF**：只吃文本。要 PDF，请用文献阅读插件导入后把正文拷过来，
   或在对话里让模型先抽取文本再交给 `lit_translate`。
3. **`lit_translate` 是一次嵌套的模型调用**：模型在对话里调用它时，插件会用同一套默认模型
   单独发一次翻译请求。好处是提示词与格式统一、术语规则稳定；代价是多一次往返。
   如果某天嵌套调用被上游限制，工具会返回明确的失败文案并建议模型自行翻译，
   不会静默给出空结果。
4. **切段是启发式**：按空行 + 句末标点切，双栏 PDF 抽出的文本、表格、公式仍可能切得不好。
   面板可以只翻选中不行——目前没有「手动调整单段边界」的入口，切成不理想时建议先整理原文。
5. **术语一致性靠上文参考 + MeSH 约束，但都不是硬保证**。MeSH 只能收敛它收录的英文写法，
   中文译名仍由模型决定；要严格的术语统一，配合 `dsh-onco-lexicon` 的术语查询使用。
6. **MeSH 覆盖有限，命中为空是常态而非故障**：
   - `PD-L1`、`NSCLC`、`hazard ratio` 这类大家习惯的写法，MeSH 2026 里**没有**对应条目
     （只有 `PD-L1 Costimulatory Protein`、`PD-1 Protein`、`Proportional Hazards Models` 这类全称），
     所以命中为空时不要以为是索引坏了；
   - MeSH 是**英语受控词表**，没有中文名，也不做跨语言映射；
   - 匹配是**字面匹配**：词序不同就匹配不上（`Antibodies, Monoclonal` 不会命中正文里的
     `monoclonal antibodies`），查询与条目之间不共享字词时不命中；这不是语义检索；
   - 索引是 2026 版快照（355,232 条记录 / 840,392 个检索名 / 74.0 MiB）。
7. **单字约束偏保守**：高频泛化词（`patients`、`study`、`blood`…）与限定词缩写（`CI`、`AD`）被刻意排除，
   宁可少给一点约束，也不要把噪音塞进提示词。要调整可改 `meshMaxTerms` / `meshDefChars`，
   或在 `lib/mesh.js` 的 `STOPWORDS` 与 `DEFAULT_MESH_OPTIONS` 里改口径（`test-mesh.mjs` 会守着这些行为）。

---

## 9. 与文献阅读插件的关系

两个插件**并存、互不干扰**：翻译功能在原插件里原样保留（勾划即翻、分段对照那些交互都在），
本插件是同一套翻译能力的独立出口。

- 不读也不写文献阅读的数据目录（`$DSH_HOME/literature-reading`）；
- 提示词与文献阅读 v1.19.0 逐字一致（`SYSTEM_ANNOTATE` / `SYSTEM_PLAIN` / `CONTEXT_RULE`），
  翻译质量调参请两边一起改，避免同一个模型在两处表现不一致；
- 两边的切段算法同源（host 与 client 各一份，测试里有口径一致的断言）。

## 10. 协议

**MIT**，全文见 [`LICENSE`](LICENSE)。版权署名：`director`（Copyright (c) 2026 director）。

补充说明：

- 本插件**零 npm 依赖**：`package.json` 无 `dependencies`，运行时不联网、不加载远程资源；
- **但随包带了第三方数据**：`data/mesh_index.bin` 是由 NLM 的 MeSH 2026 派生的索引，
  **不在 MIT 覆盖范围内**，须遵守 NLM 的 MeSH 条款（署名 NLM、不得暗示背书、说明所用版本、
  NLM 不作担保，且本索引是 2026 版快照而非最新数据）。条款要点、建议署名文字与改动清单见
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；
- 提示词（`SYSTEM_ANNOTATE` / `SYSTEM_PLAIN` / `CONTEXT_RULE`）与切段口径来自
  `dsh-literature-reading` v1.19.0（MIT），在同一许可下使用；
- 译文由 DSH 当前默认模型生成，**模型输出的使用还受对应模型服务方条款约束**，与本插件的 MIT 无关。

## 11. 更新日志

### 0.2.1 —— 术语噪声、损坏索引与面板配置

* **单字命中的错配概念**：`adjustment` → Adaptation, Psychological、`association` → Association、
  `compliance` → Compliance 这类「普通英文词撞上 MeSH 入口词」的约束，会把统计学的
  「校正 / 关联 / 依从」推向心理学或生理学概念。现在单字命中必须**就是该 MeSH 记录的规范名**、
  且不落在 `concept` 抽象桶里；全大写缩写（HR、GWAS、EGFR）不受此限，多词短语照旧
  （代价是 `statin` → HMG-CoA 还原酶抑制剂这类纯同义词映射不再注入——这条通道的价值在于准）。
* **逗号不是边界，n-gram 拼出假短语**：`age, sex, education, income` 里的「sex, education」
  曾命中 Sex Education（D012736），提示词里出现原文根本没有的术语。逗号已纳入片段边界
  （MeSH 的倒置词条因此不再匹配，其规范名照旧命中）。
* **出版物特征被当成术语**：`Overall`（D016424，一种出版物类型）曾被注入提示词。
  树号 `V*` 的单字命中一律不接受。
* **头部合法但正文被截断的 MeSH 索引会让翻译整个失败**：`ping` 报「355,232 条」看起来健康，
  真去翻译却抛 RangeError（工具直接抛栈、面板只显示一句 Node 报错）。现在构造函数与
  `status()` 都会核对偏移表是否落在文件内：索引不可用时如实报出，翻译按文档承诺照常进行
  （只是这一次没有术语约束）。
* **面板无视宿主配置**：`ping` 回传的 `maxChars` / `annotate` / `mesh.enabled` 之前没被使用——
  配置 `maxChars: 1000` 时面板仍按 1400 切段，每一段都被宿主以「超过单次上限」拒掉，
  批量翻译在第一段就中断，面板一个字都翻不了。现在切段按宿主上限、两个开关的初值取配置，
  并按 `meshDisabled` 显示「MeSH 未启用」（与「0 命中」区分开）。
* **`annotate: false` 与术语块措辞冲突**：纯中文模式的系统提示词写着「专业术语不要附英文原文」，
  术语块却仍要求「上述英文术语按 MeSH 规范名书写」。现在措辞随 `annotate` 切换。
* 顺带修掉：人话提示（余额 / 限流）在工具失败信息里出现两遍；面板 500 的原始报错
  （`Expected property name or '}' …`、RangeError）改为「插件内部错误（已记录到 DSH 日志）」
  并把原始信息写进日志；`finish` 只给了 `aborted` / `error` 而没带 `failure` 时也按失败处理
  ——半截译文不再被当成完整结果返回。

### 0.2.0

加入 MeSH 2026 离线术语层（`lib/mesh.js` + `data/mesh_index.bin`）：翻译时把原文命中的英文术语
收敛到 MeSH 规范名并附释义与编号，工具输出与面板各多一行「本次约束了什么」。

### 0.1.x

从 `dsh-literature-reading` v1.19.0 中把「学术英译中」拆出来独立成插件：
粘贴 / 导入 txt·md → 自动切段 → 逐段翻译 → 对照阅读 → 导出 Markdown，支持上文参考与断点续翻。
