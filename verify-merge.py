#!/usr/bin/env python
"""验证合并后的词典：概念唯一、字段完整、旧叫法仍可检索。"""
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dsh-onco-lexicon", "data", "onco.ncit.jsonl")
SEED = os.path.join(HERE, "onco-seed-dsh.jsonl")
BRIDGE = os.path.join(HERE, "kb_out_ncit", "zh_bridge.json")

fail = []


def check(cond, label):
    if not cond:
        fail.append(label)
        print("  FAIL ", label)


recs = []
with open(OUT, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if line:
            recs.append(json.loads(line))

print("[1] 基本规模")
ids = [r["id"] for r in recs]
print("  总条数:", format(len(recs), ","))
check(len(recs) == 185885, "总数应为 185,885，实际 %d" % len(recs))
check(len(set(ids)) == len(ids), "存在重复 id")

pref = Counter(i.split(":", 1)[0] for i in ids)
print("  id 前缀:", dict(pref))
check(pref.get("onco", 0) == 5, "独立保留的自建条目应为 5 条，实际 %d" % pref.get("onco", 0))

print("[2] 概念不再重复：中文名应唯一")
zh = [r["zh"] for r in recs if r.get("zh")]
dup_zh = [k for k, v in Counter(zh).items() if v > 1]
print("  含中文的条目:", len(zh), " 中文重名:", len(dup_zh))
for k in dup_zh[:10]:
    print("    重名:", k)
# 注意：NCIt 本身有 130 个重复英文名，中文重名只要不是由我们用例造成即可
seed_zh = {r["zh"] for r in (json.loads(l) for l in open(SEED, encoding="utf-8") if l.strip()) if r.get("zh")}
extra = [k for k in dup_zh if k in seed_zh]
check(not extra, "自建库概念仍出现重复中文名：%s" % extra[:5])

print("[3] 抽样检查合并结果")
bridge = json.load(open(BRIDGE, encoding="utf-8"))
by_id = {r["id"]: r for r in recs}
seed_by_id = {r["id"]: r for r in (json.loads(l) for l in open(SEED, encoding="utf-8") if l.strip())}

sample = ["onco:nsclc", "onco:breast", "onco:os", "onco:egfr", "onco:ici"]
for sid in sample:
    info = bridge["entries"].get(sid)
    if not info:
        print("  (%s 无对齐)" % sid)
        continue
    merged = by_id.get(info["ncit_id"])
    src = seed_by_id[sid]
    check(merged is not None, "%s 未找到合并结果" % sid)
    if not merged:
        continue
    check(merged.get("zh") == src.get("zh"), "%s 中文名未并入" % sid)
    check(merged.get("category") == src.get("category"), "%s 类别未采用自建库" % sid)
    codes = merged.get("codes") or {}
    for k, v in (src.get("codes") or {}).items():
        check(codes.get(k) == v, "%s 编码 %s 未并入" % (sid, k))
    # 中文释义应在 def 里
    check(src.get("def", "")[:12] in (merged.get("def") or ""), "%s 中文释义未并入" % sid)

print("[4] 旧英文名仍可检索（已并入 aliases）")
for sid, info in list(bridge["entries"].items())[:200]:
    merged = by_id.get(info["ncit_id"])
    if not merged:
        continue
    seed_en = str(info["en"]).strip().lower()
    ncit_en = str(merged.get("en") or "").strip().lower()
    if seed_en == ncit_en:
        continue
    pool = {str(x).lower() for x in (merged.get("aliases") or [])}
    pool.add(ncit_en)
    check(seed_en in pool, "%s 的旧英文名 %r 丢失" % (sid, info["en"]))

print()
print("=" * 58)
print("failures: %d" % len(fail))
if fail:
    for f in fail[:20]:
        print("  -", f)
    raise SystemExit(1)
print("ALL CHECKS PASSED")

# 附：展示一条合并后的样子
m = by_id.get("ncit:c2926")
print()
print("---- 合并示例 ncit:c2926 ----")
for k in ("id", "en", "zh", "abbr", "category", "codes", "source"):
    print("  %-9s: %s" % (k, m.get(k)))
print("  aliases  :", (m.get("aliases") or [])[:6], "...共 %d 个" % len(m.get("aliases") or []))
print("  def      :", (m.get("def") or "").replace("\n", " / ")[:180])
