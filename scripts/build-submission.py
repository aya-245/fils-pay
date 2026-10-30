#!/usr/bin/env python3
"""Assemble the submission document in the organisers' required order.

    python3 scripts/build-submission.py          # writes docs/Hackademics_FilsPay_Submission.md
    node scripts/md-to-pdf.mjs docs/Hackademics_FilsPay_Submission.md Hackademics_FilsPay_Submission.pdf

Sections (FilsPay Submission Guidelines §2): cover page, 1 Summary, 2 Architecture and
deployment (docs/submission/00-front.md), 3 Capacity (docs/CAPACITY.md), 4 Findings report
(docs/FINDINGS.md), 5 UI and UX changes (docs/UI_UX.md + docs/ui/DEMO.md), 6 AI usage
(docs/AI_USAGE.md), Appendix (security review, existing-data checks, test results).
Each included document loses its own H1 and is demoted one level so it nests under the
section heading; lines inside fenced code blocks are never touched.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "Hackademics_FilsPay_Submission.md"


def demote(text: str, levels: int = 1) -> str:
    out, fenced, dropped_h1 = [], False, False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append(line)
            continue
        if not fenced and re.match(r"^#\s", line) and not dropped_h1:
            dropped_h1 = True  # the section heading replaces the document title
            continue
        if not fenced and re.match(r"^#{1,5}\s", line):
            line = "#" * levels + line
        out.append(line)
    return "\n".join(out).strip() + "\n"


def rel_images(text: str, src: pathlib.Path) -> str:
    """Rewrite relative image paths so they resolve from docs/ (where OUT lives)."""
    base = src.parent.relative_to(DOCS) if src.parent != DOCS else pathlib.Path(".")

    def fix(m: re.Match) -> str:
        path = m.group(2)
        if re.match(r"^(https?:|/|data:)", path):
            return m.group(0)
        return f"{m.group(1)}{(base / path).as_posix()})"

    return re.sub(r"(!\[[^\]]*\]\()([^)]+)\)", fix, text)


def section(title: str, *files: str, page_break: bool = True) -> str:
    parts = [f'<h2 class="page">{title}</h2>' if page_break else f"## {title}", ""]
    for f in files:
        p = DOCS / f
        parts.append(rel_images(demote(p.read_text()), p))
        parts.append("")
    return "\n".join(parts)


def main() -> None:
    front = (DOCS / "submission" / "00-front.md").read_text()
    appendix_tests = (DOCS / "submission" / "90-appendix-tests.md")
    body = [
        front.strip(),
        "",
        section("3. Capacity", "CAPACITY.md"),
        section("4. Findings report", "FINDINGS.md"),
        section("5. UI and UX changes", "UI_UX.md", "ui/DEMO.md"),
        section("6. AI usage", "AI_USAGE.md"),
        '<h2 class="page">Appendix</h2>',
        "",
        "### A. Security review",
        "",
        demote(demote((DOCS / "SECURITY_REVIEW.md").read_text())),
        "### B. Test results and existing-data checks",
        "",
        demote(appendix_tests.read_text()) if appendix_tests.exists() else "",
    ]
    OUT.write_text("\n".join(body))
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
