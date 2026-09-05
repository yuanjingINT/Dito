#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 archwiki/raw/*.wiki 解析成数据集。

输出：
  dist/archwiki_sections.jsonl   RAG/检索用分段数据
  dist/archwiki_qa.jsonl         SFT 用 ChatML 问答数据（带 Dito system prompt）

用法：python3 make_dataset.py [--min-len 80]
"""
import argparse
import json
import pathlib
import re
import sys

import mwparserfromhell

HERE = pathlib.Path(__file__).resolve().parent
RAW = HERE / "raw"
DIST = HERE / "dist"
DIST.mkdir(exist_ok=True)

SYSTEM_PATH = HERE.parent / "dataset" / "system_prompt.txt"


def render(code) -> str:
    """把 wikitext 渲染成近似 Markdown 的纯文本。"""
    out = []
    for n in code.nodes:
        t = type(n).__name__
        if t == "Text":
            out.append(str(n))
        elif t == "Template":
            name = n.name.strip().lower()

            def p(i):
                try:
                    return render(n.params[i].value).strip()
                except Exception:
                    return ""

            if name in ("", "!"):
                out.append("|")
            elif name == "ic":
                out.append("`" + p(0) + "`")
            elif name == "man":
                vals = [p(i) for i in range(len(n.params))]
                digits = [v for v in vals if v.isdigit()]
                names = [v for v in vals if v and not v.isdigit()]
                if names and digits:
                    out.append(f"{names[0]}({digits[0]})")
                elif names:
                    out.append(names[0])
            elif name in ("pkg", "grp"):
                out.append(p(0))
            elif name == "aur":
                out.append(p(0) + " (AUR)")
            elif name in ("bc", "hc", "console", "code"):
                out.append("\n```\n" + p(0) + "\n```\n")
            elif name in ("tip", "note", "warning", "hint"):
                out.append("\n> " + p(0) + "\n")
            else:
                out.append("")
        elif t == "Wikilink":
            out.append(str(n.text) if n.text else str(n.title))
        elif t == "ExternalLink":
            out.append(str(n.title) if n.title else str(n.url))
        elif t == "Heading":
            out.append("\n\n" + "#" * n.level + " " + str(n.title).strip() + "\n\n")
        elif t == "Tag":
            tag = str(n.tag).lower()
            if tag in ("pre", "code"):
                inner = str(n.contents) if n.contents else ""
                if tag == "pre":
                    out.append("\n```\n" + inner + "\n```\n")
                else:
                    out.append("`" + inner + "`")
            elif tag == "br" or tag == "li":
                out.append("\n")
            elif tag in ("ref", "references"):
                continue
            elif tag == "nowiki":
                out.append(str(n.contents) if n.contents else "")
            else:
                out.append(str(n.contents) if n.contents else "")
        elif t == "HTMLEntity":
            out.append(n.normalize() if hasattr(n, "normalize") else str(n))
        elif t == "Comment":
            continue
        else:
            out.append(str(n))
    return "".join(out)


def clean_page(raw: str) -> str:
    if raw.lstrip().lower().startswith("#redirect"):
        return ""
    text = render(mwparserfromhell.parse(raw))
    # 去掉 {{...}} 残留、多余的 HTML 标签、连续空行
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r"^[a-z-]+:[A-Za-z]", stripped) or stripped.startswith("Category:"):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


def split_sections(title: str, text: str):
    """按标题行拆段，返回 [(heading, content)]。"""
    if not text:
        return []
    lines = text.splitlines()
    sections = []
    current_heading = "Introduction"
    current = []
    heading_re = re.compile(r"^#{2,4}\s+(.*)$")

    def flush():
        content = "\n".join(current).strip()
        if content:
            sections.append((current_heading, content))
        current.clear()

    for line in lines:
        m = heading_re.match(line)
        if m:
            flush()
            current_heading = m.group(1).strip()
        else:
            current.append(line)
    flush()
    return sections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-len", type=int, default=80, help="章节最短字符数，低于此长度丢弃")
    args = ap.parse_args()

    system_prompt = SYSTEM_PATH.read_text(encoding="utf-8").strip()
    pages = sorted(RAW.glob("*.wiki"))
    sections_out = []
    qa_out = []
    skipped = {"empty": 0, "short": 0}
    total_sections = 0

    q_templates = [
        "根据 Arch Wiki 的《{title}》，讲讲「{heading}」",
        "Arch Wiki 里《{title}》的「{heading}」讲了啥",
        "给我讲讲 Arch Wiki 中《{title}》关于「{heading}」的内容",
        "《{title}》里「{heading}」这部分，挑重点说说",
    ]
    closings = [
        "大概就是这些，有具体问题再问我",
        "懂了吧，不清楚的地方直接贴报错给我",
        "按这几个点走基本不会翻车，遇到坑再叫我",
        "先这样，实际操作卡住了随时来",
    ]

    for pidx, f in enumerate(pages, 1):
        title = f.stem.replace("_", " ")
        text = clean_page(f.read_text(encoding="utf-8"))
        if not text:
            skipped["empty"] += 1
            continue
        for sidx, (heading, content) in enumerate(split_sections(title, text)):
            if len(content) < args.min_len:
                skipped["short"] += 1
                continue
            total_sections += 1
            sections_out.append({
                "id": f"{title}/{heading}",
                "title": title,
                "heading": heading,
                "content": content,
            })
            question = q_templates[(pidx + sidx) % len(q_templates)].format(title=title, heading=heading)
            answer = (
                f"查到了。关于《{title}》的「{heading}」：\n\n{content}\n\n"
                f"{closings[(pidx + sidx) % len(closings)]}。"
            )
            qa_out.append({
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": question},
                    {"role": "assistant", "content": answer},
                ],
                "meta": {"source": "archwiki", "title": title, "heading": heading},
            })

    with open(DIST / "archwiki_sections.jsonl", "w", encoding="utf-8") as f:
        for rec in sections_out:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(DIST / "archwiki_qa.jsonl", "w", encoding="utf-8") as f:
        for rec in qa_out:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"页面数: {len(pages)}")
    print(f"有效章节: {total_sections}（空页 {skipped['empty']}，短章节 {skipped['short']}）")
    print(f"输出: {DIST / 'archwiki_sections.jsonl'}")
    print(f"输出: {DIST / 'archwiki_qa.jsonl'}")


if __name__ == "__main__":
    main()