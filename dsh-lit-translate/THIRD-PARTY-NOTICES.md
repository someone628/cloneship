# 第三方条款与署名（dsh-lit-translate）

本插件**代码**以 MIT 发布，全文见 [`LICENSE`](LICENSE)。
但随包发布的**数据文件 `data/mesh_index.bin` 不在 MIT 覆盖范围内**，适用下列条款。
再分发本插件（含其 tgz）时请连同本文件一起保留。

---

## 1. `data/mesh_index.bin` —— MeSH 2026 派生索引

| 项目 | 内容 |
| --- | --- |
| 数据来源 | Medical Subject Headings（MeSH），2026 年发布版 |
| 源文件 | `desc2026.xml`（DescriptorRecordSet）、`supp2026.xml`（SupplementalRecordSet）、限定词 `QualifierRecordSet` |
| 下载页 | <https://www.nlm.nih.gov/databases/download/mesh.html> |
| 生产者 | U.S. National Library of Medicine（NLM），Bethesda, MD, USA |
| 条款 | NLM Terms and Conditions — MeSH：<https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html> |
| 费用 | NLM 对 MeSH 数据**不收取任何费用、使用费或版税** |
| 关联性 | 本插件与 NLM / NIH **无任何关联**，也**未获其认可或背书** |

条款要点（2026-10 核对，原文措辞以 NLM 页面为准）：

* 使用者须**以清晰显著的方式注明 NLM 为数据来源**；
* 不得表示或暗示 NLM 为本插件及其产出背书；
* **再分发者**须保持数据为最新版本，**或**以清晰显著的方式说明该产品不代表 NLM 当前最新/最准确的数据、
  并指明所用的 MeSH 版本；
* 数据按"合理注意标准"生产，但 NLM **不作任何明示或默示担保**（含可销售性、特定用途适用性），
  使用者须使 NLM 与美国政府免于因数据错误产生的责任；
* NLM 不就此提供版权/合理使用等法律意见；MeSH Translation（MTMS）文件**不适用**上述条款（本插件也**不使用** MTMS 文件）。

### 建议保留的署名文字

> This product includes terminology derived from the Medical Subject Headings (MeSH), 2026 release,
> produced by the U.S. National Library of Medicine (NLM). MeSH data is provided freely by NLM;
> NLM has not endorsed this product. This index is a snapshot of the 2026 MeSH release and may not
> reflect the most current MeSH data available from NLM.

中文版：

> 本产品包含由美国国家医学图书馆（NLM）生产的医学主题词表（MeSH）2026 年版派生的术语数据。
> MeSH 数据由 NLM 免费提供；NLM 未对本产品作出认可。本索引是 MeSH 2026 版的**快照**，
> 可能不反映 NLM 当前最新的 MeSH 数据。

### 本插件对该数据所做的修改（NLM 条款要求指明版本；派生产品亦应说明改动）

源数据共 355,232 条记录（31,110 条描述符 + 324,046 条补充概念记录 + 76 条限定词），
经工作区脚本 `mesh_build.py` 处理为一个**定长二进制检索索引** `data/mesh_index.bin`：

1. **字段裁剪**：每条记录只保留 6 个字段——`id`（如 `mesh:D002289`）、规范名、释义、类别、树号、映射目标；
   其余字段（`RegistryNumber`、`CASN1Name`、`SourceList`、`PreviousIndexing`、`HistoryNote`、
   `PublicMeSHNote`、`AllowableQualifiers`、`SeeRelated`、`EntryCombination` 等）**未收录**。
2. **释义截断**：描述符与限定词的 ScopeNote 保留前 **300 字符**，补充概念记录的 Note 保留前 **160 字符**；
   超长处在字符中间截断并以 `…` 结尾。
3. **样板句剔除**：补充概念记录里以 "structure given in first source" 开头的样板 Note（占比很高、
   对翻译无信息量）被丢弃。
4. **同义词筛选**：只取 `Term` 中 `IsPermutedTermYN != "Y"` 者（倒装排列词丢弃）与 `Abbreviation`；
   `EntryVersion`（全大写索引形式）丢弃。与规范名归一化后相同的重复项合并。
5. **类别推导**：由树号首字母映射到本插件**自有**的类别词表（`disease` / `drug` / `method` /
   `treatment` / `concept`）；这**不是** NLM 的语义类型（Semantic Type），也不代表 NLM 的分类口径。
   补充概念记录按 `HeadingMappedTo` 所指描述符的树号回填类别。
6. **归一化改写**：为检索匹配另行生成归一化字面形式（NFKD → 去变音符 → 删撇号 → 小写 →
   非字母数字转空格 → 压缩空格）。这只影响**匹配**，不改写数据本身的语义。
7. **不翻译**：MeSH 的英文文本**未做任何机器翻译**，本插件也**不包含 MeSH 的中文名**
   （MeSH 本身不提供中文名）。界面上出现的中文译名一律来自翻译模型，不是 MeSH 内容。

> 也就是说：`mesh_index.bin` 是一份**经筛选、截断、重排与归一化的派生索引**，
> 不是 MeSH 的完整或原始副本，也不能替代 NLM 官方发布的 MeSH 数据。

### 版本与时效

索引内嵌的元数据记录其来源与构建时间（可用 `python mesh_build.py verify` 读出，见 `data/README.md`）。
本插件随包分发的是 **MeSH 2026** 的快照；NLM 会持续更新 MeSH，
**请以 NLM 官方发布的最新版本为准**；需要最新数据时重新构建索引即可（步骤见 `data/README.md`）。

---

## 2. 其他

* 插件**零 npm 依赖**：`package.json` 无 `dependencies`，运行时不加载任何远程资源、不联网
  （翻译请求只发给用户在 DSH 里配置的模型服务商）。
* 提示词（`SYSTEM_ANNOTATE` / `SYSTEM_PLAIN` / `CONTEXT_RULE`）与切段口径来自
  `dsh-literature-reading` v1.19.0（MIT），在同一许可下使用。
* 译文由 DSH 当前默认模型生成，**模型输出的使用还受对应模型服务方条款约束**，与本插件的 MIT 无关。
