#!/usr/bin/env python3
"""Generate the September 2026 README benchmark chart as light/dark SVG.

Run:  python3 scripts/make-benchmark-chart-2026-09.py
Out:  .github/assets/benchmark-2026-09-light.svg
      .github/assets/benchmark-2026-09-dark.svg

The April chart (scripts/make-benchmark-chart.py -> benchmark-light/dark.svg) is
kept as-is for the historical section of the README. Do not overwrite it here.

Design notes, so the next person does not have to re-derive them:

* ONE scale, ONE series: every bar is Public Browser as a share of Playwright MCP
  0.0.80 on the same metric, paired run against run (run 1 vs run 5, run 2 vs
  run 6). The vertical rule at 100% IS Playwright. Shorter is better.
* The April chart could draw Playwright as a full-width track because Public
  Browser was under it on every row. In September it is not: response sizes go
  the other way. So the axis runs 0-200% and bars are free to cross the rule.
  The part of a bar ABOVE the rule is BROKEN INTO SEGMENTS, not recoloured - one
  hue stays one hue, and "not solid any more" is the secondary encoding that says
  "worse" without borrowing a status colour.
  Two earlier attempts were dropped because these files get rendered outside
  browsers too: an SVG <pattern> hatch (ImageMagick draws it as a black block)
  and a hollow outline (ImageMagick drops fill="none" strokes entirely). Filled
  rectangles are the only primitive every renderer agrees on - so that is all
  this chart uses.
* Factor labels are pooled over both runs (sum vs sum), which is how README.md
  states them, so chart and prose cannot drift. The two bars per row still show
  the run-to-run spread.
* NO per-bar numbers: eight direct labels would be noise. The absolute values for
  both sides sit in the row sublabel instead.
* Palette is the one from the April chart (shared with SilbercueSwift), single
  series, validated in both modes.

Numbers below are read from test-hardest/results/*.json (tool_efficiency and
summary.duration_s of the seven September runs). Do not edit them here without
re-checking the raw JSON first.
"""

from pathlib import Path

W = 880
MARGIN = 24
LABEL_W = 234
PLOT_X = MARGIN + LABEL_W
PLOT_W = 396  # = 200% of Playwright; the 100% rule sits at PLOT_X + PLOT_W/2
RULE_X = PLOT_X + PLOT_W / 2
FACTOR_X = W - MARGIN  # factor label, right-aligned

ROW_H = 66
BAR_H = 13
BAR_GAP = 2  # surface gap between the two run bars
SCALE_MAX = 2.0  # 200%
SEG_W = 9    # segment length past the rule
SEG_GAP = 4  # gap between those segments

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

