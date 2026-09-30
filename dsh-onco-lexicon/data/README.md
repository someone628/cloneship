# data/ —— 词典数据

| 文件 | 是否入库 | 说明 |
| --- | --- | --- |
| `onco.seed.jsonl` | ✅ **在本仓库** | 106 条人工整理种子词典（中英双语 + MeSH 编码引用），随本包以 MIT 发布 |
| `onco.ncit.jsonl` | ❌ **不在本仓库** | 185,880 条 NCIt 派生的主词典，**81.6 MB（77.9 MiB）**，超过 GitHub 的 50 MB 单文件警告线，故只随 tgz / npm 包发布，或按下面的办法本地生成 |

## 主词典怎么来

1. 取 NCIt OBO Edition 的 `ncit.obo`：<https://purl.obolibrary.org/obo/ncit.obo>
   （**CC BY 4.0**，NCI Enterprise Vocabulary Services 生产）；
2. 用本仓库根目录的脚本解析、精简、合并：

   ```powershell
   python prep_ncit_obo.py --data <ncit.obo 的路径> --out onco-ncit-dsh.jsonl --report obo_build_report.txt
   python build-plugin-dict.py            # 与自建库按概念合并，产出 data/onco.ncit.jsonl
   ```

   这两个脚本会**剔除 obsolete 词条、把释义截断到 400 字符、裁剪同义词与上位概念、按概念合并自建库字段**
   ——这些改动属于 CC BY 4.0 要求标明的"修改"，清单见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)；
3. 或者直接取打包好的 tgz（主词典已包含在内，见仓库 README 的"安装"一节）。

## 缺主词典时会怎样

插件按 `dictPath` → `data/onco.ncit.jsonl` → `data/onco.seed.jsonl` 的顺序探测：

* **有主词典**：185,885 条（185,880 条 NCIt + 自建库按概念合并后的结果）；
* **只有种子词典**：106 条。中文查询仍然可用，但英文覆盖面大幅缩小。

因此从仓库直接跑（未生成主词典）时功能是"可用但很薄"的，正式使用请装 tgz。
