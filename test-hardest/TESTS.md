# Test Hardest

Browser automation benchmark suite for SilbercueChrome MCP development.

**Setup → see [CLAUDE.md](../CLAUDE.md)**

## Run

```bash
python3 -m http.server 4242
# open http://localhost:4242
```

## Test Matrix

| ID   | Level        | Challenge                         | Key Difficulty                       |
|------|--------------|-----------------------------------|--------------------------------------|
| T1.1 | Basics       | Click button                      | Baseline                             |
| T1.2 | Basics       | Read text, re-enter it            | Element read + input                 |
| T1.3 | Basics       | Fill complete form                | 6 field types incl. checkbox/select  |
| T1.4 | Basics       | 5 selector strategies             | ID / class / data-attr / aria / text |
| T1.5 | Basics       | Click sequence, verify order      | State tracking across clicks         |
| T1.6 | Basics       | Sum table column                  | DOM traversal + arithmetic           |
| T2.1 | Intermediate | Async content (2s delay)          | Wait-for-element pattern             |
| T2.2 | Intermediate | Infinite scroll to item 30        | IntersectionObserver trigger         |
| T2.3 | Intermediate | 3-step wizard                     | Multi-step state, back/forward       |
| T2.4 | Intermediate | Searchable dropdown               | Filter + mousedown select            |
| T2.5 | Intermediate | Tab switch, read, return          | Multi-tab coordination               |
| T2.6 | Intermediate | Sort table, find max value        | Dynamic DOM reorder                  |
| T3.1 | Advanced     | Shadow DOM read + click           | Shadow root pierce                   |
| T3.2 | Advanced     | Nested iframe (2 levels deep)     | Frame context switching              |
| T3.3 | Advanced     | Drag & drop reorder (5 items)     | Drag events sequence                 |
| T3.4 | Advanced     | Canvas click (random position)    | Coordinate math, no DOM selector     |
| T3.5 | Advanced     | Keyboard shortcut sequence        | Ctrl+K -> Esc -> Enter               |
| T3.6 | Advanced     | contenteditable rich text         | Bold detection via DOM               |
| T4.1 | Hardest      | Element appears after 1-5s       | Unpredictable timing                 |
| T4.2 | Hardest      | Capture counter at exact value 7  | 500ms race, precise timing           |
| T4.3 | Hardest      | Find needle in 10K-element DOM    | Token pressure, querySelector        |
| T4.4 | Hardest      | localStorage + cookie chain       | JS state manipulation across APIs    |
| T4.5 | Hardest      | Observe 3 sequential mutations    | Mutation tracking across time        |
| T4.6 | Hardest      | Modal form -> token generation    | Multi-modal chain, derived value     |

## Adding Tests

1. Add a test card to the relevant level section in `index.html`
2. Implement the handler in `const Tests = { ... }`
3. Call `Benchmark.setResult(id, el, pass, msg)` — framework handles the rest

## Scoring / JSON Export

Use the Results tab to export:

```json
{
  "timestamp": "...",
  "elapsed_s": 42,
  "summary": { "total": 22, "passed": 20, "failed": 2 },
  "tests": {
    "T1.1": { "status": "pass", "duration_ms": 312, "details": "..." }
  }
}
```

Use this output to compare SilbercueChrome against Playwright MCP, claude-in-chrome, and browser-use.
