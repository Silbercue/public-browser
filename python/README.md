# SilbercueChrome — Python Script API

Minimal CDP client for Chrome browser automation. Control Chrome from Python via the DevTools Protocol with **websockets** as the only dependency.

## Installation

```bash
pip install silbercuechrome
```

Or copy the single file `silbercuechrome.py` into your project (requires `websockets`).

## Prerequisites

Chrome must be running with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# If SilbercueChrome MCP server is running with --script flag,
# port 9222 is already available for Script API use.
```

## Quick Start

```python
from silbercuechrome import Chrome

chrome = Chrome.connect(port=9222)

with chrome.new_page() as page:
    page.navigate("https://example.com")
    title = page.evaluate("document.title")
    print(title)  # "Example Domain"

chrome.close()
```

## Login and Data Extraction

```python
from silbercuechrome import Chrome

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
| `Chrome.connect(host="localhost", port=9222)` | Connect to a running Chrome instance |
| `chrome.new_page(url="about:blank")` | Context manager: open a new tab, auto-closes on exit |
| `chrome.close()` | Close the CDP connection (does not close Chrome) |

### `Page` (via `chrome.new_page()`)

| Method | Description |
|---|---|
| `page.navigate(url)` | Navigate to URL and wait for load |
| `page.click(selector)` | Click element by CSS selector |
| `page.type(selector, text)` | Type text into input element |
| `page.fill({"sel": "val", ...})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for JS condition or `"text=..."` shorthand |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download(download_path=None)` | Enable downloads, return download dir |
| `page.close()` | Close the tab (auto-called by context manager) |

### `CdpClient` (low-level)

For advanced use cases requiring direct CDP access:

```python
from silbercuechrome import CdpClient

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

When the SilbercueChrome MCP server runs with the `--script` flag, the Python Script API can connect to the same Chrome instance. Each script works in its own tab — MCP tabs are never touched.

## License

MIT
