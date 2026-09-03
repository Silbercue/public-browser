# Contributing to Public Browser

Thanks for taking the time to contribute. Public Browser is MIT-licensed and open to
issues and pull requests.

## Development setup

```bash
git clone https://github.com/Silbercue/public-browser.git
cd public-browser
npm install
npm run build      # tsc -> build/
npm test           # vitest run
npm run lint       # eslint
```

The Python Script API lives in `python/`:

```bash
cd python
python -m pip install -e ".[dev]"
ruff check .
python -m pytest
```

Both suites run in CI on Node 20/22/24 and Python 3.10–3.13. A pull request is expected
to be green there.

## Running the server locally

`node build/index.js` starts the MCP server on stdio. It connects to a Chrome instance
over the Chrome DevTools Protocol; start Chrome with `--remote-debugging-port=9222` if
you want to attach to an existing browser.

If your MCP client launches the published package via `npx public-browser@latest`, use
`npm run dev` to point that cache at your local build (`npm run dev:off` restores it,
`npm run dev:status` shows which mode is active).

## Pull requests

- Keep changes focused; one topic per pull request.
- Add or update tests for behaviour changes — the project is test-driven and ships with
  a large unit suite.
- Run `npm run lint`, `npm test` and `npm run pack:check` before pushing.
- Describe what changed and why. Link the issue if there is one.

## Reporting bugs

Open an issue using the bug report template. A minimal reproduction — the page, the tool
call and the observed versus expected result — is worth more than a long description.

For security issues please do not open a public issue; see [SECURITY.md](SECURITY.md).
