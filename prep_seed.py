#!/usr/bin/env python
"""Generate onco-seed-dsh.jsonl from the curated oncology seed set.

The upstream source (dataonco.seed.jsonl.txt) is a *concatenated JSON stream*:
every record sits on the SAME physical line with no separator, so the original
Node `split('\n')` prep script silently produced a single unparseable line.
This script instead walks the buffer with json.JSONDecoder.raw_decode, which
handles both a real JSONL file and a newline-free concatenated stream.

For every record it synthesises the `text` field used for vector retrieval:

    text = en + zh + aliases... + abbr...

`def` is deliberately NOT folded into `text` so that the retrieval space stays
a terminology space (names and synonyms); the definition is kept in the KB as
context to display next to a hit.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

TEXT_FIELDS_SINGLE = ("en", "zh")
TEXT_FIELDS_LIST = ("aliases", "abbr")


def parse_stream(raw: str) -> list[dict]:
    """Parse JSONL *or* a newline-free concatenated JSON stream."""
    recs: list[dict] = []
    dec = json.JSONDecoder()
    i, n = 0, len(raw)
    while i < n:
        while i < n and raw[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        obj, i = dec.raw_decode(raw, i)
        recs.append(obj)
    return recs


def build_text(rec: dict) -> str:
    parts: list[str] = []
    for key in TEXT_FIELDS_SINGLE:
        val = rec.get(key)
        if isinstance(val, str) and val.strip():
            parts.append(val.strip())
    for key in TEXT_FIELDS_LIST:
        val = rec.get(key)
        if isinstance(val, list):
            parts.extend(str(x).strip() for x in val if str(x).strip())
        elif isinstance(val, str) and val.strip():
            parts.append(val.strip())
    # de-duplicate while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        k = p.lower()
        if k not in seen:
            seen.add(k)
            out.append(p)
    return " ".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Prepare onco-seed-dsh.jsonl")
    ap.add_argument(
        "--data",
        default=os.environ.get("ONCO_SEED_SRC")
        or os.path.join(os.path.dirname(os.path.abspath(__file__)), "dataonco.seed.jsonl.txt"),
        help="种子词典源文件（也可用环境变量 ONCO_SEED_SRC 指定；默认取脚本同目录）",
    )
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "onco-seed-dsh.jsonl"))
    args = ap.parse_args()

    with open(args.data, "r", encoding="utf-8") as fh:
        raw = fh.read()

    recs = parse_stream(raw)
    print(f"parsed {len(recs)} records from {args.data}")

    missing_text = 0
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        for rec in recs:
            rec["text"] = build_text(rec)
            if not rec["text"]:
                missing_text += 1
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"wrote {len(recs)} records -> {args.out}")
    print(f"records with empty text: {missing_text}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
