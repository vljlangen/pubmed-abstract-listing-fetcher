#!/usr/bin/env python3
"""
Build plain-text and a simple PDF from pubmed_abstracts.html (GitHub Actions helper).
Does not change pubmed_abstracts.js output; companions only.
"""
from __future__ import annotations

import html as html_module
import re
import sys
from pathlib import Path

DEJAVU = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def html_to_plain_text(html: str) -> str:
    s = re.sub(r"(?is)<script[^>]*>.*?</script>", "", html)
    s = re.sub(r"(?is)<style[^>]*>.*?</style>", "", s)
    s = re.sub(r"(?is)<br\s*/?>", "\n", s)
    s = re.sub(r"(?is)</p\s*>", "\n\n", s)
    s = re.sub(r"(?is)</div\s*>", "\n", s)
    s = re.sub(r"<[^>]+>", "\n", s)
    s = html_module.unescape(s)
    s = re.sub(r"\n[ \t]+\n", "\n\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip() + "\n"


def write_pdf_reportlab(text: str, dest: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    if DEJAVU.is_file():
        pdfmetrics.registerFont(TTFont("DejaVuSans", str(DEJAVU)))
        font_name = "DejaVuSans"
    else:
        font_name = "Helvetica"

    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        name="Body",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9,
        leading=11,
        spaceAfter=2,
    )

    story = []
    for line in text.splitlines():
        esc = (
            line.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        if not esc.strip():
            story.append(Spacer(1, 4))
        else:
            story.append(Paragraph(esc, body))

    doc = SimpleDocTemplate(
        str(dest),
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )
    doc.build(story)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: gh-artifacts-from-html.py <pubmed_abstracts.html>", file=sys.stderr)
        sys.exit(2)

    src = Path(sys.argv[1])
    if not src.is_file():
        print(f"Not found: {src}", file=sys.stderr)
        sys.exit(1)

    raw = src.read_text(encoding="utf-8", errors="replace")
    plain = html_to_plain_text(raw)
    txt_path = src.with_suffix(".txt")
    txt_path.write_text(plain, encoding="utf-8")

    pdf_path = src.with_suffix(".pdf")
    try:
        write_pdf_reportlab(plain, pdf_path)
    except ImportError as e:
        print(f"PDF skipped (reportlab not installed): {e}", file=sys.stderr)
        if pdf_path.exists():
            pdf_path.unlink()
    except Exception as err:
        print(f"PDF step failed (HTML and TXT still available): {err}", file=sys.stderr)
        if pdf_path.exists():
            pdf_path.unlink()


if __name__ == "__main__":
    main()
