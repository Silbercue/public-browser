#!/usr/bin/env python3
"""Generate the 2026-09-24 README benchmark chart (Public Browser 3.0 vs agent-browser
0.38.1) as light/dark SVG.

Run:  python3 scripts/make-benchmark-chart-2026-09-24.py
Out:  .github/assets/benchmark-2026-09-24-light.svg
      .github/assets/benchmark-2026-09-24-dark.svg

The earlier charts (make-benchmark-chart.py for April, make-benchmark-chart-2026-09.py
for Playwright MCP 0.0.80) stay as they are. Do not overwrite their SVGs here.

Design notes (same visual system as make-benchmark-chart-2026-09.py):

* ONE scale, ONE series, ONE bar per row: the bar is the Public Browser MEDIAN over
  its five runs as a share of the agent-browser median on the same metric. The runs
  are not paired, so there is no run-against-run bar. The vertical rule at 100% IS
  agent-browser. Shorter is better.
* Axis runs 0-200% so a bar can cross the rule. The part ABOVE the rule is BROKEN
  INTO SEGMENTS in the same hue - "not solid any more" says "worse" without a status
  colour.
* Renderer rules: filled rectangles/paths only, the 100% rule included (a stroked
  <line> comes out black in ImageMagick). No SVG <pattern> (ImageMagick draws it
  as a black block), no fill="none" + stroke outlines (ImageMagick drops them).
* No per-bar numbers; the absolute medians of both sides sit in the row sublabel, the
  percentage on the right.
* Palette and typography are the ones from the September chart, validated in both modes.

Numbers are NOT typed in here. They are read from the raw run JSON:
  Public Browser 3.0 - test-hardest/results-local/public-browser-run18..22.json
    (local build at commit 366c194; mcp_version there says 2.10.6, the package
    version before the 3.0 bump)
  agent-browser 0.38.1 - test-hardest/results/agent-browser-run4, 6, 7, 8, 10.json
    (driven through its CLI; run5 and run9 were aborted for a fairness violation and
    do not count, run1-3 ran on a different Claude Code version)
The script asserts that all ten runs share Claude Code version, Chrome version,
token dedup mode and an ok harness status, and that the Public Browser runs sit on
366c194; otherwise it stops.
"""

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TH = ROOT / "test-hardest"

PB_NAME = "Public Browser 3.0"  # the JSON says 2.10.6, see docstring
PB_FILES = [TH / "results-local" / f"public-browser-run{i}.json" for i in (18, 19, 20, 21, 22)]
AB_FILES = [TH / "results" / f"agent-browser-run{i}.json" for i in (4, 6, 7, 8, 10)]
AB_VERSION = "0.38.1"

EXPECT_CLAUDE_CODE = "2.1.281"
EXPECT_CHROME = "153.0.8010.53"
EXPECT_DEDUP = "message.id"
EXPECT_PB_HEAD = "366c194"

# What a failed test checks, for the pass line. Unknown ids are shown bare.
TEST_NOTES = {"T5.2": "a navigator.webdriver check"}

W = 880
MARGIN = 24
LABEL_W = 234
PLOT_X = MARGIN + LABEL_W
PLOT_W = 396  # = 200% of agent-browser; the 100% rule sits at PLOT_X + PLOT_W/2
RULE_X = PLOT_X + PLOT_W / 2
FACTOR_X = W - MARGIN

ROW_H = 54
BAR_H = 15
SCALE_MAX = 2.0
SEG_W = 9
SEG_GAP = 4

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

THEMES = {
    "light": {
        "surface": "#fcfcfb",
        "ink": "#0b0b0b",
        "muted": "#55544c",
        "faint": "#7a7972",
        "track": "#e4e4de",
        "accent": "#2a78d6",
    },
    "dark": {
        "surface": "#141413",
        "ink": "#ffffff",
        "muted": "#c3c2b7",
        "faint": "#8a8980",
        "track": "#302f2c",
        "accent": "#3987e5",
    },
}


