You are benchmarking the browser automation MCP server "{{MCP_NAME}}". Work fully autonomously: do not ask questions, do not stop early, keep going until the export at the end is written.

Rules
- Use ONLY the tools of the "{{MCP_NAME}}" MCP server for anything that happens in the browser (navigating, reading the page, clicking, typing, running JavaScript). No other way of reaching the page is allowed.
- Open {{SUITE_URL}} once. Do not reload the page unless a test explicitly tells you to — every value on the page is randomized per page load, so never guess a value; read it.
- Work through the tests strictly in this order: T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T2.1, T2.2, T2.3, T2.4, T2.5, T2.6, T3.1, T3.2, T3.3, T3.4, T3.5, T3.6, T4.1, T4.2, T4.3, T4.4, T4.5, T4.6, T5.1, T5.2, T5.7, T5.8, T5.9, T5.10. The levels are tabs at the top of the page.
- Skip T4.7, T5.3, T5.4, T5.5 and T5.6 entirely (not applicable to this benchmark). Do not click anything inside those cards.
- For every test: read the instructions on its card, do what it asks, then check the status badge on that card (PASS or FAIL). If a test shows FAIL or nothing after three honest attempts, leave it and move on to the next one. Never fake a result.
- Some tests intentionally involve timing, hidden elements, shadow DOM, iframes, drag and drop, canvas, keyboard shortcuts, a second tab, cookies/localStorage, mutations and toasts. Solve them with the tools you have; if a dedicated tool is missing, running JavaScript in the page through the MCP server is fine.

Finish
1. When you are done with T5.10, open the "Results" tab on the page and click "Export as JSON". The page shows the JSON in a <pre> element.
2. Copy that JSON text exactly as shown (do not edit, reformat or summarize it) and write it with the Write tool to this absolute path: {{EXPORT_PATH}}
3. Then reply with exactly three lines: `passed: <n>`, `failed: <n>`, `skipped: <n>` (counting only tests you attempted, plus the five you skipped).
