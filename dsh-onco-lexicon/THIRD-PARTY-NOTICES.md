# 第三方许可与署名（dsh-onco-lexicon）

本插件**代码**以 MIT 发布，全文见 [`LICENSE`](LICENSE)。
但随包发布的**数据文件不在 MIT 覆盖范围内**，各自适用下列条款。
再分发本插件（含其 tgz）时，请连同本文件一起保留。

---

## 1. `data/onco.ncit.jsonl` —— NCI Thesaurus OBO Edition

| 项目 | 内容 |
| --- | --- |
| 数据来源 | NCI Thesaurus（NCIt）OBO Edition，源文件 `ncit.obo` |
| 源地址 | <https://purl.obolibrary.org/obo/ncit.obo> |
| 生产者 | NCI Enterprise Vocabulary Services (EVS), Center for Biomedical Informatics and Information Technology, National Cancer Institute, Maryland, USA |
| 许可 | **Creative Commons Attribution 4.0 International（CC BY 4.0）**——<https://creativecommons.org/licenses/by/4.0/> |
| 商标 | “NCI Thesaurus” 是商标；只有 NCI 发布的 NCI Thesaurus 才能以该名称发布 |

许可依据（已核对，2026-09-30）：OBO Foundry 的 NCIt 页面写明
“The NCI Thesaurus is released under the Creative Commons Attribution 4.0 International license (CC BY 4.0)”，
该页 License 字段亦标为 CC BY 4.0 —— <https://obofoundry.org/ontology/ncit.html>。

### 建议保留的署名文字

> This product includes material from the NCI Thesaurus, produced by the National Cancer Institute's
> Enterprise Vocabulary Services (EVS). The NCI Thesaurus is licensed under CC BY 4.0.

### 本插件对该数据所做的修改（CC BY 4.0 要求标明修改）

源 `ncit.obo` 共 191,101 个 `[Term]` 节，经 `prep_ncit_obo.py` 与 `build-plugin-dict.py` 处理后写出 185,880 条
（再与自建库合并后为 185,885 条）。具体改动：

1. **筛除**：跳过 `is_obsolete: true` 的 5,221 条；无 `id` / `name` 的条目跳过。
2. **字段裁剪**：只保留 `id`（转小写）、`en`（首选名）、`category`（由名称规则或语义类型推导）、
   `aliases`、`abbr`、`def`、`parents`、`types`、`source`；其余 OBO 属性一律丢弃。
3. **释义截断**：`def` 最长保留 **400 字符**（原名可更长），因此部分释义在句中被截断。
4. **同义词裁剪**：每条最多保留 40 个（`KEEP_ALIASES` / `KEEP_ABBR`），并去掉与首选名相同者、
   以及重复出现的同一文本；上位概念 `parents` 最多取前 3 条。
5. **合并**：`build-plugin-dict.py` 按概念（而非追加）把自建库的字段并入 NCIt 条目
   （101 条补了中文名 / 中文释义 / MeSH 编码 / 人工类别，5 条为自建库独有）。
6. **检索字段**：为中文/模糊检索派生过 `text` 字段；**打包版已删除该字段**（构建脚本会校验它不存在）。
7. **无翻译**：NCIt 的英文文本未被机器翻译改写，中文名只来自自建库的人工整理。

> 也就是说：这是一份**经筛选、截断、合并与重排的派生数据**，不是 NCIt 的完整或原始副本。
> 它不代表 NCI 的观点，也未获 NCI 认可。

---

## 2. `data/onco.seed.jsonl` —— 自建库

* 106 条，由本插件作者**人工整理**（中文名、中文释义、类别），以 MIT 发布（同 [`LICENSE`](LICENSE)）。
* 其中 `codes.mesh` 只是**引用 MeSH 描述符编号**（如 `D002289`）作为外部标识符；
  本文件**不含** MeSH 的文本内容（名称、树号、注释、范围等都未收录）。
  MeSH 由 U.S. National Library of Medicine (NLM) 生产；若将来引入 MeSH 文本，需另行核对其条款。

---

## 3. 其他

* 插件**零 npm 依赖**：`package.json` 无 `dependencies`（`node_modules` 仅供仓库内测试脚本使用，不随包）。
* 图标 `assets/icon.png` 由仓库内 `build-icon.ps1` 生成，属本插件自有资产，随 MIT 发布。
* 运行时**全程不联网**，不请求任何第三方服务；因此不涉及第三方服务条款。
