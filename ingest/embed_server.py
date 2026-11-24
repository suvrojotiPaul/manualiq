"""Query embedder for hybrid search: started once by the Node server, one JSON request per stdin line.

    in:  {"id": 1, "text": "fan vibrates a lot"}
    out: {"id": 1, "v": [0.01, ...]}           (L2-normalized, same model as embed_index.py)
"""
import json
import sys

import numpy as np
from fastembed import TextEmbedding

MODEL = sys.argv[1] if len(sys.argv) > 1 else "BAAI/bge-small-en-v1.5"
# bge v1.5: queries get this instruction, passages don't
PREFIX = "Represent this sentence for searching relevant passages: " if "bge" in MODEL.lower() else ""

model = TextEmbedding(MODEL)
print(json.dumps({"ready": True, "model": MODEL}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
        v = np.array(next(iter(model.embed([PREFIX + req["text"]]))), dtype=np.float32)
        v /= np.linalg.norm(v) + 1e-12
        print(json.dumps({"id": req.get("id"), "v": [round(float(x), 6) for x in v]}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"id": (req or {}).get("id") if isinstance(locals().get("req"), dict) else None, "error": repr(e)}), flush=True)