def fail(msg: str) -> None:
    sys.exit(f"make-benchmark-chart-2026-09-24: {msg}")


def load(files: list, is_pb: bool) -> list:
    runs = []
    for f in files:
        if not f.exists():
            fail(f"missing run file {f}")
        d = json.loads(f.read_text(encoding="utf-8"))
        h = d["harness"]
        checks = [
            (h.get("claude_code_version") == EXPECT_CLAUDE_CODE,
             f"harness.claude_code_version={h.get('claude_code_version')!r}"),
            (d.get("chrome_version") == EXPECT_CHROME, f"chrome_version={d.get('chrome_version')!r}"),
            (d["tokens"].get("dedup") == EXPECT_DEDUP, f"tokens.dedup={d['tokens'].get('dedup')!r}"),
            (h.get("status") == "ok", f"harness.status={h.get('status')!r}"),
        ]
        if is_pb:
            checks.append((h.get("git_head") == EXPECT_PB_HEAD, f"harness.git_head={h.get('git_head')!r}"))
        else:
            checks.append((d.get("mcp_version") == AB_VERSION, f"mcp_version={d.get('mcp_version')!r}"))
        for ok, what in checks:
            if not ok:
                fail(f"{f.name}: unexpected {what}")
        runs.append(d)
    return runs


PB = load(PB_FILES, True)
AB = load(AB_FILES, False)
ALL = PB + AB
MODELS = {d["model"] for d in ALL}
if len(MODELS) != 1:
    fail(f"driver models differ: {MODELS}")
MODEL = MODELS.pop()
CHROME_MAJOR = EXPECT_CHROME.split(".")[0]
DATES = sorted({d["timestamp"][:10] for d in ALL})


def med(runs: list, path: str) -> float:
    vals = []
    for d in runs:
        v = d
        for k in path.split("."):
            v = v[k]
        vals.append(v)
    return statistics.median(vals)


def millions(v: float) -> str:
    return f"{v / 1e6:.2f}M"


def kilo(v: float) -> str:
    return f"{v / 1e3:.1f}k"


# label, sublabel template, JSON path, formatter, word if PB is below / above the rule
ROW_SPECS = [
    ("Session tokens", "{pb} vs {ab} (whole session)", "tokens.delta", millions, "fewer", "more"),
    ("Cost per run", "{pb} vs {ab} (list price)", "cost_usd_list", lambda v: f"${v:.2f}", "less", "more"),
    ("Tool calls", "{pb} vs {ab}", "tool_efficiency.calls_total", lambda v: f"{v:,.0f}", "fewer", "more"),
    ("Time to finish", "{pb} vs {ab} (wall clock)", "harness.wall_clock_s", lambda v: f"{v:.0f} s", "less", "more"),
    ("Total response volume", "{pb} vs {ab} chars", "tool_efficiency.response_chars_total", kilo, "less", "more"),
    ("Avg response size", "{pb} vs {ab} chars", "tool_efficiency.avg_response_chars",
     lambda v: f"{v:,.0f}", "smaller", "larger"),
]

ROWS = []
for label, sub, path, fmt, better, worse in ROW_SPECS:
    pb, ab = med(PB, path), med(AB, path)
    share = pb / ab
    pct = round(abs(1 - share) * 100)
    factor = f"{pct}% {better if share <= 1 else worse}"
    ROWS.append({"label": label, "sub": sub.format(pb=fmt(pb), ab=fmt(ab)), "pb": pb, "ab": ab,
                 "pb_s": fmt(pb), "ab_s": fmt(ab), "share": share, "factor": factor,
                 "loses": share > 1})


