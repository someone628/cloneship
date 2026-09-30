#!/usr/bin/env python
"""合并「自建术语库」与「NCIt 术语库」，供 DSH 插件使用。

与旧版的区别（重要）
--------------------
旧版只是把种子词典**追加**在 NCIt 后面，于是同一个概念会出现两条：

    非小细胞肺癌（Lung Non-Small Cell Carcinoma）   <- NCIt，无 MeSH
    非小细胞肺癌（Non-Small Cell Lung Carcinoma）   <- 自建，有 MESH:D002289

面板上一次查询就出两张重复卡片。

现在改为**按概念合并**：

  * 以 NCIt 条目为骨架（保留它的 id / 规范英文名 / 英文同义词 / parents）
  * 把自建库里对应该概念的中文名、中文别名、缩写、MeSH 编码、中文释义、人工类别并进去
  * 自建库的英文名若与 NCIt 规范名不同，则并入 aliases，保证旧叫法仍能搜到
  * 找不到 NCIt 对应概念的 5 条自建条目，原样独立保留

结果：185,880 + 5 = 185,885 条，**每个概念只有一条**。

字段取舍
--------
* category：优先用自建库的。自建库是人工整理的，而 NCIt 的类别是用名称正则粗判的
  （例如 Overall Survival 这类终点，正则只会给出 concept，自建库给的是 endpoint）。
* def：中文释义在前、英文释义在后（中间空行）。中文更适合本地读者，英文是权威原文。
* codes：合并两边（自建库补上 NCIt 缺失的 MeSH）。
* source：标注为两者合并，便于追溯。
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "onco-seed-dsh.jsonl")
NCIT = os.path.join(HERE, "onco-ncit-dsh.jsonl")
BRIDGE = os.path.join(HERE, "kb_out_ncit", "zh_bridge.json")
OUT = os.path.join(HERE, "dsh-onco-lexicon", "data", "onco.ncit.jsonl")

MERGED_SOURCE = "NCIt OBO Edition + 人工整理"

# NCIt 语义类型 -> 本词典的 7 个类别。
# 依据是 NCIt 自带的 Semantic_Type（OBO 里的 property_value NCIT:P106），
# 覆盖 100% 词条，比按名称正则猜类别可靠得多。
#
# 注意：**这里没有 "endpoint"**。NCIt 的语义类型不区分临床试验终点——Overall Survival 是
# Conceptual Entity、Hazard Ratio 是 Quantitative Concept、Adverse Event 是 Finding，
# 与大量非终点概念同型。所以终点类别只能来自人工整理的种子库（见 merge()）。
#
# 未列出的类型一律归 concept。
TYPE_TO_CATEGORY = {
    # 疾病
    "Neoplastic Process": "disease",
    "Disease or Syndrome": "disease",
    "Cell or Molecular Dysfunction": "disease",
    "Sign or Symptom": "disease",
    "Pathologic Function": "disease",
    "Mental or Behavioral Dysfunction": "disease",
    "Congenital Abnormality": "disease",
    "Acquired Abnormality": "disease",
    "Anatomical Abnormality": "disease",
    "Injury or Poisoning": "disease",
    "Experimental Model of Disease": "disease",
    # 抗肿瘤药物 / 给药物质
    "Pharmacologic Substance": "drug",
    "Antibiotic": "drug",
    "Clinical Drug": "drug",
    "Hormone": "drug",
    "Vitamin": "drug",
    "Biologically Active Substance": "drug",
    # 生物标志物 / 分子靶点
    "Gene or Genome": "biomarker",
    "Amino Acid, Peptide, or Protein": "biomarker",
    "Enzyme": "biomarker",
    "Receptor": "biomarker",
    "Immunologic Factor": "biomarker",
    "Nucleic Acid, Nucleoside, or Nucleotide": "biomarker",
    "Amino Acid Sequence": "biomarker",
    "Nucleotide Sequence": "biomarker",
    "Molecular Sequence": "biomarker",
    # 治疗方式
    "Therapeutic or Preventive Procedure": "treatment",
    # 实验 / 检测方法
    "Laboratory Procedure": "method",
    "Diagnostic Procedure": "method",
    "Molecular Biology Research Technique": "method",
    "Research Activity": "method",
    "Health Care Activity": "method",
}

# 多类型词条的取舍顺序。药物优先：像 Recombinant Amphiregulin 同时是
# 「Amino Acid, Peptide, or Protein」和「Pharmacologic Substance」，
# 对查词典的人来说「这是药」比「这是蛋白」更有用。
CATEGORY_PRIORITY = ["drug", "disease", "biomarker", "treatment", "method"]


def category_from_types(types) -> str | None:
    """由 NCIt 语义类型推出类别；无可用类型时返回 None（交由调用方回落）。"""
    if not types:
        return None
    cats = {TYPE_TO_CATEGORY[t] for t in types if t in TYPE_TO_CATEGORY}
    if not cats:
        return None
    for c in CATEGORY_PRIORITY:
        if c in cats:
            return c
    return None


def dedupe(values: list) -> list:
    """按小写去重，保留首次出现的写法与顺序。"""
    seen: set = set()
    out: list = []
    for v in values:
        s = str(v).strip()
        if not s:
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def build_text(rec: dict) -> str:
    parts = [rec.get("en"), rec.get("zh")]
    parts += list(rec.get("aliases") or [])
    parts += list(rec.get("abbr") or [])
    return " ".join(dedupe([p for p in parts if p]))


def merge(ncit: dict, seed: dict) -> dict:
    """以 NCIt 条目为骨架，并入自建库该概念的字段。"""
    out = dict(ncit)

    ncit_en = str(ncit.get("en") or "").strip()
    seed_en = str(seed.get("en") or "").strip()
    seed_zh = str(seed.get("zh") or "").strip()

    # 中文首选名（自建库独有）
    if seed_zh:
        out["zh"] = seed_zh

    # 别名：NCIt 英文同义词 + 自建库中文别名 + 自建库英文名（若与 NCIt 规范名不同）
    aliases = list(ncit.get("aliases") or [])
    aliases += list(seed.get("aliases") or [])
    if seed_en and seed_en.lower() != ncit_en.lower():
        aliases.append(seed_en)
    aliases = [a for a in dedupe(aliases) if a.lower() != seed_zh.lower()]
    if aliases:
        out["aliases"] = aliases
    else:
        out.pop("aliases", None)

    # 缩写：两边合并
    abbr = dedupe(list(ncit.get("abbr") or []) + list(seed.get("abbr") or []))
    if abbr:
        out["abbr"] = abbr
    else:
        out.pop("abbr", None)

    # 释义：中文在前、英文在后
    zh_def = str(seed.get("def") or "").strip()
    en_def = str(ncit.get("def") or "").strip()
    if zh_def and en_def and zh_def != en_def:
        out["def"] = zh_def + "\n\n" + en_def
    elif zh_def:
        out["def"] = zh_def
    elif en_def:
        out["def"] = en_def
    else:
        out.pop("def", None)

    # 类别：自建库是人工整理，优先
    if seed.get("category"):
        out["category"] = seed["category"]

    # 编码：合并（自建库补 MeSH）
    codes = dict(ncit.get("codes") or {})
    codes.update(seed.get("codes") or {})
    if codes:
        out["codes"] = codes

    out["source"] = MERGED_SOURCE
    # 结构化的出处，供面板打标识与按出处筛查（source 是给人看的一句话，不便过滤）
    out["sources"] = ["NCIt", "自建库"]
    out["text"] = build_text(out)
    return out


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="合并自建库与 NCIt，产出插件词典")
    ap.add_argument(
        "--keep-text",
        action="store_true",
        help="保留 text 字段。插件按 en/zh/abbr/aliases/codes 建键，**从不读取 text**，"
             "故默认丢弃；只有 Python 侧知识库（onco_kb.py）需要它。",
    )
    args = ap.parse_args()

    with open(SEED, encoding="utf-8") as fh:
        seed = [json.loads(l) for l in fh if l.strip()]
    with open(BRIDGE, encoding="utf-8") as fh:
        bridge = json.load(fh)
    seed_by_id = {r["id"]: r for r in seed}

    # ncit_id -> 自建库记录
    enrich: dict = {}
    for sid, info in bridge["entries"].items():
        src = seed_by_id.get(sid)
        if src:
            enrich[info["ncit_id"]] = src

    unmapped_ids = {u["id"] for u in bridge["unmapped"]}

    n_ncit = n_enriched = 0
    n_typed = n_fallback = 0
    with open(NCIT, "r", encoding="utf-8") as fin, \
         open(OUT, "w", encoding="utf-8", newline="\n") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            n_ncit += 1
            seed_rec = enrich.get(rec.get("id"))
            if seed_rec is not None:
                # 合并条目沿用人工整理的类别：终点（endpoint）这类只有人工整理给得出
                rec = merge(rec, seed_rec)
                n_enriched += 1
            else:
                rec["sources"] = ["NCIt"]
                types = rec.get("types")
                if types:
                    # 有权威类型就以它为准；映射表未覆盖的类型一律归 concept。
                    # **绝不能回落到名称正则**：实测它会把手册/量表条目判得离谱——
                    # "SOAPP-R - Others Suggested Drug or Alcohol Problem" -> drug、
                    # "BPI - Pain Due to Present Disease" -> disease、
                    # "Alzheimer's Disease Assessment Scale…" -> disease，
                    # 而它们的权威类型都是 Intellectual Product。这类误判会直接污染按类别筛查。
                    rec["category"] = category_from_types(types) or "concept"
                    n_typed += 1
                else:
                    n_fallback += 1  # 无任何类型时才用 prep 的正则结果（本语料为 0 条）
            if not args.keep_text:
                rec.pop("text", None)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")

        n_standalone = 0
        for r in seed:
            if r["id"] in unmapped_ids:
                rec = dict(r)
                rec["sources"] = ["自建库"]
                rec["text"] = build_text(rec)
                if not args.keep_text:
                    rec.pop("text", None)
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_standalone += 1

    total = n_ncit + n_standalone
    size = os.path.getsize(OUT)
    print("NCIt 条目         : %s" % format(n_ncit, ","))
    print("  并入自建库字段  : %s" % format(n_enriched, ","))
    print("  类别取自语义类型: %s (%.1f%%)" % (format(n_typed, ","), 100.0 * n_typed / n_ncit if n_ncit else 0))
    print("  仍用名称正则兜底: %s (%.1f%%)" % (format(n_fallback, ","), 100.0 * n_fallback / n_ncit if n_ncit else 0))
    print("自建库独立保留    : %s  (无 NCIt 对应概念)" % n_standalone)
    print("自建库总条数      : %s  (= 并入 %d + 独立 %d)" % (len(seed), n_enriched, n_standalone))
    print("合并后总条数      : %s  (旧版简单追加是 %s)" % (
        format(total, ","), format(n_ncit + len(seed), ",")))
    print("减少重复卡片      : %d 条" % (len(seed) - n_standalone))
    print("输出              : %s" % OUT)
    print("体积              : %.1f MiB" % (size / 2**20))
    return 0


if __name__ == "__main__":
    sys.exit(main())
