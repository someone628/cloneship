#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mesh_build.py —— 从 MeSH 2026 原始 XML 构建「文献翻译」用的离线术语索引。

输入（只读，均在 C:\\Users\\Abc89\\Desktop\\desc2026\\）：
    desc2026.xml    DescriptorRecordSet      31,111 条主题词
    supp2026.xml    SupplementalRecordSet   324,047 条补充概念记录
    mesh-parse.py   QualifierRecordSet          76 条限定词（**注意**：文件是 XML 内容，
                    扩展名为 .py 属误命名；且 Annotation 字段里有裸 '&'，不是合法 XML，
                    解析前需做容错转义）

输出（默认 mesh_out/）：
    mesh_index.bin        二进制索引，插件随包分发（零解析、二分查找）
    mesh_index.json       清单：计数、大小、sha256、来源与构建时间
    mesh-records.jsonl.gz 全量语料（参考用，不进插件包）
    mesh_build_report.txt 构建报告：计数、歧义分布、样例、耗时
    mesh_fixtures.json    查询夹具，供 Node 端做跨语言一致性测试

索引二进制格式（全部小端）：
    头 68 字节：<8s15I> = magic "MESHIDX1", version, term_count(T), record_count(R),
        ref_count(N), def_limit, built_epoch, off_terms, off_term_off, off_ref_off,
        off_ref_arr, off_rec_off, off_rec_blob, off_meta, meta_len, reserved
    区段：
        terms blob        T 个归一化术语的 UTF-8 拼接（按字节序升序）
        term offsets      (T+1) × u32，指向 terms blob
        ref offsets       (T+1) × u32，指向 ref array
        ref array         N × u32 记录下标
        rec offsets       (R+1) × u32，指向 rec blob
        rec blob          R 条记录，每条 6 个字段用 \\x1f 分隔：id|name|def|cat|tree|map
        meta              UTF-8 JSON（来源、计数、归一化口径）

归一化口径（必须与插件端 lib/mesh.js 完全一致）：
    NFKD -> 去掉组合字符（变音符） -> 删除撇号 -> 小写 -> 其余非 [字/数/下划线] 一律变空格 -> 压缩空格

用法：
    python mesh_build.py build --limit 3000     # 冒烟：每类只取前 N 条
    python mesh_build.py build                  # 全量
    python mesh_build.py verify