def pass_text(runs: list) -> tuple:
    scores = [(d["summary"]["passed"], d["summary"]["counted"]) for d in runs]
    if len(set(scores)) == 1:
        p, c = scores[0]
        text = f"{p}/{c} in all {len(runs)} runs"
    else:
        text = " · ".join(f"{p}/{c}" for p, c in scores)
    misses = {}
    for d in runs:
        excluded = set(d["suite"]["excluded"])
        for tid, t in d["tests"].items():
            if tid not in excluded and t["status"] != "pass":
                misses[tid] = misses.get(tid, 0) + 1
    return text, misses


PB_PASS, PB_MISS = pass_text(PB)
AB_PASS, AB_MISS = pass_text(AB)


def miss_text(name: str, misses: dict, n: int) -> str:
    parts = []
    for tid in sorted(misses):
        note = f", {TEST_NOTES[tid]}" if tid in TEST_NOTES else ""
        count = "" if misses[tid] == n else f" in {misses[tid]} of {n} runs"
        parts.append(f"{tid}{note}{count}")
    return f"{name} misses " + "; ".join(parts)


notes = []
if PB_MISS:
    notes.append(miss_text("Public Browser", PB_MISS, len(PB)))
if AB_MISS:
    notes.append(miss_text("agent-browser", AB_MISS, len(AB)))
PASS_LINE = f"Passed: {PB_PASS} vs {AB_PASS}" + (f" ({'; '.join(notes)})" if notes else "")

SUITE = PB[0]["suite"]
FOOT_LINE = (f"{'/'.join([DATES[0]] + [x[8:] for x in DATES[1:]])} · Claude Code {EXPECT_CLAUDE_CODE} · "
             f"driver {MODEL} · Chrome {CHROME_MAJOR} · agent-browser driven through its CLI · "
             f"shorter is better")


