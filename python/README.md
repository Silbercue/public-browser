# Public Browser — Python Script API

Python client for Public Browser automation. Scripts use the same tool implementations as the MCP server (Shared Core) — every improvement to `click`, `navigate`, `fill_form` etc. automatically benefits your scripts too. One codebase, one test suite (1600+ tests), two access paths.

## Installation

```bash
pip install publicbrowser
```

To install from a source checkout instead, run `python -m pip install ./python` from the repository root, or `python -m pip install .` from inside this `python/` directory. No manual Chrome launch is needed — `Chrome.connect()` starts everything automatically via a local `public-browser` binary or the `npx` fallback.

Dependencies: `websockets` (for the Escape Hatch / `CdpClient` low-level access). The main Shared Core API uses `urllib` (built-in).

## Quick Start

```python
from publicbrowser import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://example.com")
    title = page.evaluate("document.title")
    print(title)  # "Example Domain"

chrome.close()
```

`Chrome.connect()` auto-starts the Public Browser server as a subprocess, which in turn launches Chrome. When you call `chrome.close()`, the server subprocess is terminated.

## How it works

```
Python Script                        Escape Hatch (Power User)
    │                                    │
    ▼                                    ▼
HTTP POST /tool/{name}              WebSocket (CDP)
Port 9223                           Port 9222
    │                                    │
    ▼                                    │
Public Browser Server                    │
    │                                    │
    ▼                                    │
registry.executeTool()                   │
    │                                    │
    ▼                                    │
Tool Handler                             │
(click.ts, navigate.ts, ...)             │
    │                                    │
    ▼                                    ▼
Chrome ◄─────────── CDP ────────────────►
```

Your script sends HTTP requests to the Public Browser server on port 9223. The server executes the exact same tool handlers that the MCP server uses — selector resolution, Shadow DOM traversal, scroll-into-view, paint-order filtering, ambient context — all server-side.

## Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — asks `GET /health` on port 9223 and connects only if a Public Browser server answers and accepts the key; any other program on that port is reported, never used
2. **PATH binary** — finds `public-browser` in PATH (e.g. via Homebrew), starts it with `--script`
3. **npx fallback** — runs `npx -y public-browser@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/public-browser")` for custom setups

## Access key

The Script API only answers requests that carry its key (`Authorization: Bearer <key>`), so web pages and programs running under another user account cannot drive your browser through it. Programs running under your own user account can read the key file, just as they can read your browser profile — the key does not protect against them. You rarely see the key:

- When `Chrome.connect()` starts the server itself, it generates a key and hands it over in the `PUBLIC_BROWSER_SCRIPT_TOKEN` environment variable.
- A server started with `--script` (for example from your MCP config) generates its own key and writes it to `~/.public-browser/script-api-<port>.token`, readable only by your user. `Chrome.connect()` reads it from there.
- To use a key of your own, set `PUBLIC_BROWSER_SCRIPT_TOKEN` for both sides or pass `Chrome.connect(token=...)`.

Two scripts that call `Chrome.connect()` at the same moment while no server runs each start a server with their own key. One of them gets the port, the other gets a `PermissionError`. Connect once and open one page per task from that connection (`chrome.new_page()` can be called from several threads), or start the server beforehand with `public-browser --script`, so that every script reads the same key file.

Requests without the key get `401`. Requests from a browser (with an `Origin` header) or with a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` get `403` — that blocks web pages and DNS rebinding even if they guess the port.

**Upgrading:** the server and the `publicbrowser` Python client go together. `publicbrowser` 1.0.0 does not send the key, so against a newer server it reports `ConnectionError: Public Browser server not reachable` although the server runs. An MCP config with `npx -y public-browser@latest -- --script` picks up the new server on its next start — update `publicbrowser` at the same time (`pip install -U publicbrowser`).

## Login and Data Extraction

```python
from publicbrowser import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://app.example.com/login")

    # Fill login form
    page.fill({
        "#email": "user@example.com",
        "#password": "secret",
    })
    page.click("#submit")

    # Wait for dashboard
    page.wait_for("text=Dashboard")

    # Extract data
    data = page.evaluate("""
        Array.from(document.querySelectorAll('.item'))
            .map(el => ({ name: el.textContent, href: el.href }))
    """)
    print(data)

