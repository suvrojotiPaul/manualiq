"""Parse downloaded manual PDFs into structured JSON (one file per manual).

    python -I ingest/parse_manuals.py [--limit N] [--only FILENAME ...] [--workers 8]

Reads  $PDF_DIR/*.pdf (default data/pdfs) + optional metadata data/documents.json
       ([{filename, doc_number, version, title, description, models, tags, url, ...}]; filename is required).
       Without metadata the title is the file name.
Writes data/parsed/<pdf-stem>.json:
  {manual: {...metadata...}, pages: N, toc: [...], sections: [
     {id, title, path, level, page_start, page_end, text (markdown), needs_vision}
  ], image_pages: [page numbers that are mostly drawings/diagrams]}

Approach (see PLAN.md section 2):
  - text lines with font size / bold from pdfplumber
  - repeated header/footer lines removed (lines that recur on many pages)
  - tables extracted as markdown, their text removed from the running text
  - headings: from the PDF outline (bookmarks) when present, plus font-size heuristics
  - pages with little text but drawings -> flagged for a later vision pass
"""
import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PDF_DIR = Path(os.environ["PDF_DIR"]) if os.environ.get("PDF_DIR") else DATA / "pdfs"
OUT_DIR = DATA / "parsed"

PAGE_NO_RE = re.compile(r"^(page\s*\d+(\s*of\s*\d+)?|\d+\s*of\s*\d+|\d{1,3})$", re.I)
EDGE = 0.15  # top/bottom fraction of the page treated as header/footer margin
STEP_RE = re.compile(r"^\s*(\d{1,2}[\.\)]|[a-z][\.\)]|•|-|–)\s+")


def norm_line(s: str) -> str:
    return re.sub(r"\d+", "#", s.strip().lower())


