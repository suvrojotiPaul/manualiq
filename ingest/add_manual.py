"""Add ONE manual to the existing index without rebuilding it (used by uploads and the inbox folder).

    python -I ingest/add_manual.py init                          create an empty index if there is none
    python -I ingest/add_manual.py parse <pdf> [--meta JSON]     PDF -> data/parsed/<stem>.json
    python -I ingest/add_manual.py index <parsed.json>           insert manual/sections/chunks/FTS rows
    python -I ingest/add_manual.py remove <manual_id>            delete a manual's rows (incl. vectors)

Each command prints one JSON line with its result, so the Node server can report progress.
Vectors for the new chunks are added afterwards by `embed_index.py --manual <id>` (needs fastembed).
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves the script dir off sys.path

from build_index import DB, PARSED, SCHEMA, insert_manual  # noqa: E402


def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=30)
    con.executescript(SCHEMA)
    return con


def cmd_parse(a):
    from parse_manuals import parse_pdf  # pdfplumber only needed here
    pdf = Path(a.target)
    meta = json.loads(a.meta) if a.meta else {}
    meta.setdefault("title", pdf.stem)
    meta.setdefault("filename", pdf.name)
    doc = parse_pdf(pdf, meta)
    PARSED.mkdir(parents=True, exist_ok=True)
    out = PARSED / f"{pdf.stem}.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"parsed": str(out), "id": doc["manual"]["id"], "pages": doc["pages"], "sections": len(doc["sections"])}


def remove(con, mid):
    n = con.execute("SELECT count(*) FROM manuals WHERE id = ?", (mid,)).fetchone()[0]
    con.execute("DELETE FROM chunks_fts WHERE manual_id = ?", (mid,))
    con.execute("DELETE FROM manuals_fts WHERE manual_id = ?", (mid,))
    con.execute("DELETE FROM chunks WHERE manual_id = ?", (mid,))
    con.execute("DELETE FROM sections WHERE manual_id = ?", (mid,))
    con.execute("DELETE FROM manuals WHERE id = ?", (mid,))
    if con.execute("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vec'").fetchone():
        con.execute("DELETE FROM chunk_vec WHERE manual_id = ?", (mid,))
        con.execute("UPDATE vec_meta SET n = (SELECT count(*) FROM chunk_vec)")
    return n


def cmd_index(a):
    d = json.loads(Path(a.target).read_text(encoding="utf-8"))
    con = connect()
    with con:  # one transaction: a failed insert leaves the index as it was
        replaced = remove(con, d["manual"]["id"])
        ns, nc = insert_manual(con, d)
    con.close()
    return {"id": d["manual"]["id"], "sections": ns, "chunks": nc, "replaced": bool(replaced)}


def cmd_remove(a):
    con = connect()
    with con:
        n = remove(con, a.target)
    con.close()
    pj = PARSED / f"{a.target}.json"
    if pj.exists():
        pj.unlink()
    return {"id": a.target, "removed": bool(n)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["init", "parse", "index", "remove"])
    ap.add_argument("target", nargs="?")
    ap.add_argument("--meta")
    a = ap.parse_args()
    try:
        if a.cmd == "init":
            connect().close()
            out = {"db": str(DB)}
        else:
            out = {"parse": cmd_parse, "index": cmd_index, "remove": cmd_remove}[a.cmd](a)
        print(json.dumps({"ok": True, **out}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": repr(e)}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
