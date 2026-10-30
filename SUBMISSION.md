# Hackademics — FilsPay submission

The submission document is **`docs/Hackademics_FilsPay_Submission.md`**, rendered as
`Hackademics_FilsPay_Submission.pdf`. It follows the organisers' required structure:

1. cover page;
2. Summary;
3. Architecture and deployment;
4. Capacity;
5. Findings report;
6. UI and UX changes;
7. AI usage;
8. Appendix.

The slide deck is `docs/deck/filspay.md`, rendered as `Hackademics_FilsPay_Slides.pdf`.

| Live | URL |
|---|---|
| Checkout + merchant dashboard | https://168-144-92-39.sslip.io (`/pay/<token>`, `/dashboard`) |
| Admin console | https://admin.168-144-92-39.sslip.io |
| Public API | https://api.168-144-92-39.sslip.io |

Rebuild the documents:
```bash
python3 scripts/build-submission.py
node scripts/md-to-pdf.mjs docs/Hackademics_FilsPay_Submission.md Hackademics_FilsPay_Submission.pdf   # needs marked + playwright
docker run --rm -v "$PWD/docs:/home/marp/app" marpteam/marp-cli:v4.1.2 deck/filspay.md --pdf --allow-local-files -o deck/Hackademics_FilsPay_Slides.pdf
```

Sources:

| What | Where |
|---|---|
| Findings, full format | `docs/FINDINGS.md` |
| Findings, short list | `BUGS.md` |
| Finding index | `AUDIT_REPORT.md` |
| Capacity | `docs/CAPACITY.md` |
| Security review | `docs/SECURITY_REVIEW.md` |
| UI before/after | `docs/UI_UX.md` |
| Demo script | `docs/ui/DEMO.md` |
| AI usage | `docs/AI_USAGE.md` |
| AI setup | `.claude/`, `CLAUDE.md`, `AGENTS.md`, `ai/` |
| Defence Q&A | `docs/DEFENCE.md` |