# label, sublabel, (pb_run1, pb_run2), (pw_run5, pw_run6), pooled factor text
# Session tokens = tokens.delta (input + output + cache writes + cache reads over the
# whole Claude Code session); cost = cost_usd_list, the Opus 5 list price of that run.
ROWS = [
    ("Session tokens", "6.3M · 6.5M vs 8.8M · 9.6M (whole run)",
     (6288593, 6518119), (8783693, 9592264), "30% fewer"),
    ("Cost per run", "$3.41 · $3.35 vs $4.28 · $4.78 (list price)",
     (3.41, 3.35), (4.28, 4.78), "25% less"),
    ("Tool calls", "84 · 86 vs 137 · 151",
     (84, 86), (137, 151), "41% fewer"),
    ("Time to finish", "281s · 296s vs 468s · 493s (page timer)",
     (281, 296), (468, 493), "40% less"),
    ("Avg response size", "1,298 · 1,214 vs 740 · 656 chars",
     (1298, 1214), (740, 656), "80% larger"),
    ("Total response volume", "109k · 104k vs 101k · 99k chars",
     (109075, 104432), (101478, 99147), "6% more"),
]

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


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build(theme: dict) -> str:
    head_h = 128
    body_h = ROW_H * len(ROWS)
    foot_h = 74
    h = head_h + body_h + foot_h

    o = []
    a = o.append
    alt = (
        "September 2026 benchmark, 35-test page, 30 scored, driver model claude-opus-5. "
        "Each bar is Public Browser as a share of Playwright MCP 0.0.80 on the same "
        "metric; the vertical line is Playwright at 100 percent and shorter is better. "
        "Session tokens over the whole run: 6.3 and 6.5 million against 8.8 and 9.6 "
        "million, 30 percent fewer. Cost per run at list price: 3.41 and 3.35 dollars "
        "against 4.28 and 4.78, 25 percent less. "
        "Tool calls: 84 and 86 against 137 and 151, 41 percent fewer. Time to finish: "
        "281 and 296 seconds against 468 and 493, 40 percent less. Average response "
        "size: 1,298 and 1,214 chars against 740 and 656, 80 percent larger — Public "
        "Browser loses this one. Total response volume: 109k and 104k chars against "
        "101k and 99k, 6 percent more. Pass rate is a tie at 30 of 30 in all four runs."
    )
    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" '
      f'viewBox="0 0 {W} {h}" role="img" aria-label="{esc(alt)}">')
    a(f'<rect width="{W}" height="{h}" fill="{theme["surface"]}"/>')
    a(f'<g font-family="{FONT}">')

    # --- header ---
    a(f'<text x="{MARGIN}" y="34" font-size="18" font-weight="600" fill="{theme["ink"]}">'
      f'Fewer tokens, less time — not smaller responses</text>')
    a(f'<text x="{MARGIN}" y="57" font-size="12.5" fill="{theme["muted"]}">'
      f'Each bar is Public Browser as a share of Playwright MCP 0.0.80 on the same metric. '
      f'The line is Playwright; shorter is better.</text>')
    a(f'<text x="{MARGIN}" y="75" font-size="12.5" fill="{theme["muted"]}">'
      f'Where a bar breaks into segments it has run past Playwright — Public Browser is the more expensive one on that row.</text>')
    a(f'<text x="{MARGIN}" y="96" font-size="11" fill="{theme["faint"]}">'
      f'35-test page, 30 scored, driver model claude-opus-5, 2026-09-03. Two runs each, '
      f'paired: upper bar run 1, lower bar run 2.</text>')
    a(f'<text x="{MARGIN}" y="112" font-size="11" fill="{theme["faint"]}">'
      f'Percentages on the right pool both runs (sum against sum).</text>')

    body_top = head_h
    body_bottom = head_h + body_h - (ROW_H - (2 * BAR_H + BAR_GAP)) + 6

    # --- 100% rule (Playwright), behind the bars ---
    a(f'<line x1="{RULE_X}" y1="{body_top - 12}" x2="{RULE_X}" y2="{body_bottom}" '
      f'stroke="{theme["faint"]}" stroke-width="1"/>')
    a(f'<text x="{RULE_X}" y="{body_top - 18}" font-size="10.5" text-anchor="middle" '
      f'fill="{theme["faint"]}">Playwright MCP 0.0.80</text>')

    # --- rows ---
    for i, (label, sub, pb, pw, factor) in enumerate(ROWS):
        top = head_h + i * ROW_H

        a(f'<text x="{MARGIN}" y="{top + 11}" font-size="14" font-weight="600" '
          f'fill="{theme["ink"]}">{esc(label)}</text>')
        a(f'<text x="{MARGIN}" y="{top + 29}" font-size="11.5" fill="{theme["faint"]}">{esc(sub)}</text>')

        for j in range(2):
            share = pb[j] / pw[j]
            by = top + j * (BAR_H + BAR_GAP)
            full = min(share, SCALE_MAX) * (PLOT_W / SCALE_MAX)
            r = 4.0

            if share <= 1.0:
                a(f'<rect x="{PLOT_X}" y="{by}" width="{full:.1f}" height="{BAR_H}" rx="{r}" '
                  f'fill="{theme["accent"]}"/>')
                continue

            # up to the rule: solid, rounded on the left, square where it meets the rule
            x0, x1, y0, y1 = PLOT_X, RULE_X, by, by + BAR_H
            a(f'<path d="M{x0 + r} {y0} H{x1} V{y1} H{x0 + r} '
              f'A{r} {r} 0 0 1 {x0} {y1 - r} V{y0 + r} '
              f'A{r} {r} 0 0 1 {x0 + r} {y0} Z" fill="{theme["accent"]}"/>')
            # past the rule: same fill, broken into segments
            end = PLOT_X + full
            x = RULE_X + SEG_GAP
            while x < end - 1:
                w = min(SEG_W, end - x)
                a(f'<rect x="{x:.1f}" y="{by}" width="{w:.1f}" height="{BAR_H}" '
                  f'fill="{theme["accent"]}"/>')
                x += SEG_W + SEG_GAP

        # pooled factor, right-aligned, centred on the pair
        cy = top + BAR_H + BAR_GAP / 2 + 4
        a(f'<text x="{FACTOR_X}" y="{cy}" font-size="13" font-weight="700" '
          f'text-anchor="end" fill="{theme["ink"]}">{esc(factor)}</text>')

    # --- footer ---
    fy = head_h + body_h + 8
    a(f'<text x="{MARGIN}" y="{fy}" font-size="11" fill="{theme["faint"]}">'
      f'Session tokens are the Claude Code transcript total, mostly cached re-reads of the growing '
      f'conversation — fewer calls means fewer re-reads. Cost is the Opus 5 list price.</text>')
    a(f'<text x="{MARGIN}" y="{fy + 17}" font-size="11" fill="{theme["faint"]}">'
      f'P95 response size runs further against Public Browser than this chart shows: '
      f'6,077 and 6,479 chars against 3,617 and 1,587.</text>')
    a(f'<text x="{MARGIN}" y="{fy + 34}" font-size="11" fill="{theme["faint"]}">'
      f'Pass rate is a tie — 30/30 in all four runs. Raw run JSON: test-hardest/results/</text>')

    a("</g>")
    a("</svg>")
    return "\n".join(o) + "\n"


def main() -> None:
    out = Path(__file__).resolve().parent.parent / ".github" / "assets"
    out.mkdir(parents=True, exist_ok=True)
    for name, theme in THEMES.items():
        p = out / f"benchmark-2026-09-{name}.svg"
        p.write_text(build(theme), encoding="utf-8")
        print(f"wrote {p} ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
