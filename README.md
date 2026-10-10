# cloneship

`someone628` 的 **DSH（DeepSeek Harness）插件单仓**。目前收录三个插件，都是「本地优先」的
医疗/文献工具：零 npm 依赖、零外部服务调用，数据随包发布。

> 推送时把本文件改名为仓库根目录的 `README.md` 即可（现有的 `README.md` 是 NCIt 构建笔记，
> 我没有覆盖它）。

| 子目录 | 插件 | 版本 | 从模型侧看到的工具 | 网络 |
| --- | --- | --- | --- | --- |
| [`dsh-onco-lexicon/`](dsh-onco-lexicon/) | 离线肿瘤学术语词典 | 0.7.1 | `onco_term` / `onco_abbr` / `onco_browse` / `onco_translate` | 本地优先，零命中时联网兜底 |
| [`dsh-lit-translate/`](dsh-lit-translate/) | 文献翻译（学术英译中） | 0.2.1 | `lit_translate` | 只调用 DSH 当前默认模型 |
| [`dsh-ct-norm/`](dsh-ct-norm/) | CT 报告实体归一化 | 0.1.1 | `ct_norm` / `ct_lexicon` | **全程不联网、不调用模型** |

改动记录见 [`CHANGELOG.md`](CHANGELOG.md)（含每个版本修了什么、被哪条测试盯住）。

---

## 1. dsh-onco-lexicon —— 离线肿瘤学术语词典

面向肿瘤学/临床试验文本的**术语级**查询与对照，带一个可浏览的侧边栏面板。

**给模型用的四个工具**

| 工具 | 作用 |
| --- | --- |
| `onco_term` | 按中文名 / 英文名 / 缩写 / 别名 / 外部编码（如 `mesh:D002289`）查词条；可按 `category`（疾病 / 药物 / 标志物 / 临床试验终点…）、`source`、`ncitType` 筛查 |
| `onco_abbr` | 列出一个缩写的**全部义项**用于消歧（`OS`、`PD`、`MM` 都高度多义）；义项按「缩写字段真的写着它」判定，同前缀的其它缩写（`MM` → MMP-2 / MM-151）单独成段，不混进义项 |
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

## 3. dsh-ct-norm —— CT 报告实体归一化

把中文 CT 报告里的**自由描述**（「右肺上叶见一 2.3cm 结节影」「纵隔及右肺门见多发肿大淋巴结」
「肝内多发低密度灶」…）按本地人工整理的词表，**确定性**映射到 **MeSH 2026 标准概念**
（规范名 + `mesh:D######` 编号 + 树号）。要解决的就是「同一个影像发现，临床医生写法五花八门」——
「胸腔积液 / 胸膜腔积液 / 胸水 / 胸腔内积液」是同一个概念。

**给模型用的两个工具**

| 工具 | 作用 |
| --- | --- |
| `ct_norm` | 输入报告原文，输出「实体 → MeSH 概念」对照表；分四栏：归一化结果 / 未归一化 / 概念汇总 / 仅识别到部位。`format: "json"` 拿结构化结果 |
| `ct_lexicon` | 查词表本身：某写法对应哪个 MeSH 概念、收录了哪些写法、某编号有哪些中文写法、以及**没**收录什么 |

**与另外两个插件的关键差别：它不调用模型。** 归一化只走两条路径——词表命中，或
「部位 + 形态学词」的固定规则组合。所以同一段报告跑一百次，结果逐字节相同。

**它凭什么可信（这是本插件最花心思的地方）**

| 做法 | 后果 |
| --- | --- |
| 源词表里**只写 MeSH 英文规范名**，不写编号 | 人没有机会写错编号 |
| 构建时把规范名拿去 NLM 索引**反解**，反解不到就**构建失败** | 编号只有一个来源 |
| 运行时只读**从索引提取的 370 条概念子集**（111 KiB） | 插件在物理上产不出子集之外的编号 |
| 打包脚本扫描源文件，出现手写 `D######` 就**拒绝打包** | 这条性质不会在某次手改后悄悄失效 |
| 测试遍历**每一个别名**（2190 个），验证它真的能命中 | 「写进词表」≠「真的能用」 |

以及一条同样重要的：**MeSH 收录不了的东西，它就不映射，并如实报出来。**
MeSH 主题词表以**疾病实体**为粒度——`pleural effusion`、`lymphadenopathy`、
`spinal cord compression` 有命中；而 `ground-glass opacity`、`spiculated margin`、
`liver metastasis`、`bowel wall thickening`、`osteolytic lesion` 在全量索引里**一条都没有**。
磨玻璃影、毛刺、分叶、低密度灶、壁增厚这些一律进「未归一化」栏并附上原因，不猜。

**数据**

| 内容 | 数量 | 许可 |
| --- | --- | --- |
| 写法条目（人工整理） | 327 | MIT |
| 表面写法（中文 / 英文别名） | 2190 | MIT |
| 可产出的 MeSH 概念（子集上限） | 370 | NLM MeSH 2026 派生，**非 MIT** |
| 未归一化征象词 | 33 组 | MIT |

