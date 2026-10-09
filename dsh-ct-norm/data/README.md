# data/ 目录说明

| 文件 | 进 git 仓库 | 说明 |
| --- | --- | --- |
| `src/` | ✅ | **人工整理**的词表源文件（只写 MeSH 英文规范名，不写编号）+ 写作规范 + 白名单 |
| `ct.rules.json` | ✅ | **人工整理**的抽取规则（否定 / 可疑 / 程度 / 数量 / 侧别 / 变化 / 尺寸，以及「未归一化征象」词表）。是运行时文件，不参与构建 |
| `ct.lexicon.jsonl` | ✅（构建产物） | 由 `build-ct-lexicon.mjs` 生成：别名 + 反解出的 MeSH 编号 |
| `mesh.subset.jsonl` | ✅（构建产物） | 同上生成：只含词表引用到的 MeSH 概念（规范名 / 释义 / 树号） |
| `ct.manifest.json` | ✅（构建产物） | 构建清单：条数、源文件 sha256、MeSH 版本与全量索引指纹 |
| `README.md` | ✅ | 本文件 |

> 本插件**不随包分发 74 MiB 的全量 MeSH 索引**（`dsh-lit-translate` 才需要它）。
> 它只带一份 370 条的**概念子集**（约 111 KiB），这既是体积考虑，更是设计约束：
> 子集之外的概念在运行时根本不存在，插件因此**产不出**词表之外的 MeSH 编号。

---

## 1. 从源文件重新生成产物

前置：工作区里要有全量 MeSH 2026 索引 `mesh_out/mesh_index.bin`
（由 `python mesh_build.py build` 从 NLM 的 `desc2026.xml` / `supp2026.xml` 生成，
格式见 `dsh-lit-translate/lib/mesh.js` 顶部注释）。

```powershell
# 只校验，不写产物（改完源词表先跑这个）
node build-ct-lexicon.mjs --check

# 校验并写出 data/ct.lexicon.jsonl、data/mesh.subset.jsonl、data/ct.manifest.json
node build-ct-lexicon.mjs

# 索引不在默认位置时指定
node build-ct-lexicon.mjs --mesh D:\mesh\mesh_index.bin
```

构建脚本会做这些事，**任何一条不过就退出并报错**（这是本插件诚实性的地基）：

1. 把每个条目的 `mesh` / `neoplasm` / `lymphaticMesh` / `candidates` / `siteCandidates`
   字段（都是 MeSH **英文规范名**）拿去 NLM 索引反解；反解不到、或反解出多条描述符 → 失败。
2. 全局查重：同一个别名不得出现在两个条目里（归一化后比较）。
3. 拒绝「整条都由修饰词/极性词组成」的别名。
4. 校验 `ct.rules.json` 里「未归一化征象」的写法不与词表条目冲突。
5. 把引用到的概念写进 `mesh.subset.jsonl`，并给所有输入文件记 sha256。

## 2. 改词表的正确姿势

**只改 `src/*.json`，然后重跑构建。** 改完必须重跑，否则：

* `ct.manifest.json` 里源文件的 sha256 会对不上 → `node test-ct-norm.mjs` 第 1 节报错；
* 打包脚本 `build-package-ct-norm.ps1` 也会拦下（词表行数 / 指纹与清单不一致）。

写作规范见 [`src/SCHEMA.md`](src/SCHEMA.md)，可用概念见 [`src/mesh-allowlist.txt`](src/mesh-allowlist.txt)。

### 两个容易踩的点

1. **不要手写 MeSH 编号。** 源文件里出现 `D######` 会被打包脚本判为失败。
   连 `note` 里也不许写——note 会随包分发并显示给用户，手写的错编号会和算出来的对编号混在一起。
   要提某个 MeSH 概念时只写它的英文规范名。
2. **别名里含修饰词/极性词不一定错。** 「无病生存」「无进展生存」含「无」，
   「多发性骨髓瘤」含「多发」——中文里没有别的写法可选。
   这类别名由 `lib/lexicon.js` 的「原文匹配」通道处理，照常能命中；
   构建会给一条提示，但不会失败。**别名整条都是这类词**才算错。

## 3. 验证

```powershell
node test-ct-norm.mjs
```

其中第 14 节会**逐个别名**验证「写进词表了」是否等于「真的能命中」——
这一条曾经抓出「无病生存」「多发性骨髓瘤」两批永远命中不了的别名。