def alt_text() -> str:
    parts = [
        f"{PB_NAME} against agent-browser {AB_VERSION}, blind benchmark, {SUITE['scorable']} scored "
        f"tests, median of {len(PB)} runs each, driver model {MODEL}. Each bar is the Public "
        f"Browser median as a share of the agent-browser median on the same metric; the vertical "
        f"line is agent-browser at 100 percent and shorter is better."
    ]
    for r in ROWS:
        s = f"{r['label']}: {r['pb_s']} against {r['ab_s']}, {r['factor'].replace('%', ' percent')}"
        if r["loses"]:
            s += " — Public Browser loses this one"
        parts.append(s + ".")
    parts.append(PASS_LINE.replace("Passed:", "Passed").replace(" vs ", " against ") + ".")
    return " ".join(parts)


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def build(theme: dict) -> str:
    head_h = 132
    body_h = ROW_H * len(ROWS)
    foot_h = 92
    h = head_h + body_h + foot_h

    o = []
    a = o.append
    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" '
      f'viewBox="0 0 {W} {h}" role="img" aria-label="{esc(alt_text())}">')
    a(f'<rect width="{W}" height="{h}" fill="{theme["surface"]}"/>')
    a(f'<g font-family="{FONT}">')

    a(f'<text x="{MARGIN}" y="34" font-size="18" font-weight="600" fill="{theme["ink"]}">'
      f'{esc(PB_NAME)} vs agent-browser {AB_VERSION}</text>')
    a(f'<text x="{MARGIN}" y="57" font-size="12.5" fill="{theme["muted"]}">'
      f'Blind benchmark, {SUITE["scorable"]} scored tests, median of {len(PB)} runs each. Each bar is the '
      f'Public Browser median as a share of agent-browser&#8217;s.</text>')
    a(f'<text x="{MARGIN}" y="75" font-size="12.5" fill="{theme["muted"]}">'
      f'The line is agent-browser; shorter is better. Where a bar breaks into segments, Public Browser '
      f'is the more expensive one.</text>')
    a(f'<text x="{MARGIN}" y="96" font-size="11" fill="{theme["faint"]}">'
      f'Runs are not paired: {len(PB)} runs per side, one bar per metric, median against median.</text>')

    body_top = head_h
    body_bottom = head_h + body_h - (ROW_H - BAR_H) + 6

    # the rule is a 1px filled rect, not a <line>: ImageMagick paints stroked lines black
    a(f'<rect x="{RULE_X - 0.5}" y="{body_top - 12}" width="1" height="{body_bottom - body_top + 12}" '
      f'fill="{theme["faint"]}"/>')
    a(f'<text x="{RULE_X}" y="{body_top - 18}" font-size="10.5" text-anchor="middle" '
      f'fill="{theme["faint"]}">agent-browser {AB_VERSION}</text>')

    r = 4.0
    for i, row in enumerate(ROWS):
        top = head_h + i * ROW_H
        a(f'<text x="{MARGIN}" y="{top + 11}" font-size="14" font-weight="600" '
          f'fill="{theme["ink"]}">{esc(row["label"])}</text>')
        a(f'<text x="{MARGIN}" y="{top + 29}" font-size="11.5" fill="{theme["faint"]}">{esc(row["sub"])}</text>')

        share = row["share"]
        by = top
        full = min(share, SCALE_MAX) * (PLOT_W / SCALE_MAX)
        if share <= 1.0:
            a(f'<rect x="{PLOT_X}" y="{by}" width="{full:.1f}" height="{BAR_H}" rx="{r}" '
              f'fill="{theme["accent"]}"/>')
        else:
            x0, x1, y0, y1 = PLOT_X, RULE_X, by, by + BAR_H
            a(f'<path d="M{x0 + r} {y0} H{x1} V{y1} H{x0 + r} '
              f'A{r} {r} 0 0 1 {x0} {y1 - r} V{y0 + r} '
              f'A{r} {r} 0 0 1 {x0 + r} {y0} Z" fill="{theme["accent"]}"/>')
            end = PLOT_X + full
            x = RULE_X + SEG_GAP
            while x < end - 1:
                w = min(SEG_W, end - x)
                a(f'<rect x="{x:.1f}" y="{by}" width="{w:.1f}" height="{BAR_H}" '
                  f'fill="{theme["accent"]}"/>')
                x += SEG_W + SEG_GAP

        a(f'<text x="{FACTOR_X}" y="{top + BAR_H / 2 + 4.5}" font-size="13" font-weight="700" '
          f'text-anchor="end" fill="{theme["ink"]}">{esc(row["factor"])}</text>')

    fy = head_h + body_h + 10
    a(f'<text x="{MARGIN}" y="{fy}" font-size="13" font-weight="600" fill="{theme["ink"]}">'
      f'{esc(PASS_LINE)}</text>')
    a(f'<text x="{MARGIN}" y="{fy + 26}" font-size="11" fill="{theme["faint"]}">'
      f'Session tokens are the Claude Code transcript total, mostly cached re-reads of the growing '
      f'conversation. Cost is the Opus 5 list price.</text>')
    a(f'<text x="{MARGIN}" y="{fy + 43}" font-size="11" fill="{theme["faint"]}">{esc(FOOT_LINE)}</text>')
    a(f'<text x="{MARGIN}" y="{fy + 60}" font-size="11" fill="{theme["faint"]}">'
      f'Raw run JSON: test-hardest/results-local/ (Public Browser) and test-hardest/results/ '
      f'(agent-browser)</text>')

    a("</g>")
    a("</svg>")
    return "\n".join(o) + "\n"


def main() -> None:
    out = ROOT / ".github" / "assets"
    out.mkdir(parents=True, exist_ok=True)
    for name, theme in THEMES.items():
        p = out / f"benchmark-2026-09-24-{name}.svg"
        p.write_text(build(theme), encoding="utf-8")
        print(f"wrote {p} ({p.stat().st_size:,} bytes)")
    for row in ROWS:
        print(f"  {row['label']:<22} PB {row['pb_s']:>8}  AB {row['ab_s']:>8}  {row['share'] * 100:6.1f}%  {row['factor']}")
    print(f"  {PASS_LINE}")
    print(f"  alt: {alt_text()}")


if __name__ == "__main__":
    main()
