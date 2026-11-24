"""Render one PDF page to WebP (full size + thumbnail). Called by the server on demand.

    python -I ingest/render_page.py <pdf> <page 1-based> <out_full.webp> <out_thumb.webp>

Uses pypdfium2 (Apache-2.0/BSD, installed with pdfplumber) and Pillow.
"""
import os
import sys

import pypdfium2 as pdfium

FULL_LONG_SIDE = 2200   # px: enough to read wiring-diagram labels when zoomed
THUMB_LONG_SIDE = 520


def main():
    pdf, n, out_full, out_thumb = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    doc = pdfium.PdfDocument(pdf)
    try:
        if not 1 <= n <= len(doc):
            sys.exit(f"page {n} out of range 1..{len(doc)}")
        page = doc[n - 1]
        w, h = page.get_size()  # points
        scale = min(FULL_LONG_SIDE / max(w, h), 4.0)
        img = page.render(scale=scale).to_pil().convert("RGB")
    finally:
        doc.close()
    for out, side, q in ((out_full, None, 82), (out_thumb, THUMB_LONG_SIDE, 72)):
        im = img
        if side:
            im = img.copy()
            im.thumbnail((side, side))
        tmp = out + ".tmp"
        im.save(tmp, "WEBP", quality=q, method=4)
        os.replace(tmp, out)


if __name__ == "__main__":
    main()
