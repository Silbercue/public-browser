A developer wants an automated regression test for a web app that runs at {{APP_URL}}. Use {{TOOL_NAME}} to look at the app.
Test accounts: {{ACCOUNTS}}

Turn this flow into a test that runs without AI: "{{FLOW}}"
Use any tool you like: Playwright Test (@playwright/test is installed), a shell script, Python with the publicbrowser package, or your browser CLI. Put all test files into {{TEST_DIR}} and write the one shell command that runs the test into {{TEST_DIR}}/RUN. Each run of the command works in a fresh copy of {{TEST_DIR}} as its working directory (files a run writes are not kept for the next run) and gets the app address in the environment variable APP_URL; do not hard-code the address. Every run starts a fresh copy of the app, so the test must log in by itself. Exit code 0 means the flow works, any other exit code means it is broken. Your test will later also run against other builds of the app.
Only create or edit files inside the session folder {{SESSION_DIR}}; writing anywhere else ends the session.
Do not read the app's source code or script files; your test may use the app only through the browser and its web address.

You may run the command `run-my-test` (no arguments) as often as you like; it runs your test against the app and prints the exit code and output. No other shell commands are available.
Budget: about {{BUDGET}} tool calls.
