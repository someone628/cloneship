# 第三方条款与署名（dsh-ct-norm）

本插件**代码**与**自建中文别名层**以 MIT 发布，全文见 [`LICENSE`](LICENSE)。
但随包发布的**数据文件 `data/mesh.subset.jsonl` 不在 MIT 覆盖范围内**，适用下列条款。
再分发本插件（含其 tgz）时请连同本文件一起保留。

---

## 1. `data/mesh.subset.jsonl` —— MeSH 2026 派生概念子集

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

`data/mesh.subset.jsonl` **不是** MeSH 的副本，也不是全量索引，而是一份
**按本插件词表选择性提取的概念子集**（当前 370 条）：

1. **只取词表引用到的概念。** 从 NLM 的 MeSH 2026 中筛出本插件中文词表实际会用到的
   描述符（anatomy 条目的 `mesh` 与 `neoplasm`、morphology 条目的 `mesh` 与
   `lymphaticMesh` 及 `candidates`/`siteCandidates`、以及 `ct.rules.json` 里
   未归一化征象声明的 `site`）。**其余 35 万余条记录一律不收**——
   这带来一条硬性质：插件在物理上产不出子集之外的 MeSH 编号。
2. **字段裁剪。** 每条记录只保留 6 个字段：`ui`（`D######` 形式）、`id`（`mesh:` 前缀）、
   规范名、释义、类别、树号。其余字段（`RegistryNumber`、`CASN1Name`、`SourceList`、
   `PreviousIndexing`、`HistoryNote`、`PublicMeSHNote`、`AllowableQualifiers`、
   `SeeRelated`、`EntryCombination`、同义词表等）**未收录**。
3. **释义截断。** ScopeNote 保留前 300 字符，超长处截断并以 `…` 结尾（与
   `mesh_build.py` 的 `defLimit` 一致；展示时再按 `defChars` 二次截断）。
4. **类别推导。** `cat` 字段是由树号首字母映射到本插件**自有**类别词表的粗分类
   （`disease` / `drug` / `method` / `treatment` / `concept`），**不是** NLM 的语义类型
   （Semantic Type），也不代表 NLM 的分类口径。
5. **不翻译。** MeSH 的英文文本**未做任何机器翻译**，本插件也**不包含 MeSH 的中文名**
   （MeSH 本身不提供中文名）。所有中文写法都来自本插件自建的中文别名层，
   与 NLM 无关，见下节。

> 也就是说：`mesh.subset.jsonl` 是一份**经筛选、截断、重排的派生概念子集**，
> 不是 MeSH 的完整或原始副本，也不能替代 NLM 官方发布的 MeSH 数据。

### 版本与时效

`data/ct.manifest.json` 记录了子集的来源与构建时间：所用的 MeSH 版本（`mesh_release`）、
全量索引的字节数与 sha256（`mesh_index`）、以及构建时刻（`built_utc`）。
本插件随包分发的是 **MeSH 2026** 的快照；NLM 会持续更新 MeSH，
**请以 NLM 官方发布的最新版本为准**；需要最新数据时重新构建即可（步骤见 [`data/README.md`](data/README.md)）。

---

## 2. `data/ct.lexicon.jsonl`、`data/src/*.json`、`data/ct.rules.json` —— 自建中文别名层

这三个文件是本插件的**原创内容**，不在 NLM 的条款覆盖范围内，按 MIT 发布
（版权 `Copyright (c) 2026 someone628`）。

它们解决的是 MeSH 解决不了的那一半问题：MeSH 只有英文规范名，而中文 CT 报告写的是
「右肺上叶见一大小约 2.3cm 结节影」「纵隔及右肺门见多发肿大淋巴结」「肝内多发低密度灶」。
所以这里收录的是**中文自由写法 → MeSH 规范名**的对照，例如：

```
胸腔积液 / 胸膜腔积液 / 胸水 / 胸腔内积液        → Pleural Effusion
淋巴结肿大 / 肿大淋巴结 / 淋巴结增大              → Lymphadenopathy
肝内胆管 / 肝外胆管 / 胆总管 / 胆管壁            → Bile Ducts
```

**关键约束（也是本插件诚实性的地基）**：源文件里**只写 MeSH 英文规范名，不写 MeSH 编号**。
编号一律由 `build-ct-lexicon.mjs` 拿去 NLM 索引反解，反解不到就**构建失败**。
打包脚本还会再查一遍「源文件里有没有手写编号」。因此
**归一化结果里的每一个 `mesh:D######` 都必然来自 NLM 索引**，不存在人工编造的可能。

其中带中文名的写法是**本插件自建的临床用语对照**，
**不是** NLM 的官方译名，也**不得**被引用为「MeSH 中文名」。

---

## 3. 其他

* 插件**零 npm 依赖**：`package.json` 无 `dependencies`，运行时不加载任何远程资源、**不联网**。
  构建脚本（`build-ct-lexicon.mjs`）是唯一的例外——它是**离线**读取本地
  `mesh_index.bin` 的开发者工具，不发布到包内、也不在运行时执行。
* 正常运行时**不调用任何模型**。归一化结果完全由本地词表与固定规则决定，
  相同输入必然得到相同输出。
* 结果**不构成诊断意见**，只做术语层面的归一化；涉及诊断、分期与治疗决策，
  请以临床指南与医师判断为准。