def table_to_md(rows: list[list]) -> str:
    rows = [[(c or "").replace("\n", " ").strip() for c in r] for r in rows if r and any(c for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(out)


def page_lines(page) -> tuple[list[dict], list[dict]]:
    """Return (lines, tables) for a page. Lines carry size/bold/top; tables carry markdown/top."""
    tables = []
    try:
        found = page.find_tables()
    except Exception:  # noqa: BLE001
        found = []
    boxes = []
    for t in found:
        try:
            rows = t.extract()
        except Exception:  # noqa: BLE001
            continue
        # skip "tables" that are really layout boxes (1 column or 1 row)
        if not rows or len(rows) < 2 or max(len(r) for r in rows) < 2:
            continue
        md = table_to_md(rows)
        if md:
            tables.append({"top": t.bbox[1], "md": md})
            boxes.append(t.bbox)

    def outside(obj):
        if obj.get("object_type") != "char":
            return True
        x = (obj["x0"] + obj["x1"]) / 2
        y = (obj["top"] + obj["bottom"]) / 2
        return not any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)

    p = page.filter(outside) if boxes else page
    p = p.dedupe_chars()  # bold-overprint PDFs draw each character twice
    lines = []
    for ln in p.extract_text_lines(return_chars=True, strip=True):
        chars = [c for c in ln["chars"] if c["text"].strip()]
        if not chars or not ln["text"].strip():
            continue
        sizes = [round(c["size"], 1) for c in chars]
        bold = sum(1 for c in chars if "bold" in c["fontname"].lower()) / len(chars) > 0.6
        lines.append({"text": ln["text"].strip(), "size": statistics.median(sizes), "bold": bold,
                      "top": ln["top"], "bottom": ln["bottom"], "h": page.height})
    return lines, tables


def read_outline(pdf) -> list[dict]:
    """[{title, level, page}] from the PDF bookmarks, if any (page is 1-based)."""
    out = []
    try:
        doc = pdf.doc
        pages_by_id = {p.pageid: i + 1 for i, p in enumerate(pdf.pages)}
        for level, title, dest, action, _se in doc.get_outlines():
            page = None
            try:
                d = dest
                if d is None and action and hasattr(action, "resolve"):
                    a = action.resolve()
                    d = a.get("D") if isinstance(a, dict) else None
                if isinstance(d, (bytes, str)):
                    d = doc.get_dest(d)
                if hasattr(d, "resolve"):
                    d = d.resolve()
                if isinstance(d, dict):
                    d = d.get("D")
                if isinstance(d, list) and d:
                    ref = d[0]
                    page = pages_by_id.get(getattr(ref, "objid", None))
            except Exception:  # noqa: BLE001
                page = None
            if title and page:
                out.append({"title": str(title).strip(), "level": int(level), "page": page})
    except Exception:  # noqa: BLE001
        pass
    return out


def parse_pdf(path: Path, meta: dict) -> dict:
    with pdfplumber.open(path) as pdf:
        n = len(pdf.pages)
        outline = read_outline(pdf)
        per_page = []
        image_pages = []
        for i, page in enumerate(pdf.pages, 1):
            lines, tables = page_lines(page)
            nchars = sum(len(l["text"]) for l in lines) + sum(len(t["md"]) for t in tables)
            drawings = len(page.images) + (1 if len(page.curves) + len(page.rects) + len(page.lines) > 150 else 0)
            if nchars < 400 and drawings:
                image_pages.append(i)
            per_page.append((lines, tables))

    # --- header/footer detection: normalized lines in top/bottom 10% that repeat on many pages
    edge_counts = Counter()
    for lines, _ in per_page:
        seen = set()
        for l in lines:
            if l["top"] < l["h"] * EDGE or l["bottom"] > l["h"] * (1 - EDGE):
                seen.add(norm_line(l["text"]))
        edge_counts.update(seen)
    # running headers/footers: same (digit-normalized) line in the page margin on several pages
    threshold = 3 if n >= 6 else max(2, n // 2 + 1)
    boiler = {k for k, c in edge_counts.items() if c >= threshold} if n >= 3 else set()

    def is_boiler(l):
        t = l["text"]
        if PAGE_NO_RE.match(t.strip()):
            return True
        if re.search(r"\bpage\s*\d+\s*of\s*\d+\b", t, re.I) and len(t) < 90:
            return True
        edge = l["top"] < l["h"] * EDGE or l["bottom"] > l["h"] * (1 - EDGE)
        return edge and norm_line(t) in boiler

    # --- body font size = most common size by characters
    size_chars = Counter()
    for lines, _ in per_page:
        for l in lines:
            size_chars[l["size"]] += len(l["text"])
    body = size_chars.most_common(1)[0][0] if size_chars else 10.0
    big_sizes = sorted({s for s in size_chars if s >= body + 1.5}, reverse=True)

    title_l = (meta.get("title") or "").lower()

    def is_cover_heading(t, pno):
        tl = t.lower().strip()
        own = re.sub(r"[^a-z0-9]", "", str(meta.get("doc_number") or "").lower())
        if own and len(own) >= 4 and re.sub(r"[^a-z0-9]", "", tl).startswith(own):
            return True  # the document's own number printed as a big heading
        if pno > 2:
            return False
        if title_l and (tl in title_l or title_l in tl):
            return True
        return bool(re.search(r"\b(manual|instructions|guide)\b", tl) and len(tl.split()) <= 5)

    def looks_like_diagram_label(t):
        toks = t.split()
        codes = sum(1 for w in toks if re.fullmatch(r"[A-Z]{1,5}\d{1,3}[A-Z]?|GND|VAC|VDC|L1|L2|N", w))
        dup = len(toks) >= 2 and len(set(w.lower() for w in toks)) <= len(toks) / 2
        return codes >= 2 or dup

    def heading_level(l):
        t = l["text"]
        if len(t) > 90 or len(t) < 3 or STEP_RE.match(t) or t.endswith((".", ",", ";", ":")):
            return None
        if not re.search(r"[A-Za-z]{3}", t) or looks_like_diagram_label(t):
            return None
        if l["size"] >= body + 1.5:
            return 1 + min(big_sizes.index(l["size"]) if l["size"] in big_sizes else 0, 2)
        if l["bold"] and l["size"] >= body and len(t) <= 70 and not t.isupper() or (l["bold"] and t.isupper() and 4 <= len(t) <= 50 and not t.startswith(("NOTE", "WARNING", "CAUTION", "DANGER", "IMPORTANT"))):
            return 4
        return None

    outline_titles = {}
    for o in outline:
        outline_titles.setdefault(o["page"], []).append(o)

    # --- walk pages, build sections
    sections = []
    stack: list[tuple[int, str]] = []  # (level, title) breadcrumb
    cur = None

    def start(title, level, page):
        nonlocal cur, stack
        if cur and cur["text"].strip():
            sections.append(cur)
        elif cur and not cur["text"].strip() and sections and level > cur["level"]:
            # empty heading directly followed by a sub-heading: keep it in the breadcrumb only
            pass
        stack = [s for s in stack if s[0] < level] + [(level, title)]
        cur = {"title": title, "level": level, "path": " > ".join(s[1] for s in stack),
               "page_start": page, "page_end": page, "text": ""}

    start(meta.get("title") or path.stem, 0, 1)
    for pno, (lines, tables) in enumerate(per_page, 1):
        # outline entries for this page start sections at the matching line (or page top)
        pending_outline = list(outline_titles.get(pno, []))
        items = [("line", l["top"], l) for l in lines if not is_boiler(l)] + [("table", t["top"], t) for t in tables]
        items.sort(key=lambda x: x[1])
        if pending_outline and items:
            # outline titles that don't appear as a line start the page
            texts = {norm_line(it[2]["text"]) for it in items if it[0] == "line"}
            for o in list(pending_outline):
                if norm_line(o["title"]) not in texts:
                    start(o["title"], o["level"], pno)
                    pending_outline.remove(o)
        para = []

        def flush():
            if para:
                cur["text"] += " ".join(para).strip() + "\n"
                para.clear()

        for kind, _top, it in items:
            if kind == "table":
                flush()
                cur["text"] += "\n" + it["md"] + "\n\n"
                cur["page_end"] = pno
                continue
            t = it["text"]
            ol = next((o for o in pending_outline if norm_line(o["title"]) == norm_line(t)), None)
            lvl = ol["level"] if ol else heading_level(it)
            if ol:
                pending_outline.remove(ol)
            if lvl is not None and not ol and is_cover_heading(t, pno):
                lvl = None
                cur["text"] += f"**{t}**\n"
                continue
            if lvl is not None:
                flush()
                if ol or lvl <= 3 or len(cur["text"]) > 200 or not cur["text"].strip():
                    start(t, lvl, pno)
                else:  # minor bold label inside a short section: keep as bold text
                    cur["text"] += f"\n**{t}**\n"
                continue
            if STEP_RE.match(t) or t.upper().startswith(("NOTE", "WARNING", "CAUTION", "DANGER", "IMPORTANT")):
                flush()
            para.append(t)
            if t.endswith((".", ":", "?", "!")) or len(t) < 45:
                flush()
            cur["page_end"] = pno
        flush()
        if pno in image_pages:
            cur["text"] += f"\n[Page {pno}: mostly a drawing/diagram — see the PDF page]\n"
    if cur and cur["text"].strip():
        sections.append(cur)

    # --- merge "(Continued)" sections and tiny sections, then split huge ones
    def base_title(t):
        return re.sub(r"\s*\((continued|cont\.?)\)\s*$", "", t, flags=re.I).strip().lower()

    merged, carry = [], None
    for s in sections:
        if carry:  # a tiny parent heading carried forward into this section
            s["text"] = carry["text"] + "\n" + s["text"]
            s["page_start"] = min(s["page_start"], carry["page_start"])
            carry = None
        prev = merged[-1] if merged else None
        if prev and re.search(r"\((continued|cont\.?)\)\s*$", s["title"], re.I) and base_title(s["title"]) == base_title(prev["title"]):
            prev["text"] += "\n" + s["text"]
            prev["page_end"] = max(prev["page_end"], s["page_end"])
        elif prev and len(s["text"]) < 150 and s["level"] >= prev["level"]:
            prev["text"] += f"\n**{s['title']}**\n" + s["text"]
            prev["page_end"] = max(prev["page_end"], s["page_end"])
        elif len(s["text"]) < 150:
            carry = {**s, "text": f"**{s['title']}**\n{s['text']}"}
        else:
            merged.append(s)
    if carry:
        merged.append({**carry, "text": carry["text"]})
    for s in merged:
        s["kind"] = "contents" if re.fullmatch(r"(table of )?contents", s["title"].strip(), re.I) else "content"
    final = []
    MAX = 14000  # ~3.5k tokens
    for s in merged:
        if len(s["text"]) <= MAX:
            final.append(s)
            continue
        parts, buf = [], ""
        for block in re.split(r"\n(?=\d{1,2}[\.\)] |\*\*|\|)", s["text"]):
            if len(buf) + len(block) > MAX and buf:
                parts.append(buf)
                buf = ""
            buf += block + "\n"
        if buf:
            parts.append(buf)
        for k, ptxt in enumerate(parts, 1):
            final.append({**s, "title": f"{s['title']} (part {k}/{len(parts)})", "text": ptxt})
    for i, s in enumerate(final):
        s["id"] = f"{path.stem}#s{i}"
        s["text"] = re.sub(r"\n{3,}", "\n\n", s["text"]).strip()
        s["needs_vision"] = any(p in image_pages for p in range(s["page_start"], s["page_end"] + 1))

    return {
        "manual": {**meta, "id": path.stem},
        "pages": n,
        "toc": [{"title": o["title"], "level": o["level"], "page": o["page"]} for o in outline] or
               [{"title": s["title"], "level": s["level"], "page": s["page_start"]} for s in final if s["level"] <= 2],
        "image_pages": image_pages,
        "body_font_size": body,
        "sections": final,
    }


def work(args):
    path, meta = args
    out = OUT_DIR / f"{Path(path).stem}.json"
    try:
        doc = parse_pdf(Path(path), meta)
        out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        return path, len(doc["sections"]), doc["pages"], None
    except Exception as e:  # noqa: BLE001
        return path, 0, 0, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta_file = next((f for f in (DATA / "documents.json", DATA / "manuals_index.json") if f.exists()), None)
    index = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file else []
    by_file = {}
    for it in index:  # first (newest) entry per filename wins
        by_file.setdefault(it["filename"], it)
    jobs = []
    for pdf in sorted(PDF_DIR.glob("*.pdf")):
        if a.only and pdf.name not in a.only:
            continue
        if not a.force and (OUT_DIR / f"{pdf.stem}.json").exists():
            continue
        jobs.append((str(pdf), by_file.get(pdf.name, {"title": pdf.stem, "filename": pdf.name})))
    if a.limit:
        jobs = jobs[: a.limit]
    print(f"parsing {len(jobs)} PDFs with {a.workers} workers")
    errors = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(work, j) for j in jobs]
        for k, f in enumerate(as_completed(futs), 1):
            path, nsec, npages, err = f.result()
            if err:
                errors.append({"file": path, "error": err})
                print(f"[{k}/{len(jobs)}] ERROR {Path(path).name}: {err}", file=sys.stderr)
            elif k % 25 == 0 or len(jobs) <= 30:
                print(f"[{k}/{len(jobs)}] {Path(path).name}: {npages} pages -> {nsec} sections")
    (DATA / "parse_errors.json").write_text(json.dumps(errors, indent=1), encoding="utf-8")
    print(f"done, {len(errors)} errors")


if __name__ == "__main__":
    main()
