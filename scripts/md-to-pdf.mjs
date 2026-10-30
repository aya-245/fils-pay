#!/usr/bin/env node
// Render a Markdown document to a print-quality PDF (A4) with headless Chromium.
//   node scripts/md-to-pdf.mjs <input.md> <output.pdf>
// Relative image paths resolve against the input file's directory.
// Needs the `marked` and `playwright` packages (see docs/SUBMISSION_BUILD.md).
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { marked } from "marked";
import { chromium } from "playwright";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: md-to-pdf.mjs <input.md> <output.pdf>");
  process.exit(2);
}
const inPath = resolve(input);
const md = readFileSync(inPath, "utf8");
const body = marked.parse(md, { gfm: true });

const css = `
  @page { size: A4; margin: 16mm 14mm 18mm; }
  body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1b1f24; }
  h1 { color: #0b5c4a; font-size: 22pt; margin: 0 0 6pt; }
  h2 { color: #0b5c4a; font-size: 15pt; border-bottom: 2px solid #0b5c4a; padding-bottom: 3pt; margin-top: 18pt; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; page-break-after: avoid; }
  h2.page { page-break-before: always; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #cfd8d4; padding: 3pt 5pt; vertical-align: top; text-align: left; }
  th { background: #0b5c4a; color: #fff; }
  tr:nth-child(even) td { background: #f5f8f7; }
  code { font-family: "JetBrains Mono", Consolas, monospace; font-size: 8.8pt; background: #eef4f2; padding: 0 2pt; border-radius: 2pt; }
  pre { background: #f3f6f5; border: 1px solid #d9e2de; padding: 6pt 8pt; font-size: 8.3pt; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; border: 1px solid #d9e2de; }
  blockquote { border-left: 3px solid #0b5c4a; margin: 6pt 0; padding: 2pt 10pt; color: #44515a; }
  a { color: #0b5c4a; }
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${basename(inPath)}</title><style>${css}</style></head><body>${body}</body></html>`;

// Write next to the input so relative <img src> resolve.
const tmpHtml = resolve(dirname(inPath), `.${basename(inPath)}.render.html`);
writeFileSync(tmpHtml, html);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`file://${tmpHtml}`, { waitUntil: "load" });
  await page.pdf({
    path: resolve(output),
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#888">FilsPay submission · <span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
    margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" },
  });
} finally {
  await browser.close();
  unlinkSync(tmpHtml);
}
console.log(`wrote ${output}`);
