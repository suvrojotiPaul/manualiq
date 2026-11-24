"""Add dense vectors for every chunk to data/index.sqlite (table chunk_vec), for hybrid search.

    .venv/Scripts/python -I ingest/embed_index.py [--model BAAI/bge-small-en-v1.5] [--batch 64]

Each chunk is embedded with a short header (manual title + section path), the same idea as the
contextual header the keyword index uses. Vectors are L2-normalized float32, stored as BLOBs.
"""
import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "index.sqlite"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("EMBED_MODEL") or "BAAI/bge-small-en-v1.5")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--manual", help="embed only this manual's chunks that have no vector yet (keeps the rest)")
    a = ap.parse_args()

    con = sqlite3.connect(DB, timeout=30)
    sql = """SELECT c.id, c.manual_id, c.section_id, m.title, s.path, c.text
        FROM chunks c JOIN sections s ON s.id = c.section_id JOIN manuals m ON m.id = c.manual_id"""
    has_vec = con.execute("SELECT 1 FROM sqlite_master WHERE name = 'vec_meta'").fetchone()
    if a.manual:
        # incremental: same model as the vectors already stored, only chunks without one
        if has_vec:
            row = con.execute("SELECT model FROM vec_meta").fetchone()
            if row:
                a.model = row[0]
        else:
            con.execute("CREATE TABLE chunk_vec(chunk_id INTEGER PRIMARY KEY, manual_id TEXT, section_id TEXT, vec BLOB)")
            con.execute("CREATE TABLE vec_meta(model TEXT, dim INT, n INT, seconds REAL)")
        rows = con.execute(sql + " WHERE c.manual_id = ? AND c.id NOT IN (SELECT chunk_id FROM chunk_vec)",
                           (a.manual,)).fetchall()
    else:
        rows = con.execute(sql + " ORDER BY c.id").fetchall()
        con.execute("DROP TABLE IF EXISTS chunk_vec")
        con.execute("DROP TABLE IF EXISTS vec_meta")
        con.execute("CREATE TABLE chunk_vec(chunk_id INTEGER PRIMARY KEY, manual_id TEXT, section_id TEXT, vec BLOB)")
        con.execute("CREATE TABLE vec_meta(model TEXT, dim INT, n INT, seconds REAL)")

    model = TextEmbedding(a.model)
    # Sort by length so each batch pads to a similar length (padding to 512 tokens was most of the work).
    rows.sort(key=lambda r: len(r[3]) + len(r[4]) + len(r[5]))
    texts = [f"{title} | {path}\n{text}" for (_id, _m, _s, title, path, text) in rows]
    print(f"embedding {len(texts)} chunks with {a.model}", flush=True)
    t0 = time.time()
    done = 0
    for start in range(0, len(texts), 512):
        part = texts[start:start + 512]
        vecs = np.array(list(model.embed(part, batch_size=a.batch)), dtype=np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-12
        con.executemany("INSERT INTO chunk_vec VALUES(?,?,?,?)", [
            (rows[start + i][0], rows[start + i][1], rows[start + i][2], vecs[i].tobytes()) for i in range(len(part))])
        con.commit()
        done += len(part)
        print(f"[{done}/{len(texts)}] {time.time() - t0:.0f}s", flush=True)
    if not texts:
        print("done: 0 vectors (nothing new)", flush=True)
        return 0
    dim = int(vecs.shape[1])
    total = con.execute("SELECT count(*) FROM chunk_vec").fetchone()[0]
    if con.execute("SELECT count(*) FROM vec_meta").fetchone()[0]:
        con.execute("UPDATE vec_meta SET n = ?", (total,))
    else:
        con.execute("INSERT INTO vec_meta VALUES(?,?,?,?)", (a.model, dim, total, time.time() - t0))
    con.commit()
    con.close()
    print(f"done: {len(texts)} vectors, dim {dim}, {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
