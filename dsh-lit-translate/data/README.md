# data/ —— MeSH 2026 离线术语索引

| 文件 | 是否入库 | 说明 |
| --- | --- | --- |
| `mesh_index.bin` | ❌ **不在 git 仓库** | 由 MeSH 2026 派生的检索索引，**74.0 MiB**，超过 GitHub 的 50 MB 单文件警告线，故只随 tgz / npm 包发布，或按下面的办法本地生成（与 `dsh-onco-lexicon/data/onco.ncit.jsonl` 同一套办法） |
| `mesh_index.json` | ✅ 在本仓库 | 清单：记录数/术语数、构建时间、源文件大小与 sha256、索引自身 sha256 |
| `mesh_build_report.txt` | ✅ 在本仓库 | 构建报告：条数、歧义分布、样例、耗时 |
| `mesh_fixtures.json` | ✅ 在本仓库 | 查询夹具（Python 侧产出，Node 侧 `test-mesh.mjs` 用它做跨语言一致性校验） |

> 这 4 个文件由工作区根目录的 `mesh_build.py` 一次性产出；
> `mesh_index.bin` 随后被复制到本目录，`mesh_fixtures.json` 留在工作区的 `mesh_out/`。

## 索引是什么

`mesh_index.bin` 不是 MeSH 原文，而是一份**给翻译用的术语索引**：

* **355,232 条记录**（31,110 条描述符 + 324,046 条补充概念记录 + 76 条限定词）；
* **840,392 个归一化检索名**（含同义词与缩写），共 840,708 条"检索名 → 记录"引用；
* 每条记录只留 6 个字段：`id | 规范名 | 释义 | 类别 | 树号 | 映射目标`。

格式（全部小端）：头 68 字节 `<8s15I>`，magic 为 `MESHIDX1`；
其后依次是术语字节块、术语偏移表、引用偏移表、引用数组、记录偏移表、记录块、meta JSON。
读取端在 `../lib/mesh.js`：整文件读进 Buffer 后**直接在字节上二分查找**，
不预先把 84 万个术语构造成 JS 字符串（那会是几百 MB 常驻内存）。实测整份加载约 22 ms。

## 怎么重建

需要 MeSH 2026 的三个原始文件（NLM 下载页：<https://www.nlm.nih.gov/databases/download/mesh.html>）：

```
desc2026.xml      DescriptorRecordSet        31,110 条
supp2026.xml      SupplementalRecordSet     324,046 条
限定词 XML        QualifierRecordSet             76 条
```

```powershell
# 1) 构建（全量约 35 秒、峰值内存约 1 GB）
python mesh_build.py build --out mesh_out
python mesh_build.py verify --out mesh_out        # 术语升序、二分自命中、样例回读

# 2) 把索引搬进插件（本目录）
copy mesh_out\mesh_index.bin      dsh-lit-translate\data\
copy mesh_out\mesh_index.json     dsh-lit-translate\data\
copy mesh_out\mesh_build_report.txt dsh-lit-translate\data\

# 3) 跨语言一致性 + 术语匹配自测
node test-mesh.mjs
```

构建脚本的默认输入路径指向工作区所在的 `C:\Users\Abc89\Desktop\desc2026\`，
换机器时用 `--desc / --supp / --qual` 指定实际路径。

### 两个踩过的坑（写在这里免得重踩）

1. **限定词文件不是合法 XML**：`Annotation` 字段里有裸 `&`（如 `congenital & structural only`），
   直接 `ElementTree.parse` 会报 `not well-formed`。`mesh_build.py` 里的 `sanitize_xml()`
   先把裸 `&` 转义成 `&amp;` 再解析。
2. **索引两块偏移表的语义必须一致**：`term_off` 与 `ref_off` 都必须是"第 i 项的**起始**偏移 + 末尾哨兵"。
   早先版本一块存结束偏移、一块存起始偏移，错位一格——结果是**每个术语都取到了相邻术语的引用**，
   表现为 `abnormalities` 命中 `Aptitude`。`mesh_build.py verify` 与 `test-mesh.mjs` 都会逐项比对，
   这类错位不会再静默通过。

## 缺索引时会怎样

插件按 `meshIndexFile` 配置 → `data/mesh_index.bin` 的顺序探测：

* **有索引**：翻译前把原文命中的术语（规范名 + 释义 + MeSH 编号）注入系统提示词，面板卡片显示 `MeSH N`；
* **没有索引**：**翻译照常可用**，只是不做术语约束；工具输出与面板都会明确写出"索引不可用"，
  而不是假装命中 0 个。

也就是说术语层永远不是翻译的单点故障——这也是 `test-lit-translate.mjs` 里专门有一条用例覆盖的原因。

## 数据条款

MeSH 由 NLM 生产，使用与再分发须遵守 NLM 条款（署名 NLM、不得暗示背书、说明所用版本、NLM 不作担保）。
本索引是 MeSH 2026 的**快照派生件**，不代表 NLM 当前最新数据。
完整条款要点、署名文字与本插件所做的全部改动清单见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。