整包 **163.0 KiB**（不需要那 74 MiB 的全量 MeSH 索引，只带一份概念子集），
因此**可以直接进 git 仓库**，不像另外两个插件那样要单独分发大文件。
重建步骤见 [`dsh-ct-norm/data/README.md`](dsh-ct-norm/data/README.md)，
第三方条款见 [`dsh-ct-norm/THIRD-PARTY-NOTICES.md`](dsh-ct-norm/THIRD-PARTY-NOTICES.md)。

---

## 4. 安装

前提：Node.js ≥ 22，DSH 已安装，且你有一个 Web profile（下例为 `web`）。

三个插件都以 **tgz** 安装（**不要用 `link:`** —— 详见各插件 README 里 junction 与裸模块解析的说明）：

```powershell
# 1) 先删后装；升级时务必递增版本号
dsh plugin --profile web remove dsh-onco-lexicon
dsh plugin --profile web add file:<dsh-onco-lexicon-0.7.1.tgz 的绝对路径>

dsh plugin --profile web remove dsh-lit-translate
dsh plugin --profile web add file:<dsh-lit-translate-0.2.1.tgz 的绝对路径>

dsh plugin --profile web remove dsh-ct-norm
dsh plugin --profile web add file:<dsh-ct-norm-0.1.1.tgz 的绝对路径>
```

安装后重载或重启 DSH：侧边栏会出现「术语词典」「文献翻译」「CT 归一化」三个入口。
本单仓的 tgz 由根目录的 `build-package.ps1`、`build-package-lit-translate.ps1`
与 `build-package-ct-norm.ps1` 生成
（脚本内含随包文件的 BOM 校验等不变量检查；ct-norm 那份还会校验
「源词表里不得出现手写 MeSH 编号」）。

---

## 5. 主词典怎么分发

`dsh-onco-lexicon/data/onco.ncit.jsonl` 有 **81.6 MB（77.9 MiB）**，**不进 git 历史**。给它三条出口：

1. **GitHub Release 附件（推荐）** —— 直接挂打包好的 tgz，主词典已经在里面：

   ```powershell
   powershell -File build-package.ps1     # 产出 dsh-onco-lexicon-0.7.1.tgz（约 12.9 MB，主词典在内）
   gh release create v0.7.1 dsh-onco-lexicon-0.7.1.tgz --title "dsh-onco-lexicon 0.7.1"
   ```

   （没装 `gh` 就在仓库的 Releases 页面手动上传同一个 tgz。）使用者下载后
   `dsh plugin --profile web add file:<下载路径>` 即可，**不需要自己生成词典**。

2. **npm 发布** —— `npm publish dsh-onco-lexicon-0.7.1.tgz`：包内 `files` 已包含数据文件，
   整包约 12.9 MB，其中绝大部分是词典。

3. **使用者自行生成** —— 见 [`dsh-onco-lexicon/data/README.md`](dsh-onco-lexicon/data/README.md)：
   取 `ncit.obo`（CC BY 4.0）后跑 `prep_ncit_obo.py` + `build-plugin-dict.py`。

> 一个都不做也能用：仓库里带着 106 条的种子词典，插件会自动回退到它
> （中文查询仍可用，英文覆盖面大幅缩小）。

---

## 6. 许可与版权

本仓库是**单仓**，版权分属不同作者：

| 范围 | 许可 | 版权署名 |
| --- | --- | --- |
| 根目录（构建脚本、文档） | MIT | `Copyright (c) 2026 someone628` |
| `dsh-onco-lexicon/` | MIT（代码） | `Copyright (c) 2026 evilfies` |
| `dsh-lit-translate/` | MIT | `Copyright (c) 2026 director` |
| `dsh-ct-norm/` 代码 + 自建中文别名层 | MIT | `Copyright (c) 2026 someone628` |
| `dsh-onco-lexicon/data/onco.ncit.jsonl` | **CC BY 4.0**（NCIt 派生数据，非 MIT） | NCI Enterprise Vocabulary Services |
| `dsh-ct-norm/data/mesh.subset.jsonl` | **非 MIT**（MeSH 2026 派生概念子集） | U.S. National Library of Medicine（NLM） |

各子目录内的 `LICENSE` 各自写明其版权人，可脱离本仓库独立分发；根目录的 [`LICENSE`](LICENSE)
说明了"子目录版权归各自作者"这一分工。数据侧的第三方义务见
[`dsh-onco-lexicon/THIRD-PARTY-NOTICES.md`](dsh-onco-lexicon/THIRD-PARTY-NOTICES.md)
与 [`dsh-ct-norm/THIRD-PARTY-NOTICES.md`](dsh-ct-norm/THIRD-PARTY-NOTICES.md)。

---

## 7. 状态

* 代码已推送到 GitHub：<https://github.com/someone628/cloneship>（`main` 分支）；
* 三个插件均已在本机 DSH Web profile 上安装，安装副本与源码逐字节一致
  （onco-lexicon 0.7.1 / lit-translate 0.2.1 / ct-norm 0.1.1，2026-10-10 完成一轮缺陷检修，
  详见 [`CHANGELOG.md`](CHANGELOG.md)）；
* onco-lexicon 与 lit-translate 涉及联网/模型的路径已实测可用；**修好的版本要在 DSH 重启（或重载插件）后才生效**；
* **尚未提交到 dsh.so 插件注册表**（截至 2026-09-30，`https://www.dsh.so/plugin/dsh-onco-lexicon.json`
  与 `.../dsh-lit-translate.json` 均为 404）。