"""

from __future__ import annotations

import argparse
import array
import gzip
import hashlib
import json
import os
import re
import struct
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_SRC = r"C:\Users\Abc89\Desktop\desc2026"
DEFAULT_DESC = os.path.join(DEFAULT_SRC, "desc2026.xml")
DEFAULT_SUPP = os.path.join(DEFAULT_SRC, "supp2026.xml")
DEFAULT_QUAL = os.path.join(DEFAULT_SRC, "mesh-parse.py")

MAGIC = b"MESHIDX1"
VERSION = 1
HEADER = struct.Struct("<8s15I")

FIELD_SEP = "\x1f"

# MeSH 树号首字母 -> 类别（与 onco-lexicon 的 category 词表保持一致）
TREE_CAT = {
    "A": "concept",    # Anatomy
    "B": "concept",    # Organisms
    "C": "disease",    # Diseases
    "D": "drug",       # Chemicals and Drugs
    "E": "method",     # Analytical, Diagnostic and Therapeutic Techniques and Equipment
    "F": "concept",    # Psychiatry and Psychology
    "G": "concept",    # Phenomena and Processes
    "H": "concept",    # Disciplines and Occupations
    "I": "concept",    # Anthropology, Education, Sociology
    "J": "concept",    # Technology, Industry, Agriculture
    "K": "concept",    # Humanities
    "L": "concept",    # Information Science
    "M": "concept",    # Named Groups
    "N": "treatment",  # Health Care
    "V": "concept",    # Publication Characteristics
    "Z": "concept",    # Geographicals
}

# 补充记录里占比很高的样板 Note，对翻译没有信息量，直接丢掉（实测占 supp 的 ~67%）
BOILERPLATE_DEF = re.compile(
    r"^(structure given in first source|structure activity relationship|"
    r"a synonym for|synonym for|structure given in first source and|"
    r"structure given in first source;)",
    re.I,
)

_KEEP = re.compile(r"[^\w]+", re.UNICODE)
_SPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """把术语/正文片段折叠成可比较的形式。必须与 lib/mesh.js 的 normalizeText 一致。"""
    if not text:
        return ""
    s = unicodedata.normalize("NFKD", text)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.replace("'", "").replace("\u2019", "").replace("\u02bc", "")
    s = s.lower()
    s = _KEEP.sub(" ", s)
    return _SPACE.sub(" ", s).strip()


def tree_root(tree_numbers):
    for tn in tree_numbers:
        if tn:
            return tn[0].upper()
    return ""


def cat_of(tree_numbers, default="concept"):
    root = tree_root(tree_numbers)
    return TREE_CAT.get(root, default)


def sanitize_xml(raw: str) -> str:
    """把裸 '&' 转义成 &amp;，让 NLM 之外被手工改过的限定词文件也能解析。"""
    return re.sub(
        r"&(?!(?:[A-Za-z][A-Za-z0-9]{0,10}|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)", "&amp;", raw
    )


def text_of(elem, path):
    node = elem.find(path)
    if node is None:
        return ""
    return (node.text or "").strip()


def iter_records(path, record_tag, limit=0):
    """流式产出记录元素；调用方处理完必须依赖本函数 clear() 释放内存。"""
    n = 0
    for _event, elem in ET.iterparse(path, events=("end",)):
        if elem.tag != record_tag:
            continue
        yield elem
        elem.clear()
        n += 1
        if limit and n >= limit:
            break


def collect_terms(elem):
    """从 ConceptList 里取：规范名、全部非置换同义词、缩写、首选概念 ScopeNote。"""
    synonyms, abbrs = [], []
    scope = ""
    preferred_scope = ""
    for concept in elem.findall("ConceptList/Concept"):
        is_pref = concept.get("PreferredConceptYN") == "Y"
        for term in concept.findall("TermList/Term"):
            if term.get("IsPermutedTermYN") == "Y":
                continue
            s = text_of(term, "String")
            if s:
                synonyms.append(s)
            a = text_of(term, "Abbreviation")
            if a:
                abbrs.append(a)
        note = text_of(concept, "ScopeNote")
        if note:
            if is_pref and not preferred_scope:
                preferred_scope = note
            if not scope:
                scope = note
    return synonyms, abbrs, (preferred_scope or scope)


def parse_descriptor(elem, def_limit):
    ui = text_of(elem, "DescriptorUI")
    name = text_of(elem, "DescriptorName/String")
    trees = [t.text.strip() for t in elem.findall("TreeNumberList/TreeNumber") if t.text]
    synonyms, abbrs, scope = collect_terms(elem)
    annotation = text_of(elem, "Annotation")
    pa = [
        (d.text or "").strip()
        for d in elem.findall(
            "PharmacologicalActionList/PharmacologicalAction/DescriptorReferredTo/DescriptorName/String"
        )
        if d.text
    ]
    rec = {
        "id": "mesh:" + ui,
        "kind": "descriptor",
        "en": name,
        "aliases": synonyms,
        "abbr": abbrs,
        "tree": trees,
        "def": scope[: def_limit * 4],
        "map": "",
        "cat": cat_of(trees),
        "annotation": annotation,
        "pa": pa,
        "root": tree_root(trees),
    }
    return rec


def parse_supplemental(elem, def_limit):
    ui = text_of(elem, "SupplementalRecordUI")
    name = text_of(elem, "SupplementalRecordName/String")
    synonyms, abbrs, scope = collect_terms(elem)
    note = text_of(elem, "Note")
    mapped = []
    for hm in elem.findall("HeadingMappedToList/HeadingMappedTo"):
        d = text_of(hm, "DescriptorReferredTo/DescriptorName/String")
        q = text_of(hm, "QualifierReferredTo/QualifierName/String")
        label = " / ".join(x for x in (d, q) if x)
        if label:
            mapped.append(label)
    rec = {
        "id": "mesh:" + ui,
        "kind": "supplemental",
        "en": name,
        "aliases": synonyms,
        "abbr": abbrs,
        "tree": [],
        "def": (note or scope)[: def_limit * 4],
        "map": "; ".join(mapped[:3]),
        "cat": "concept",  # 稍后按映射到的描述符树号回填
        "annotation": "",
        "pa": [],
        "root": "",
    }
    return rec


def parse_qualifier(elem, def_limit):
    ui = text_of(elem, "QualifierUI")
    name = text_of(elem, "QualifierName/String")
    scope = text_of(elem, "ScopeNote")
    trees = [t.text.strip() for t in elem.findall("TreeNumberList/TreeNumber") if t.text]
    abbrs = [
        (a.text or "").strip()
        for a in elem.findall("ConceptList/Concept/TermList/Term/Abbreviation")
        if a.text
    ]
    synonyms = []
    for concept in elem.findall("ConceptList/Concept"):
        for term in concept.findall("TermList/Term"):
            if term.get("IsPermutedTermYN") == "Y":
                continue
            s = text_of(term, "String")
            if s:
                synonyms.append(s)
    rec = {
        "id": "mesh:" + ui,
        "kind": "qualifier",
        "en": name,
        "aliases": synonyms,
        "abbr": abbrs,
        "tree": trees,
        "def": scope[: def_limit * 4],
        "map": "",
        "cat": "concept",
        "annotation": text_of(elem, "Annotation"),
        "pa": [],
        "root": tree_root(trees),
    }
    return rec


def trim_def(rec, limit):
    """按记录类型裁剪释义，并丢掉补充记录里的样板句。"""
    d = (rec["def"] or "").strip()
    if rec["kind"] == "supplemental":
        if d and BOILERPLATE_DEF.match(d):
            d = re.sub(
                r"^structure given in first source[;,]?\s*", "", d, flags=re.I
            ).strip()
        if not d or BOILERPLATE_DEF.match(d):
            d = ""
    if len(d) > limit:
        d = d[: limit - 1].rstrip() + "…"
    rec["def"] = d
    return rec


def surface_forms(rec):
    """一条记录用来做匹配的全部字面形式（去重、去掉与规范名重复的）。"""
    forms = []
    seen = set()
    for s in [rec["en"]] + rec["aliases"] + rec["abbr"]:
        s = (s or "").strip()
        if not s:
            continue
        n = normalize(s)
        if not n or n in seen or len(n) < 2:
            continue
        seen.add(n)
        forms.append(n)
    return forms


def priority(rec):
    return {"descriptor": 0, "qualifier": 1, "supplemental": 2}[rec["kind"]]


def sha256_of(path, chunk=8 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


class Builder:
    def __init__(self, outdir, def_limit, supp_def_limit):
        self.outdir = outdir
        self.out = outdir
        self.def_limit = def_limit
        self.supp_def_limit = supp_def_limit
        self.pairs = []          # (normalized_term, priority, rec_index)
        self.rec_blob = bytearray()
        self.rec_off = array.array("I", [0])
        self.records = []        # 轻量清单，仅用于报告（id/kind/name/cat）
        self.stats = {}

    def add(self, rec):
        idx = len(self.rec_off) - 1
        limit = self.supp_def_limit if rec["kind"] == "supplemental" else self.def_limit
        trim_def(rec, limit)
        blob = FIELD_SEP.join(
            [
                rec["id"],
                rec["en"],
                rec["def"],
                rec["cat"],
                ",".join(rec["tree"][:4]),
                rec["map"],
            ]
        ).encode("utf-8")
        self.rec_blob += blob
        self.rec_off.append(len(self.rec_blob))

        prio = priority(rec)
        for form in surface_forms(rec):
            self.pairs.append((form, prio, idx))
        self.records.append(rec)
        return idx


def build(args):
    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    b = Builder(args.out, args.def_limit, args.supp_def_limit)

    src_meta = {}
    for path in (args.desc, args.supp, args.qual):
        src_meta[os.path.basename(path)] = {
            "bytes": os.path.getsize(path),
            "sha256": sha256_of(path),
        }

    # ---- 1) 描述符 ----
    for elem in iter_records(args.desc, "DescriptorRecord", args.limit):
        b.add(parse_descriptor(elem, b.def_limit))
    n_desc = len(b.records)
    desc_root_cat = {}
    for rec in b.records:
        if rec["root"]:
            desc_root_cat.setdefault(rec["id"], rec["cat"])
    print(f"[1/3] 描述符 {n_desc:,} 条  {time.time() - t0:.1f}s")

    # ---- 2) 补充记录（类别按映射到的描述符树号回填）----
    t1 = time.time()
    for elem in iter_records(args.supp, "SupplementalRecord", args.limit):
        rec = parse_supplemental(elem, b.supp_def_limit)
        for hm in elem.findall("HeadingMappedToList/HeadingMappedTo"):
            dui = text_of(hm, "DescriptorReferredTo/DescriptorUI")
            if not dui:
                continue
            hit = desc_root_cat.get("mesh:" + dui.lstrip("*"))
            if hit:
                rec["cat"] = hit
                break
        b.add(rec)
    n_supp = len(b.records) - n_desc
    print(f"[2/3] 补充记录 {n_supp:,} 条  {time.time() - t1:.1f}s")

    # ---- 3) 限定词（XML 不合法，先容错转义）----
    t2 = time.time()
    with open(args.qual, "r", encoding="utf-8", errors="replace") as f:
        root = ET.fromstring(sanitize_xml(f.read()))
    n_qual = 0
    for elem in root.findall("QualifierRecord"):
        b.add(parse_qualifier(elem, b.def_limit))
        n_qual += 1
    print(f"[3/3] 限定词 {n_qual:,} 条  {time.time() - t2:.1f}s")

    R = len(b.rec_off) - 1
    print(f"记录合计 {R:,}，字面形式 {len(b.pairs):,} 条，开始归一化索引…")

    # ---- 4) 术语索引 ----
    t3 = time.time()
    b.pairs.sort()
    terms_blob = bytearray()
    # term_off / ref_off 都是「起始偏移 + 末尾哨兵」：第 i 个术语占
    # [term_off[i], term_off[i+1])，其引用占 [ref_off[i], ref_off[i+1])。
    # 早先版本 term_off 存的是**结束**偏移、ref_off 存的是**起始**偏移，
    # 两者错位一格，导致每个术语的引用都取到了相邻术语的。
    term_off = array.array("I")
    ref_off = array.array("I")
    refs = array.array("I")
    prev = None
    last_ref = -1
    ambiguous = []
    for form, _prio, idx in b.pairs:
        if form != prev:
            term_off.append(len(terms_blob))
            ref_off.append(len(refs))
            terms_blob += form.encode("utf-8")
            prev = form
            last_ref = -1
        # 只在**同一个术语内**去重：同一条记录可能贡献多个相邻的术语（如 ab / ac），
        # 若拿全局上一条 ref 比较，会把本来合法的引用吃掉。
        if idx != last_ref:
            refs.append(idx)
            last_ref = idx
    term_off.append(len(terms_blob))
    ref_off.append(len(refs))
    T = len(term_off) - 1
    N = len(refs)
    for i in range(T):
        n = ref_off[i + 1] - ref_off[i]
        if 2 <= n:
            ambiguous.append(n)
    print(f"术语 {T:,}，引用 {N:,}  {time.time() - t3:.1f}s")

    # ---- 5) 组装二进制 ----
    meta = {
        "format": "MESHIDX1",
        "version": VERSION,
        "mesh_release": "MeSH 2026",
        "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": src_meta,
        "counts": {
            "descriptors": n_desc,
            "supplemental": n_supp,
            "qualifiers": n_qual,
            "records": R,
            "terms": T,
            "refs": N,
        },
        "normalization": "NFKD,strip-marks,drop-apostrophes,lower,non-word->space,collapse",
        "record_fields": ["id", "name", "def", "cat", "tree", "map"],
        "note": "MeSH 为美国国家医学图书馆（NLM）公开数据；本文件是其派生索引。",
    }
    meta_bytes = json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")

    bin_path = os.path.join(b.out, "mesh_index.bin")
    with open(bin_path, "wb") as f:
        f.write(b"\0" * HEADER.size)
        off_terms = f.tell(); f.write(terms_blob)
        off_term_off = f.tell(); f.write(term_off.tobytes())
        off_ref_off = f.tell(); f.write(ref_off.tobytes())
        off_ref_arr = f.tell(); f.write(refs.tobytes())
        off_rec_off = f.tell(); f.write(b.rec_off.tobytes())
        off_rec_blob = f.tell(); f.write(b.rec_blob)
        off_meta = f.tell(); f.write(meta_bytes)
        end = f.tell()
        f.seek(0)
        f.write(
            HEADER.pack(
                MAGIC, VERSION, T, R, N, b.def_limit, int(time.time()),
                off_terms, off_term_off, off_ref_off, off_ref_arr,
                off_rec_off, off_rec_blob, off_meta, len(meta_bytes), 0,
            )
        )
        assert f.tell() == HEADER.size
    print(f"索引 {bin_path}  {end / 1048576:.1f} MiB  总计 {time.time() - t0:.1f}s")

    # ---- 6) 全量语料（参考用，不进插件包）----
    jsonl = os.path.join(b.out, "mesh-records.jsonl.gz")
    if not args.no_jsonl:
        with gzip.open(jsonl, "wt", encoding="utf-8", compresslevel=6) as g:
            for rec in b.records:
                g.write(
                    json.dumps(
                        {
                            "id": rec["id"],
                            "kind": rec["kind"],
                            "en": rec["en"],
                            "aliases": rec["aliases"],
                            "abbr": rec["abbr"],
                            "tree": rec["tree"],
                            "def": rec["def"],
                            "cat": rec["cat"],
                            "map": rec["map"],
                            "pa": rec["pa"],
                            "annotation": rec["annotation"],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

    # ---- 7) 夹具 + 清单 + 报告 ----
    fixtures = make_fixtures(bin_path)
    with open(os.path.join(b.out, "mesh_fixtures.json"), "w", encoding="utf-8") as f:
        json.dump(fixtures, f, ensure_ascii=False, indent=2)

    manifest = dict(meta)
    manifest["files"] = {
        "mesh_index.bin": {
            "bytes": end,
            "sha256": sha256_of(bin_path),
        }
    }
    if not args.no_jsonl and os.path.exists(jsonl):
        manifest["files"]["mesh-records.jsonl.gz"] = {
            "bytes": os.path.getsize(jsonl),
            "sha256": sha256_of(jsonl),
        }
    with open(os.path.join(b.out, "mesh_index.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    write_report(b, ambiguous, T, R, N, end, jsonl if not args.no_jsonl else None, time.time() - t0)
    return 0


def make_fixtures(bin_path):
    """挑一批查询，记录期望结果，供 Node 端跨语言一致性测试。"""
    idx = open_index(bin_path)
    queries = [
        "neoplasms", "neoplasm", "progression-free survival", "Progression-Free Survival",
        "bevonium", "abnormalities", "non-small cell lung carcinoma", "NSCLC",
        "Crohn's disease", "Crohn disease", "hazard ratio", "PD-L1", "trastuzumab",
        "myocardial infarction", "aspirin", "gene expression", "immunotherapy",
    ]
    out = {"format": "MESHIDX1", "queries": []}
    for q in queries:
        hits = idx.lookup(normalize(q))
        out["queries"].append(
            {
                "q": q,
                "norm": normalize(q),
                "n_refs": len(hits),
                "first": idx.record(hits[0]) if hits else None,
            }
        )
    return out


class Index:
    """Python 侧的读取实现，用于 verify / 夹具（与 lib/mesh.js 的口径对齐）。"""

    def __init__(self, buf):
        (magic, self.version, self.T, self.R, self.N, self.def_limit, _built,
         self.off_terms, self.off_term_off, self.off_ref_off, self.off_ref_arr,
         self.off_rec_off, self.off_rec_blob, self.off_meta, self.meta_len,
         _res) = HEADER.unpack_from(buf, 0)
        assert magic == MAGIC, "magic 不符"
        self.buf = buf

    def _u32(self, base, i):
        return struct.unpack_from("<I", self.buf, base + 4 * i)[0]

    def term(self, i):
        a, b = self._u32(self.off_term_off, i), self._u32(self.off_term_off, i + 1)
        return self.buf[self.off_terms + a : self.off_terms + b].decode("utf-8")

    def lookup(self, norm):
        lo, hi = 0, self.T - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            t = self.term(mid)
            if t == norm:
                a = self._u32(self.off_ref_off, mid)
                bnd = self._u32(self.off_ref_off, mid + 1)
                return [self._u32(self.off_ref_arr, k) for k in range(a, bnd)]
            if t < norm:
                lo = mid + 1
            else:
                hi = mid - 1
        return []

    def record(self, i):
        a, b2 = self._u32(self.off_rec_off, i), self._u32(self.off_rec_off, i + 1)
        parts = self.buf[self.off_rec_blob + a : self.off_rec_blob + b2].decode("utf-8").split(FIELD_SEP)
        while len(parts) < 6:
            parts.append("")
        return dict(zip(["id", "name", "def", "cat", "tree", "map"], parts))

    def meta(self):
        return json.loads(self.buf[self.off_meta : self.off_meta + self.meta_len].decode("utf-8"))


def open_index(path):
    with open(path, "rb") as f:
        return Index(f.read())


def verify(args):
    t0 = time.time()
    idx = open_index(os.path.join(args.out, "mesh_index.bin"))
    meta = idx.meta()
    print(f"记录 {idx.R:,}  术语 {idx.T:,}  引用 {idx.N:,}  def_limit {idx.def_limit}")
    print(f"来源：{meta['mesh_release']}  构建：{meta['built_utc']}")
    fails = []
    # 术语表必须严格升序
    prev = ""
    for i in range(idx.T):
        t = idx.term(i)
        if t <= prev:
            fails.append(f"术语未升序：{i} {prev!r} -> {t!r}")
            break
        prev = t
    checks = [
        ("neoplasms", "mesh:D009369"),
        ("bevonium", "mesh:C000002"),
        ("abnormalities", "mesh:Q000002"),
        ("calcimycin", "mesh:D000001"),
    ]
    for q, want in checks:
        hits = idx.lookup(normalize(q))
        got = idx.record(hits[0])["id"] if hits else None
        ok = got == want
        if not ok:
            fails.append(f"{q} -> {got}，期望 {want}")
        print(f"  {'OK ' if ok else 'FAIL'} {q:16s} -> {got}  (候选 {len(hits)})")
    print("耗时 %.1fs" % (time.time() - t0))
    if fails:
        print("失败：")
        for f in fails:
            print("  -", f)
        return 1
    print("全部通过")
    return 0


def write_report(b, ambiguous, T, R, N, bin_bytes, jsonl, elapsed):
    kinds = {}
    for rec in b.records:
        kinds[rec["kind"]] = kinds.get(rec["kind"], 0) + 1
    ambiguous.sort(reverse=True)
    dist = {"2-3": 0, "4-10": 0, "11-100": 0, "101+": 0}
    for n in ambiguous:
        if n <= 3:
            dist["2-3"] += 1
        elif n <= 10:
            dist["4-10"] += 1
        elif n <= 100:
            dist["11-100"] += 1
        else:
            dist["101+"] += 1
    # 最泛化的字面形式留给插件端运行时统计，这里只出分布
    lines = []
    lines.append("MeSH 2026 -> 文献翻译术语索引  构建报告")
    lines.append("=" * 72)
    lines.append(f"构建时间      : {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"耗时          : {elapsed:.1f}s")
    lines.append(f"记录          : {R:,}  " + "  ".join(f"{k}={v:,}" for k, v in sorted(kinds.items())))
    lines.append(f"术语/引用     : {T:,} / {N:,}")
    lines.append(f"索引大小      : {bin_bytes/1048576:.1f} MiB")
    if jsonl and os.path.exists(jsonl):
        lines.append(f"全量语料      : {os.path.getsize(jsonl)/1048576:.1f} MiB (gzip)")
    lines.append("")
    lines.append("歧义分布（一个字面形式指向多少条记录）")
    lines.append("-" * 72)
    for k, v in dist.items():
        lines.append(f"  {k:>7s} : {v:,}")
    lines.append("")
    lines.append("样例（前 12 条记录）")
    lines.append("-" * 72)
    for rec in b.records[:12]:
        lines.append(
            f"  {rec['id']:14s} {rec['kind']:12s} {rec['en'][:44]:46s} {rec['cat']:10s} {rec['def'][:40]}"
        )
    path = os.path.join(b.out, "mesh_build_report.txt")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("报告", path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="MeSH 2026 -> 离线术语索引")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pb = sub.add_parser("build")
    pb.add_argument("--desc", default=DEFAULT_DESC)
    pb.add_argument("--supp", default=DEFAULT_SUPP)
    pb.add_argument("--qual", default=DEFAULT_QUAL)
    pb.add_argument("--out", default="mesh_out")
    pb.add_argument("--limit", type=int, default=0, help="每类只取前 N 条（冒烟用）")
    pb.add_argument("--def-limit", type=int, default=300)
    pb.add_argument("--supp-def-limit", type=int, default=160)
    pb.add_argument("--no-jsonl", action="store_true")
    pb.set_defaults(func=build)

    pv = sub.add_parser("verify")
    pv.add_argument("--out", default="mesh_out")
    pv.set_defaults(func=verify)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
