# cloneship

`someone628` 的 **DSH（DeepSeek Harness）插件单仓**。目前收录两个插件，都是「本地优先」的
医疗/文献工具：零 npm 依赖、零外部服务调用，数据随包发布。

> 推送时把本文件改名为仓库根目录的 `README.md` 即可（现有的 `README.md` 是 NCIt 构建笔记，
> 我没有覆盖它）。

| 子目录 | 插件 | 版本 | 从模型侧看到的工具 | 网络 |
| --- | --- | --- | --- | --- |
| [`dsh-onco-lexicon/`](dsh-onco-lexicon/) | 离线肿瘤学术语词典 | 0.6.1 | `onco_term` / `onco_abbr` / `onco_browse` / `onco_translate` | **全程不联网** |
| [`dsh-lit-translate/`](dsh-lit-translate/) | 文献翻译（学术英译中） | 0.1.1 | `lit_translate` | 只调用 DSH 当前默认模型 |

---

## 1. dsh-onco-lexicon —— 离线肿瘤学术语词典

面向肿瘤学/临床试验文本的**术语级**查询与对照，带一个可浏览的侧边栏面板。

**给模型用的四个工具**

| 工具 | 作用 |
| --- | --- |
| `onco_term` | 按中文名 / 英文名 / 缩写 / 别名 / 外部编码（如 `mesh:D002289`）查词条；可按 `category`（疾病 / 药物 / 标志物 / 临床试验终点…）、`source`、`ncitType` 筛查 |
| `onco_abbr` | 列出一个缩写的**全部义项**用于消歧（`OS` 有 10 个义项，`PD`、`MM` 等同样多义） |
| `onco_browse` | 按类别浏览词表，或确认词典覆盖范围 |
| `onco_translate` | 中英**术语级对照**：给一个术语的中英名，或从一段文本里找出命中的术语逐条对照 |

> ⚠️ **`onco_translate` 不是机器翻译。** 它只做术语替换，不做语序调整、语法重组与整句润色；
> 词典未收录的部分原样保留。硬把对照结果当译文使用，会产出"读起来很顺但内容是错的"文本，
> 对医学文本比"看不懂"更危险。

**数据**

| 来源 | 条数 | 许可 |
| --- | --- | --- |
| NCI Thesaurus OBO Edition（`ncit.obo`，NCI Enterprise Vocabulary Services 生产） | 185,880 | **CC BY 4.0** |
| 自建库（人工整理，含中文名 / 中文释义 / MeSH 编码引用） | 106（101 条并入 NCIt 概念，5 条独有） | MIT |
| 合计（按概念合并后） | **185,885** | — |

主词典 `data/onco.ncit.jsonl`（**81.6 MB / 77.9 MiB**）**随 tgz / npm 包发布，不在本 git 仓库里**
——它超过 GitHub 的 50 MB 单文件警告线；仓库中只放 106 条的种子词典 `data/onco.seed.jsonl`。
从仓库直接构建或运行前，请按 [`dsh-onco-lexicon/data/README.md`](dsh-onco-lexicon/data/README.md)
自行生成主词典，或直接取打包好的 tgz；缺主词典时插件会回退到种子词典
（中文查询仍可用，英文覆盖面降到 106 条）。启动时一次性同步载入内存（实测约 2.6 s）。

**NCIt 是 CC BY 4.0，不是 MIT。** 本插件对 NCIt 做了筛选（剔除 obsolete）、释义截断（≤ 400 字符）、
同义词与上位概念裁剪、以及与自建库按概念合并，因此再分发**必须保留 NCIt 署名并说明这些修改**。
完整的署名文字、修改清单、商标说明见
[`dsh-onco-lexicon/THIRD-PARTY-NOTICES.md`](dsh-onco-lexicon/THIRD-PARTY-NOTICES.md)。
种子词典里的 `codes.mesh` 只是 MeSH 描述符编号引用，**未收录 MeSH 文本内容**。

---

## 2. dsh-lit-translate —— 文献翻译

把「学术英译中」单独抠出来的插件：粘贴或导入 txt / md → 自动切段 → 逐段翻译 → 对照阅读 → 导出 Markdown。

* 术语首次出现写成「中文（English）」，例如「风险比（hazard ratio, HR）」，可一键切换纯中文；
* 逐段翻译时把**上一段原文与译文**作为 context 传入，减少同一术语前后译法不一致；
* 断点续翻（原文完全一致的段落沿用已有译文）、工作稿自动落盘；
* 提示词按医学/流行病学文献口径写死（方法名、统计量、量表名、基因与蛋白名、药物名的处理规则）。

> 译文由 DSH 当前默认模型生成。**模型输出的使用还受对应模型服务方条款约束**，与本插件的 MIT 无关。

---

## 3. 安装

前提：Node.js ≥ 22，DSH 已安装，且你有一个 Web profile（下例为 `web`）。

两个插件都以 **tgz** 安装（**不要用 `link:`** —— 详见各插件 README 里 junction 与裸模块解析的说明）：

```powershell
# 1) 先删后装；升级时务必递增版本号
dsh plugin --profile web remove dsh-onco-lexicon
dsh plugin --profile web add file:<dsh-onco-lexicon-0.6.1.tgz 的绝对路径>

dsh plugin --profile web remove dsh-lit-translate
dsh plugin --profile web add file:<dsh-lit-translate-0.1.1.tgz 的绝对路径>
```

安装后重载或重启 DSH：侧边栏会出现「术语词典」与「文献翻译」两个入口。
本单仓的 tgz 由根目录的 `build-package.ps1` 与 `build-package-lit-translate.ps1` 生成
（脚本内含随包文件的 BOM 校验等不变量检查）。

---

## 4. 许可与版权

本仓库是**单仓**，版权分属不同作者：

| 范围 | 许可 | 版权署名 |
| --- | --- | --- |
| 根目录（构建脚本、文档） | MIT | `Copyright (c) 2026 someone628` |
| `dsh-onco-lexicon/` | MIT（代码） | `Copyright (c) 2026 evilfies` |
| `dsh-lit-translate/` | MIT | `Copyright (c) 2026 director` |
| `dsh-onco-lexicon/data/onco.ncit.jsonl` | **CC BY 4.0**（NCIt 派生数据，非 MIT） | NCI Enterprise Vocabulary Services |

各子目录内的 `LICENSE` 各自写明其版权人，可脱离本仓库独立分发；根目录的 [`LICENSE`](LICENSE)
说明了"子目录版权归各自作者"这一分工。数据侧的第三方义务见
[`dsh-onco-lexicon/THIRD-PARTY-NOTICES.md`](dsh-onco-lexicon/THIRD-PARTY-NOTICES.md)。

---

## 5. 状态

* 两个插件均已在本机 DSH Web profile 上安装并实测可用；
* **尚未提交到 dsh.so 插件注册表**（截至 2026-09-30，`https://www.dsh.so/plugin/dsh-onco-lexicon.json`
  与 `.../dsh-lit-translate.json` 均为 404）。
