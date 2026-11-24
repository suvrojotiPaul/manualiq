"""Build the search index (SQLite + FTS5) from data/parsed/*.json.

    python -I ingest/build_index.py

Writes data/index.sqlite with:
  manuals       one row per manual (metadata, toc, token estimate)       -> L0 manual cards
  sections      one row per section (full markdown text)                 -> L1, what the model sees
  chunks        small search units with a contextual header              -> L2, what we search
  manuals_fts   full-text search over manual cards (routing)
  chunks_fts    full-text search over chunks (header, body, codes)

"codes" columns hold part/model numbers normalized (BLK-13048 -> blk13048) so exact
lookups work even though the normal tokenizer splits on hyphens.
"""
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PARSED = DATA / "parsed"
DB = DATA / "index.sqlite"

CODE_RE = re.compile(r"\b(?=[A-Za-z0-9./-]*\d)(?=[A-Za-z0-9./-]*[A-Za-z-])[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+)*\b")
CHUNK_CHARS = 1100


def codes_of(text: str) -> str:
    out = set()
    for m in CODE_RE.finditer(text):
        tok = m.group(0)
        norm = re.sub(r"[-./]", "", tok).lower()
        if len(norm) >= 4 and re.search(r"\d", norm) and not re.fullmatch(r"\d{1,4}", norm):
            out.add(norm)
    return " ".join(sorted(out))


DOUBLED_RE = re.compile(r"\S{4,}")


def undouble(text: str) -> str:
    """Fix bold-overprint text where every character is doubled: 'FFiigguurree 44' -> 'Figure 4'."""
    def fix(m):
        w = m.group(0)
        ok = len(w) % 2 == 0 and w[0::2] == w[1::2] and re.search(r"[A-Za-z]{2}", w[0::2])
        return w[0::2] if ok else w
    return DOUBLED_RE.sub(fix, text)


def est_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def split_chunks(text: str) -> list[str]:
    """Split a section into ~CHUNK_CHARS search units at paragraph/step/table-row boundaries."""
    blocks, chunks, buf = [], [], ""
    for para in re.split(r"\n\s*\n|\n(?=\d{1,2}[\.\)] )", text):
        para = para.strip()
        if not para:
            continue
        if para.startswith("|") and len(para) > CHUNK_CHARS:
            rows = para.split("\n")
            head, body = rows[:2], rows[2:]
            for i in range(0, len(body), 12):
                blocks.append("\n".join(head + body[i:i + 12]))
        else:
            blocks.append(para)
    for b in blocks:
        if buf and len(buf) + len(b) > CHUNK_CHARS:
            chunks.append(buf)
            buf = ""
        buf = (buf + "\n" + b).strip()
    if buf:
        chunks.append(buf)
    return chunks


SCHEMA = """
    CREATE TABLE IF NOT EXISTS manuals(id TEXT PRIMARY KEY, doc_number TEXT, version TEXT, title TEXT, description TEXT,
        models TEXT, tags TEXT, status TEXT, language TEXT, date TEXT, url TEXT, filename TEXT,
        pages INT, toc TEXT, image_pages TEXT, tokens INT, n_sections INT);
    CREATE TABLE IF NOT EXISTS sections(id TEXT PRIMARY KEY, manual_id TEXT, ord INT, title TEXT, path TEXT, level INT,
        page_start INT, page_end INT, kind TEXT, text TEXT, tokens INT, needs_vision INT);
    CREATE INDEX IF NOT EXISTS sections_manual ON sections(manual_id, ord);
    CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, section_id TEXT, manual_id TEXT, ord INT, text TEXT);
    CREATE INDEX IF NOT EXISTS chunks_manual ON chunks(manual_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS manuals_fts USING fts5(manual_id UNINDEXED, title, description, models, tags, toc, codes,
        tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, section_id UNINDEXED, manual_id UNINDEXED,
        header, body, codes, tokenize='porter unicode61');
"""


def insert_manual(con, d: dict) -> tuple[int, int]:
    """Insert one parsed manual (manual row, sections, chunks, FTS rows). Returns (sections, chunks)."""
    n_sec = n_chunk = 0
    m = d["manual"]
    mid = m["id"]
    secs = [s for s in d["sections"] if s["text"].strip()]
    for s in secs:
        s["text"], s["title"], s["path"] = undouble(s["text"]), undouble(s["title"]), undouble(s["path"])
    tokens = sum(est_tokens(s["text"]) for s in secs if s.get("kind") != "contents")
    models = m.get("models") or []
    tags = [t for t in m.get("tags", []) if t not in ("Manuals", "Current", "Archive", "English")]
    toc_text = " | ".join(t["title"] for t in d.get("toc", []))
    con.execute("INSERT INTO manuals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        mid, m.get("doc_number", ""), m.get("version", ""), m.get("title", ""), m.get("description", ""),
        json.dumps(models), json.dumps(tags), m.get("status", ""), m.get("language", ""), m.get("date", ""),
        m.get("url", ""), m.get("filename", ""), d["pages"], json.dumps(d.get("toc", [])),
        json.dumps(d.get("image_pages", [])), tokens, len(secs)))
    card_codes = codes_of(" ".join([m.get("title", ""), m.get("description", ""), m.get("doc_number", ""), " ".join(models), mid]))
    con.execute("INSERT INTO manuals_fts VALUES(?,?,?,?,?,?,?)", (
        mid, m.get("title", ""), m.get("description", ""), " ".join(models), " ".join(tags), toc_text, card_codes))
    for i, s in enumerate(secs):
        con.execute("INSERT INTO sections VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
            s["id"], mid, i, s["title"], s["path"], s["level"], s["page_start"], s["page_end"],
            s.get("kind", "content"), s["text"], est_tokens(s["text"]), int(s.get("needs_vision", False))))
        n_sec += 1
        if s.get("kind") == "contents":
            continue  # table of contents pages: keep for display, don't search
        header = (f"{m.get('title', '')} | {m.get('doc_number', '')} v{m.get('version', '')} | "
                  f"Models: {', '.join(models) or '-'} | Section: {s['path']} | Pages {s['page_start']}-{s['page_end']}")
        for k, ch in enumerate(split_chunks(s["text"])):
            cur = con.execute("INSERT INTO chunks(section_id, manual_id, ord, text) VALUES(?,?,?,?)", (s["id"], mid, k, ch))
            con.execute("INSERT INTO chunks_fts VALUES(?,?,?,?,?,?)", (
                cur.lastrowid, s["id"], mid, header, ch, codes_of(ch + " " + s["title"]) + " " + card_codes))
            n_chunk += 1
    return n_sec, n_chunk


def main():
    if DB.exists():
        DB.unlink()
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    n_man = n_sec = n_chunk = 0
    for f in sorted(PARSED.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        ns, nc = insert_manual(con, d)
        n_man += 1
        n_sec += ns
        n_chunk += nc
    con.commit()
    con.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
    con.commit()
    con.close()
    print(f"indexed {n_man} manuals, {n_sec} sections, {n_chunk} chunks -> {DB}")


if __name__ == "__main__":
    main()
