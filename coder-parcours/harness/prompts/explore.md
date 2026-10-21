You are testing a web app for a developer. It runs at {{APP_URL}}. Use {{TOOL_NAME}} to control the browser.
Test accounts: {{ACCOUNTS}}

Part 1 — check a change. The developer says: "{{CHANGE}}"
Find out whether this works. Decide "works" or "broken" and back it up with what you did and what you saw.

Part 2 — explore. Use the app the way real visitors would, at three screen widths: phone (390 px wide), tablet (768 px) and desktop (1440 px). You may use several tabs or windows at the same time. Report every problem you notice. Do not report things that work as intended. Do not read the app's source code or script files; judge only what you see and what the browser shows you.

Budget: about {{BUDGET}} tool calls. Write the report early and overwrite it after every new finding, so nothing is lost if you run out of budget.
Only the report file below counts. You may keep screenshots or notes of your own, but they are not read.
Report file: {{REPORT_PATH}} (JSON, exactly this shape):
{"change_check":{"verdict":"works|broken","evidence":"..."},"findings":[{"title":"...","where":"page or area","viewport":"phone|tablet|desktop|all","steps":"...","expected":"...","actual":"...","severity":"low|medium|high"}]}
