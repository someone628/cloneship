#!/usr/bin/env python
"""正确地解析 ncit.obo，生成带 text 字段的 JSONL。

为什么需要它
------------
上游 scripts/build-nct.mjs 有一个致命分支错误：

    } else if (tag === 'def')     { current.def = 释义 }
      else if (tag === 'synonym') { current.def = 同义词 }   // 覆盖 def！
      else if (tag === 'synonym') { current.synonyms.push() } // 死代码，永不执行

后果：onco.ncit.jsonl 里
  * `def` 是 OBO 中**最后一个 synonym**，真正的释义被冲掉
  * `synonyms` 恒为空 -> 输出中根本没有 aliases / abbr 字段，
    **721,077 个同义词全部丢失**（而它们正是检索召回的关键）

本脚本按 OBO 语义正确解析：
    name      -> en
    synonym   -> aliases / abbr（按形态区分）
    def       -> def（真正的释义，独立保存，不并入 text）
    is_a      -> parents
    is_obsolete: true -> 跳过（5,221 条）

text = en + aliases + abbr，与种子集的 `en + zh + aliases + abbr` 同为"术语+同义词空间"。
释义单独保存，不并入 text，避免长句稀释向量（可用 --include-def 开启）。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

# synonym 行内 qualifier 带 P383（PT/AB/SY 等类型），但 EXACT 同义词已足够，
# 且全文 721,077 个 synonym 均为 EXACT，无需再按类型细分。
QUOTED_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')
ABBR_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-/+.]{1,11}$")
# NCIT:P106 = 语义类型（Semantic_Type）
P106_RE = re.compile(r'^property_value:\s*NCIT:P106\s+"([^"]*)"')

KEEP_ALIASES = 40
KEEP_ABBR = 40
# 收集上限同为 40，即实际上全部保留。同义词是检索召回的关键，而截断是不可逆的
# 信息损失：早期版本限制成 20/5，把 706,574 个同义词砍到 457,669（-35%），
# 已撤销。


def guess_category(hay: str) -> str:
    """沿用上游脚本的粗分类，保持与既有 onco.ncit.jsonl 可比。"""
    h = hay.lower()
    if re.search(r"(disease|neoplasm|neoplastic|carcinoma|sarcoma|leukemia|lymphoma|tumor)", h):
        return "disease"
    if re.search(r"(drug|agent|therapy|inhibitor|antibody|antineoplastic)", h):
        return "drug"
    if re.search(r"(gene|protein|biomarker|receptor|kinase)", h):
        return "biomarker"
    if re.search(r"(procedure|technique|assay|method|staining|sequencing)", h):
        return "method"
    return "concept"


def first_quoted(s: str) -> str:
    m = QUOTED_RE.search(s)
    return m.group(1).replace('\\"', '"') if m else ""


def build_text(rec: dict) -> str:
    parts: list[str] = []
    for v in [rec.get("en")] + list(rec.get("aliases") or []) + list(rec.get("abbr") or []):
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        k = p.lower()
        if k not in seen:
            seen.add(k)
            out.append(p)
    return " ".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse ncit.obo into JSONL with a `text` field")
    ap.add_argument("--data", default=r"C:\Users\Abc89\Desktop\data\ncit.obo")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "onco-ncit-dsh.jsonl"))
    ap.add_argument("--limit", type=int, default=0, help="仅处理前 N 个 Term（调试用）")
    ap.add_argument("--include-def", action="store_true", help="把真实释义也并入 text")
    ap.add_argument("--report", default="", help="把统计写入该文件")
    args = ap.parse_args()

    n_term = 0
    written = 0
    skipped_obsolete = 0
    skipped_noname = 0
    syn_total = 0
    syn_same_name = 0
    syn_dup = 0
    kept_syn = 0
    def_total = 0
    def_chars = 0
    max_syn = 0
    max_def = 0
    typed = 0
    type_values: set = set()
    cur: dict | None = None
    write = True

    fin = io.open(args.data, "r", encoding="utf-8", errors="replace")
    fout = io.open(args.out, "w", encoding="utf-8", newline="\n")

    def flush() -> None:
        nonlocal written, skipped_obsolete, skipped_noname, syn_total, def_total
        nonlocal def_chars, max_syn, max_def, syn_same_name, syn_dup, kept_syn, typed
        if cur is None:
            return
        if cur["obsolete"]:
            skipped_obsolete += 1
            return
        if not cur["id"] or not cur["name"]:
            skipped_noname += 1
            return

        syns = cur["synonyms"]
        syn_total += len(syns)
        max_syn = max(max_syn, len(syns))
        abbr: list[str] = []
        aliases: list[str] = []
        seen_syn: set[str] = set()
        for s in syns:
            if s == cur["name"]:
                # OBO 常把 preferred term 本身也列成 synonym，属自身重复
                syn_same_name += 1
                continue
            if s in seen_syn:
                # 同一 synonym 文本在 OBO 中会重复出现多次（不同来源/编码），
                # 例如 'Breast Cancer' 在 ncit:c4872 下出现 7 次
                syn_dup += 1
                continue
            seen_syn.add(s)
            if ABBR_RE.match(s):
                abbr.append(s)
            else:
                aliases.append(s)
        kept_syn += len(aliases) + len(abbr)

        rec: dict = {
            "id": cur["id"].lower(),
            "en": cur["name"],
            "category": guess_category(cur["name"]),
        }
        if aliases:
            rec["aliases"] = aliases[:KEEP_ALIASES]
        if abbr:
            rec["abbr"] = abbr[:KEEP_ABBR]
        d = cur["def"]
        if d:
            rec["def"] = d
            def_total += 1
            def_chars += len(d)
            max_def = max(max_def, len(d))
        if cur["parents"]:
            rec["parents"] = cur["parents"][:3]
        # 语义类型：权威且覆盖 99.7%，下游用它推出 category，并作为精确筛选维度
        if cur["types"]:
            rec["types"] = cur["types"]
            typed += 1
            type_values.update(cur["types"])
        rec["source"] = "NCIt OBO Edition"

        text = build_text(rec)
        if args.include_def and d:
            text = (text + " " + d).strip()
        rec["text"] = text
        fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
        written += 1

    for raw in fin:
        line = raw.rstrip("\n")
        if line.startswith("[") and line.endswith("]"):
            flush()
            if line == "[Term]":
                n_term += 1
                cur = {"id": "", "name": "", "def": "", "synonyms": [], "parents": [], "types": [], "obsolete": False}
                if args.limit and n_term > args.limit:
                    cur = None
                    break
            else:
                cur = None
            continue
        if cur is None or not line or ":" not in line:
            continue
        tag, value = line.split(":", 1)
        tag = tag.strip()
        value = value.strip()
        if tag == "id":
            cur["id"] = value
        elif tag == "name":
            cur["name"] = value
        elif tag == "def":
            t = first_quoted(value)
            if t:
                cur["def"] = t[:400]
        elif tag == "synonym":
            t = first_quoted(value)
            if t and len(cur["synonyms"]) < 40:
                cur["synonyms"].append(t)
        elif tag == "is_a":
            label = value.split("!", 1)[1].strip() if "!" in value else value.split(" ")[0]
            if label:
                cur["parents"].append(label)
        elif tag == "property_value":
            # NCIT:P106 是 NCIt 的**语义类型**（如 "Neoplastic Process"、"Pharmacologic Substance"），
            # 覆盖 99.7% 的词条，比按名称正则猜类别可靠得多。121,000 行里只挑这一种属性。
            m = P106_RE.match(line)
            if m:
                t = m.group(1).strip()
                if t and t not in cur["types"]:
                    cur["types"].append(t)
        elif tag == "is_obsolete":
            cur["obsolete"] = value.startswith("true")

    flush()
    fin.close()
    fout.close()

    size = os.path.getsize(args.out)
    L = [
        "Term 节            : %d" % n_term,
        "写出               : %d" % written,
        "跳过（obsolete）   : %d" % skipped_obsolete,
        "跳过（无 id/name） : %d" % skipped_noname,
        "同义词总数         : %d" % syn_total,
        "  平均每条         : %.2f" % (syn_total / written if written else 0),
        "  单条最多         : %d" % max_syn,
        "  其中与 name 相同 : %d (%.1f%%)  <- OBO 把 preferred term 也列为 synonym" % (
            syn_same_name, 100.0 * syn_same_name / syn_total if syn_total else 0),
        "  其中重复出现     : %d (%.1f%%)  <- 同一 synonym 文本多行重复" % (
            syn_dup, 100.0 * syn_dup / syn_total if syn_total else 0),
        "  有效新增同义词   : %d" % kept_syn,
        "有真实释义的条目   : %d (%.1f%%)" % (def_total, 100.0 * def_total / written if written else 0),
        "释义平均长度       : %.0f 字符" % (def_chars / def_total if def_total else 0),
        "释义最长           : %d 字符" % max_def,
        "有语义类型的条目   : %d (%.1f%%)" % (typed, 100.0 * typed / written if written else 0),
        "  不同语义类型取值 : %d" % len(type_values),
        "输出体积           : %.1f MiB" % (size / 2**20),
    ]
    print("\n".join(L))
    if args.report:
        with io.open(args.report, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(L) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
