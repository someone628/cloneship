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
| 给模型的工具 | `lit_translate`，让模型在对话里直接翻文献段落 |

**不做（都属于文献阅读插件，故意不在这里重复）：**

- PDF 导入与文本抽取、真实版式渲染
- 文献卡片、表格总览、TSV 导出
- 思维导图、阅读进度与计时

> 抠出来时的取舍：只保留翻译链路，所以这个插件**零 npm 依赖、零网络请求**（除了调用 DSH 默认模型本身）。
> 面板里的「导入 txt / md」是浏览器端读文件，不上传、不落盘到别处。

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
4. **两个开关**：
   - 「术语附英文原文」：开 = 术语首次出现附英文（便于核对原文用词）；关 = 纯中文译文。
   - 「带上一段作参考」：把上一段原文与译文作为上文，建议开着。
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

工具输出是带表头的纯文本：标明模型名、本次原文长度、是否带上文，末尾声明「这是机器译文」，
并在译文被模型输出上限截断时明确警告——避免模型把一份截断的、或自己没核对过的译文
当成结论转述给用户。

插件同时往系统提示词里加了一段 `lit-translate-usage`，约定：长文按段落调用、逐段传 `context`、
查术语仍走 `onco_translate`、**不要**把它当文献解读工具用。

---

## 5. 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxChars` | `120000` | 单次翻译的原文上限（字符）。超过时报错并提示先切段，避免一次塞爆上下文 |
| `annotate` | `true` | 调用方没写 `annotate` 时的默认值 |
| `dataDir` | `null` | 工作稿目录；留空 = `$DSH_HOME/lit-translate` |

想改配置，在 profile 的 `cordis.patch.yml` 里按 id 覆盖（不要改插件包里的那份）：

```yaml
- id: dsh-lit-translate
  config:
    maxChars: 60000
    annotate: false
```

---

## 6. 数据与隐私

- 工作稿：`$DSH_HOME/lit-translate/doc.json`（原文 + 各段译文 + 两个开关），先写 `.tmp` 再 rename，避免写坏。
- 损坏容错：`doc.json` 坏掉时按「没存过」处理，面板照样能打开，不会因为一个坏文件就白屏。
- 翻译请求：只把原文发给你在 DSH 里配置的模型服务商；插件自身不联网、不加载任何远程资源
  （侧边栏图标是 CSS 画的「译」字，没有外部图片）。
- 导出的 Markdown 在浏览器本地生成，不上传。

---

## 7. 开发与自测

```powershell
node test-lit-translate.mjs
```

当前 **118 项检查**，覆盖：

- host 半：三份提示词的组合、`llmTrouble` 报错人话化、工具注册与 `execute`、
  RPC 的 `ping` / `translate` / `load` / `save` / `segments`、空原文与超长原文的拒绝、
  模型报余额不足 / 空输出 / max-tokens 截断、工作稿落盘与坏文件容错；
- 浏览器半：切段语义（含 host 与 client 两份实现口径一致的断言）、重新切段沿用译文、
  上文参考、导出 Markdown；
- 端到端：用极小的 React 替身把面板真跑起来 + stub `fetch`，走真实交互
  （输入原文 → 点「翻译未译段」→ 三段译文出现 → 自动保存 → 复制 → 导出 → 单段重译），
  以及两条失败路径（模型报错、host 不可达）。

测试前置条件：插件目录下 `node_modules/@deepseek-ai/dsh-tools` 必须可解析。首次在本机跑时建一次链接：

```powershell
$host_ = "$env:LOCALAPPDATA\Programs\ds-harness-desktop\runtime\host\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path .\dsh-lit-translate\node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction -Path .\dsh-lit-translate\node_modules\@deepseek-ai\dsh-tools -Target "$host_\dsh-tools"
```

> 打包脚本只复制 `lib`、`cordis.patch.yml`、`skill.md`、`README.md`、`package.json`，
> 这个测试用的 `node_modules` 链接不会被带进 tgz。

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
5. **术语一致性靠上文参考**，不是术语库强制。要严格的术语统一，配合
   `dsh-onco-lexicon` 的术语查询使用。

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

- 本插件**零 npm 依赖、不随包任何第三方数据**，所以 MIT 之外没有别的许可条款要遵守；
- 提示词（`SYSTEM_ANNOTATE` / `SYSTEM_PLAIN` / `CONTEXT_RULE`）与切段口径来自
  `dsh-literature-reading` v1.19.0（MIT），在同一许可下使用；
- 译文由 DSH 当前默认模型生成，**模型输出的使用还受对应模型服务方条款约束**，与本插件的 MIT 无关。
