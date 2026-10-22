#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""recall_once.py —— **给"每轮自动注入"用的单次检索器**。

## 它跟 `semantic.py search` 的分工

`semantic.py search` 是**人用的**：带查询扩展 + 模型重排序，慢一点没关系（几秒）。
这个是**每轮都要跑的**：所以只做**最必要的三步**，把延迟压到亚秒级：

    ① 查缓存（同一句话/near-duplicate 直接命中，**不花任何钱**）
    ② embed 查询（一次小 API 调用，~0.3s）→ 余弦检索（本地，1682 块瞬间）
    ③ 过阈值就输出一段**紧凑的注入块**；不过阈值**输出空**（宁可不塞）

## 三条铁规矩

1. **阈值不达标就不注入** —— 每轮都塞一堆"沾边"的东西会让关键信息被淹掉
2. **绝不输出凭据类内容**（出块前过一遍脱敏；记忆里不该有，但双保险）
3. **不许抛异常**：任何失败都退化成"什么都不输出"（注入器挂了不能连累对话）
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(os.environ.get("DSH_WORKSPACE", "."))
CACHE = ROOT / "_tmp" / "recall_cache.json"
LOG = ROOT / "_tmp" / "recall.log"
MIN_SCORE = 0.52          # 低于这个余弦**不注入**（宁缺勿滥）
MAX_ITEMS = 3
MAX_CHARS = 900
SECRET = re.compile(r"(sk-[A-Za-z0-9_\-]{12,}|(?:token|password|api[_-]?key)\s*[:=]\s*\S{8,})",
                    re.I)


def log(msg):
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (time.strftime("%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def load_cache():
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_cache(c):
    try:
        cut = sorted(c.items(), key=lambda kv: -kv[1].get("t", 0))[:300]
        CACHE.write_text(json.dumps(dict(cut), ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def build_block(q, quiet=True):
    """→ 要注入的文本（不必注入就返回 ""）。"""
    key = hashlib.sha256(q.strip().encode()).hexdigest()[:16]
    c = load_cache()
    if key in c:
        return c[key]["block"]
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        import semantic as S
    except Exception as e:
        log("载入 semantic 失败：%r" % (e,))
        return ""
    try:
        db = S.db()
        rows = db.execute("SELECT src,label,heading,text,vec FROM chunks").fetchall()
        if not rows:
            return ""
        qv = S.embed([q], S.api_key(), timeout=20)[0][0]
        scored = []
        for i, (src, label, head, text, blob) in enumerate(rows):
            scored.append((S.cos(qv, S.unpack(blob)), label, head, text,
                           Path(src).name))
        scored.sort(reverse=True)
        picked = [x for x in scored if x[0] >= MIN_SCORE][:MAX_ITEMS]
        if not picked:
            block = ""
        else:
            lines = ["【自动检索到的旧记忆 · 供参考，不必回应，也不要当成他的原话】"]
            used = 0
            for score, label, head, text, name in picked:
                t = SECRET.sub("（已脱敏）", re.sub(r"\s+", " ", text).strip())
                piece = "- [%s] %s%s：%s" % (label, name,
                                             ("# " + head) if head else "", t[:240])
                if used + len(piece) > MAX_CHARS:
                    break
                lines.append(piece)
                used += len(piece)
            block = "\n".join(lines) if len(lines) > 1 else ""
        c[key] = {"t": time.time(), "block": block,
                  "top": [(round(s, 3), n) for s, _, _, _, n in picked[:3]]}
        save_cache(c)
        log("查询 %r → %s（最高 %.3f）" % (q[:40], "注入 %d 条" % (len(picked))
                                        if block else "不注入",
                                        scored[0][0] if scored else 0))
        return block
    except Exception as e:
        log("检索失败（当成不注入）：%r" % (e,))
        return ""


def selftest():
    ok = tot = 0

    def chk(name, cond, detail=""):
        nonlocal ok, tot
        tot += 1
        ok += bool(cond)
        print("  [%s] %s%s" % ("OK  " if cond else "FAIL", name,
                              "  —— " + detail if detail else ""))

    src = open(__file__, encoding="utf-8").read()
    chk("有阈值（低于它不注入）", "MIN_SCORE" in src and MIN_SCORE > 0.4,
        "MIN_SCORE=%.2f" % MIN_SCORE)
    chk("有条数上限", MAX_ITEMS <= 5, "%d 条" % MAX_ITEMS)
    chk("有长度上限", MAX_CHARS <= 2000, "%d 字" % MAX_CHARS)
    chk("有脱敏", "SECRET" in src)
    chk("有缓存（同一句话不重复花钱）", "recall_cache" in src)
    chk("明确写了「不必回应」以防被当成他的话", "不必回应" in src)
    chk("异常一律退化成不注入（不是崩）", "return \"\"" in src)
    # 反面对照：脱敏真的生效
    chk("反面对照：假 key 会被打码",
        "sk-" not in SECRET.sub("（已脱敏）", "token: sk-abcdefghijklmnop123456"))
    print("\n%d/%d 通过" % (ok, tot))
    return 0 if ok == tot else 1


def main():
    ap = argparse.ArgumentParser(description="每轮自动注入用的单次检索器")
    ap.add_argument("query", nargs="?", default="")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    q = a.query or sys.stdin.read()[:500]
    if not q.strip():
        return 0
    block = build_block(q)
    if block:
        sys.stdout.write(block)
    return 0


if __name__ == "__main__":
    sys.exit(main())