chrome.close()
```

## API Reference

### `Chrome`

| Method | Description |
|---|---|
| `Chrome.connect(host="localhost", port=9223, *, server_path=None, auto_start=True, profile=None, token=None)` | Connect to or auto-start the Public Browser server |
| `chrome.new_page()` | Context manager: open a new tab, auto-closes on exit |
| `chrome.close()` | Close the connection and terminate any auto-started server |

### `Page` (via `chrome.new_page()`)

| Method | Description |
|---|---|
| `page.navigate(url)` | Navigate to URL and wait for load |
| `page.click(selector)` | Click by CSS selector (must match exactly one element), visible text (`"text=Sign in"`) or ref (`"e12"`) |
| `page.type(selector, text)` | Type text into input element |
| `page.fill({"sel": "val", ...})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for page text (`"text=..."`), a ref, a CSS selector (`#`, `.`, `[`), `"network_idle"` or a JS condition |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download()` | Wait for pending downloads, return the download report (JSON or a notice) |
| `page.close()` | Close the tab (auto-called by context manager) |
| `page.cdp` | Escape Hatch — returns a `CdpEscapeHatch` for direct CDP access (see below) |

### Escape Hatch: `page.cdp.send()`

For use cases the high-level API doesn't cover — network interception, console log subscriptions, performance tracing, cookie management, PDF generation — you can drop down to raw CDP commands via `page.cdp.send()`:

```python
with chrome.new_page() as page:
    page.navigate("https://example.com")

    # Enable network tracking
    page.cdp.send("Network.enable")

    # Get all cookies
    cookies = page.cdp.send("Network.getAllCookies")

    # Performance tracing
    page.cdp.send("Tracing.start", {"categories": "-*,devtools.timeline"})

    # Register event handler
    page.cdp.on("Network.requestWillBeSent", lambda e: print(e["request"]["url"]))
```

The Escape Hatch communicates directly with Chrome via WebSocket (port 9222), bypassing the server entirely. It connects lazily on the first `send()` call and reuses the connection. Each page gets its own WebSocket routed to the correct tab. It needs Chrome's debugging port, so it is not available when the server drives a real profile (`--profile`), which runs without one: the server then returns `cdp_ws_url: null` plus a `cdp_ws_note`, and `page.cdp` raises `RuntimeError`.

| Method | Description |
|---|---|
| `page.cdp.send(method, params=None, *, timeout=30.0)` | Send a CDP command and return the result |
| `page.cdp.on(event, handler)` | Register a callback for a CDP event |
| `page.cdp.close()` | Close the WebSocket (auto-called when the page context manager exits) |

### `CdpClient` (low-level, legacy)

For direct CDP access without the Shared Core server. This is the v1 code path — it works, but does not benefit from server-side improvements. Use `page.cdp.send()` instead for most Escape Hatch use cases.

```python
from publicbrowser import CdpClient

# Async API
client = await CdpClient.connect(port=9222)
result = await client.send("Runtime.evaluate", {"expression": "1+1"})
await client.close()

# Sync API
client = CdpClient.connect_sync(port=9222)
result = client.send_sync("Runtime.evaluate", {"expression": "1+1"})
client.close_sync()
```

## MCP Coexistence

When the MCP server and Python scripts need to run at the same time, add `--script` to the MCP config. `Chrome.connect()` handles the rest — each script works in its own tab, MCP tabs are never touched.

**Claude Code:**
```bash
claude mcp add --scope user public-browser npx -y public-browser@latest -- --script
```

**Cursor / Cline (`mcp.json`):**
```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest", "--", "--script"]
    }
  }
}
```

## Legacy: Single-File Alternative

For quick prototyping, you can copy `publicbrowser_standalone.py` into your project. This uses the v1 code path (direct CDP via WebSocket) and does **not** benefit from server-side improvements. Use the local `publicbrowser` package for the full Shared Core experience.

## License

MIT
