"""SilbercueChrome — Single-file CDP client for Chrome browser automation.

Copy this file into your project for zero-install browser automation.
Only requires ``websockets`` (pip install websockets).

Usage::

    from silbercuechrome import Chrome

    chrome = Chrome.connect(port=9222)
    with chrome.new_page() as page:
        page.navigate("https://example.com")
        title = page.evaluate("document.title")
        print(title)
    chrome.close()
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Generator
from urllib.request import urlopen

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

__version__ = "1.0.0"

# Default timeout for CDP commands (seconds)
DEFAULT_TIMEOUT = 30.0

# Default polling interval for wait_for (seconds)
_POLL_INTERVAL = 0.1
# Default wait_for timeout (seconds)
_WAIT_TIMEOUT = 30.0
# Default download directory
_DOWNLOAD_DIR = os.path.join(tempfile.gettempdir(), "silbercuechrome-downloads")


# ---------------------------------------------------------------------------
# CdpError
# ---------------------------------------------------------------------------


class CdpError(Exception):
    """Raised when a CDP command returns an error response."""

    def __init__(
        self, code: int, message: str, data: Any = None, method: str | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.data = data
        self.method = method
        if method:
            super().__init__(f"{method} failed: CDP error {code}: {message}")
        else:
            super().__init__(f"CDP error {code}: {message}")


# ---------------------------------------------------------------------------
# CdpClient
# ---------------------------------------------------------------------------


class CdpClient:
    """Minimal async CDP client over WebSocket.

    Handles request/response matching and event dispatching.
    Use ``CdpClient.connect()`` to create a connected instance.
    """

    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._ws: Any = None
        self._counter = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._event_handlers: dict[str, list[Callable[[dict[str, Any]], None]]] = {}
        self._listener_task: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    async def connect(
        cls,
        host: str = "localhost",
        port: int = 9222,
        *,
        target_id: str | None = None,
        ws_url: str | None = None,
    ) -> CdpClient:
        """Connect to a Chrome instance via CDP.

        Args:
            host: Chrome host (default: localhost).
            port: Chrome debugging port (default: 9222).
            target_id: Connect to a specific target (tab). If None, connects
                to the browser-level endpoint.
            ws_url: Direct WebSocket URL. If provided, host/port/target_id
                are ignored.

        Returns:
            A connected CdpClient instance.

        Raises:
            ConnectionError: If Chrome is not reachable.
        """
        if ws_url is None:
            if target_id is not None:
                ws_url = f"ws://{host}:{port}/devtools/page/{target_id}"
            else:
                ws_url = cls._discover_browser_ws(host, port)

        client = cls(ws_url)
        await client._connect()
        return client

    @staticmethod
    def _discover_browser_ws(host: str, port: int) -> str:
        """Discover the browser WebSocket URL via the /json/version endpoint."""
        url = f"http://{host}:{port}/json/version"
        try:
            with urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read())
                ws_url = data.get("webSocketDebuggerUrl")
                if not ws_url:
                    raise ConnectionError(
                        f"No webSocketDebuggerUrl in /json/version response from {url}"
                    )
                return ws_url
        except ConnectionError:
            raise
        except OSError as exc:
            raise ConnectionError(
                f"Cannot reach Chrome at {url}. Is Chrome running with "
                f"--remote-debugging-port={port}?"
            ) from exc

    async def _connect(self) -> None:
        """Establish WebSocket connection and start listener."""
        try:
            self._connect_cm = connect(
                self._ws_url,
                ping_interval=None,
                max_size=64 * 1024 * 1024,
            )
            self._ws = await self._connect_cm.__aenter__()
        except OSError as exc:
            raise ConnectionError(
                f"WebSocket connection failed to {self._ws_url}: {exc}"
            ) from exc

        self._closed = False
        self._listener_task = asyncio.create_task(self._listen())

    async def _listen(self) -> None:
        """Background listener that dispatches responses and events."""
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Received non-JSON message: %s", raw[:200])
                    continue

                if "id" in msg and msg["id"] in self._pending:
                    future = self._pending.pop(msg["id"])
                    if not future.done():
                        future.set_result(msg)
                    continue

                method = msg.get("method")
                if method and method in self._event_handlers:
                    params = msg.get("params", {})
                    for handler in self._event_handlers[method]:
                        try:
                            handler(params)
                        except Exception:
                            logger.exception(
                                "Error in event handler for %s", method
                            )
        except ConnectionClosed:
            logger.debug("WebSocket connection closed")
        except asyncio.CancelledError:
            conn_err = ConnectionError("WebSocket connection lost")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(conn_err)
            self._pending.clear()
            return
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.cancel()
            self._pending.clear()

    async def send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Send a CDP command and wait for the response.

        Args:
            method: CDP method name (e.g. "Runtime.evaluate").
            params: CDP method parameters.
            timeout: Maximum wait time in seconds.
            session_id: Optional CDP session ID for tab-specific commands.

        Returns:
            The ``result`` field from the CDP response.

        Raises:
            CdpError: If CDP returns an error response.
            asyncio.TimeoutError: If the response does not arrive in time.
            ConnectionError: If the WebSocket is not connected.
        """
        if self._closed or self._ws is None:
            raise ConnectionError("CdpClient is not connected")

        cmd_id = next(self._counter)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[cmd_id] = future

        message: dict[str, Any] = {"id": cmd_id, "method": method}
        if params:
            message["params"] = params
        if session_id is not None:
            message["sessionId"] = session_id

        try:
            await self._ws.send(json.dumps(message))
        except ConnectionClosed as exc:
            self._pending.pop(cmd_id, None)
            raise ConnectionError(f"WebSocket closed while sending: {exc}") from exc

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise

        if "error" in response:
            err = response["error"]
            raise CdpError(
                code=err.get("code", -1),
                message=err.get("message", "Unknown CDP error"),
                data=err.get("data"),
                method=method,
            )

        return response.get("result", {})

    def on(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        """Register an event handler for a CDP event."""
        self._event_handlers.setdefault(event, []).append(handler)

    def off(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        """Remove an event handler."""
        handlers = self._event_handlers.get(event, [])
        if handler in handlers:
            handlers.remove(handler)

    async def close(self) -> None:
        """Close the WebSocket connection and stop the listener."""
        self._closed = True

        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass

        if self._ws:
            await self._ws.close()
            self._ws = None

    # Synchronous API

    @classmethod
    def connect_sync(
        cls,
        host: str = "localhost",
        port: int = 9222,
        *,
        target_id: str | None = None,
        ws_url: str | None = None,
    ) -> CdpClient:
        """Synchronous version of :meth:`connect`."""
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()

        future = asyncio.run_coroutine_threadsafe(
            cls.connect(host, port, target_id=target_id, ws_url=ws_url), loop
        )
        client = future.result()
        client._sync_loop = loop
        client._sync_thread = thread
        return client

    def send_sync(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Synchronous version of :meth:`send`."""
        loop = getattr(self, "_sync_loop", None)
        if loop is None:
            raise RuntimeError(
                "No sync event loop. Use CdpClient.connect_sync() or call send() with await."
            )
        future = asyncio.run_coroutine_threadsafe(
            self.send(method, params, timeout=timeout, session_id=session_id), loop
        )
        return future.result(timeout=timeout + 1)

    def close_sync(self) -> None:
        """Synchronous version of :meth:`close`."""
        loop = getattr(self, "_sync_loop", None)
        if loop is None:
            raise RuntimeError(
                "No sync event loop. Use CdpClient.connect_sync() or call close() with await."
            )
        future = asyncio.run_coroutine_threadsafe(self.close(), loop)
        future.result(timeout=5)
        loop.call_soon_threadsafe(loop.stop)
        thread = getattr(self, "_sync_thread", None)
        if thread is not None:
            thread.join(timeout=5)

    @property
    def closed(self) -> bool:
        """Whether the client is closed."""
        return self._closed

    async def __aenter__(self) -> CdpClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def __enter__(self) -> CdpClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close_sync()


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


def _js_string(s: str) -> str:
    """Escape a Python string for safe embedding in JavaScript."""
    return json.dumps(s)


class Page:
    """High-level API for a single browser tab.

    Do not instantiate directly — use ``chrome.new_page()`` instead.
    """

    def __init__(
        self,
        browser_client: CdpClient,
        session_id: str,
        target_id: str,
    ) -> None:
        self._browser = browser_client
        self._session_id = session_id
        self._target_id = target_id
        self._closed = False

    def _send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> dict[str, Any]:
        """Send a CDP command routed to this tab's session."""
        return self._browser.send_sync(
            method, params, timeout=timeout, session_id=self._session_id
        )

    @property
    def target_id(self) -> str:
        """The CDP target ID of this tab."""
        return self._target_id

    @property
    def closed(self) -> bool:
        """Whether this page (tab) has been closed."""
        return self._closed

    def navigate(self, url: str, *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        """Navigate to a URL and wait for the page to load.

        Args:
            url: The URL to navigate to.
            timeout: Maximum wait time for the load event (seconds).

        Returns:
            Dict with ``frameId`` and ``loaderId`` from Page.navigate.

        Raises:
            RuntimeError: If navigation fails.
            TimeoutError: If the page does not finish loading in time.
        """
        result = self._send("Page.navigate", {"url": url}, timeout=timeout)

        error_text = result.get("errorText")
        if error_text:
            raise RuntimeError(f"Navigation failed: {error_text}")

        deadline = time.monotonic() + timeout
        while True:
            ready_state = self.evaluate("document.readyState")
            if ready_state == "complete":
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Page did not finish loading within {timeout}s: {url}"
                )
            time.sleep(_POLL_INTERVAL)

        return result

    def click(self, selector: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Click an element identified by CSS selector.

        Args:
            selector: CSS selector for the element to click.
            timeout: Timeout for finding the element.

        Raises:
            RuntimeError: If the element is not found or not visible.
        """
        js = f"""
        (() => {{
            const el = document.querySelector({_js_string(selector)});
            if (!el) return {{ error: 'Element not found: {selector}' }};
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0)
                return {{ error: 'Element has zero size: {selector}' }};
            return {{
                x: Math.round(rect.x + rect.width / 2),
                y: Math.round(rect.y + rect.height / 2)
            }};
        }})()
        """
        result = self.evaluate(js, timeout=timeout)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])

        x = result["x"]
        y = result["y"]

        self._send(
            "Input.dispatchMouseEvent",
            {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )
        self._send(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )

    def type(self, selector: str, text: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Type text into an element identified by CSS selector.

        Args:
            selector: CSS selector for the input element.
            text: The text to type.
            timeout: Timeout for finding the element.

        Raises:
            RuntimeError: If the element is not found.
        """
        focus_js = f"""
        (() => {{
            const el = document.querySelector({_js_string(selector)});
            if (!el) return {{ error: 'Element not found: {selector}' }};
            el.focus();
            return {{ ok: true }};
        }})()
        """
        result = self.evaluate(focus_js, timeout=timeout)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])

        for char in text:
            self._send(
                "Input.dispatchKeyEvent",
                {"type": "keyDown", "text": char, "key": char},
            )
            self._send(
                "Input.dispatchKeyEvent",
                {"type": "keyUp", "key": char},
            )

    def fill(self, fields: dict[str, str], *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Fill multiple form fields at once.

        Args:
            fields: Mapping of CSS selector to value.
            timeout: Timeout for finding each element.

        Raises:
            RuntimeError: If any element is not found.
        """
        for selector, value in fields.items():
            clear_js = f"""
            (() => {{
                const el = document.querySelector({_js_string(selector)});
                if (!el) return {{ error: 'Element not found: {selector}' }};
                el.focus();
                el.value = '';
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                return {{ ok: true }};
            }})()
            """
            result = self.evaluate(clear_js, timeout=timeout)
            if isinstance(result, dict) and "error" in result:
                raise RuntimeError(result["error"])

            for char in value:
                self._send(
                    "Input.dispatchKeyEvent",
                    {"type": "keyDown", "text": char, "key": char},
                )
                self._send(
                    "Input.dispatchKeyEvent",
                    {"type": "keyUp", "key": char},
                )

    def wait_for(
        self,
        condition: str,
        *,
        timeout: float = _WAIT_TIMEOUT,
        poll_interval: float = _POLL_INTERVAL,
    ) -> Any:
        """Wait for a condition to become truthy.

        Supports ``text=`` shorthand: ``wait_for("text=Dashboard")`` is
        equivalent to ``wait_for('document.body.innerText.includes("Dashboard")')``.

        Args:
            condition: JavaScript expression or ``"text=<string>"`` shorthand.
            timeout: Maximum wait time (seconds).
            poll_interval: How often to check (seconds).

        Returns:
            The truthy value of the condition.

        Raises:
            TimeoutError: If the condition does not become truthy in time.
        """
        if condition.startswith("text="):
            search_text = condition[5:]
            condition = f"document.body.innerText.includes({json.dumps(search_text)})"

        deadline = time.monotonic() + timeout
        while True:
            result = self.evaluate(condition)
            if result:
                return result
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Condition not met within {timeout}s: {condition}"
                )
            time.sleep(poll_interval)

    def evaluate(
        self,
        expression: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        await_promise: bool = False,
    ) -> Any:
        """Evaluate JavaScript in the page context.

        Args:
            expression: JavaScript expression to evaluate.
            timeout: Timeout for the evaluation.
            await_promise: If True, await the result if it is a Promise.

        Returns:
            The evaluated value. Returns None for undefined results.

        Raises:
            RuntimeError: If the evaluation throws an exception.
        """
        params: dict[str, Any] = {
            "expression": expression,
            "returnByValue": True,
        }
        if await_promise:
            params["awaitPromise"] = True

        result = self._send("Runtime.evaluate", params, timeout=timeout)

        if "exceptionDetails" in result:
            exc = result["exceptionDetails"]
            text = exc.get("text", "")
            exception = exc.get("exception", {})
            desc = exception.get("description", text)
            raise RuntimeError(f"JavaScript error: {desc}")

        remote_obj = result.get("result", {})
        if remote_obj.get("type") == "undefined":
            return None
        return remote_obj.get("value")

    def download(
        self,
        *,
        download_path: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        """Enable downloads and return the download directory.

        Args:
            download_path: Directory to save downloads. Defaults to a temp dir.
            timeout: Timeout for the CDP command.

        Returns:
            The absolute path of the download directory.
        """
        path = download_path or _DOWNLOAD_DIR
        os.makedirs(path, exist_ok=True)

        self._browser.send_sync(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": path,
                "eventsEnabled": True,
            },
            timeout=timeout,
        )
        return path

    def close(self) -> None:
        """Close this tab."""
        if self._closed:
            return
        self._closed = True
        try:
            self._browser.send_sync(
                "Target.closeTarget", {"targetId": self._target_id}
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Chrome
# ---------------------------------------------------------------------------


class Chrome:
    """Connection to a Chrome browser instance.

    Use ``Chrome.connect()`` to create an instance.
    """

    def __init__(self, client: CdpClient) -> None:
        self._client = client
        self._closed = False

    @classmethod
    def connect(
        cls,
        host: str = "localhost",
        port: int = 9222,
    ) -> Chrome:
        """Connect to a running Chrome instance.

        Args:
            host: Chrome host (default: localhost).
            port: Chrome debugging port (default: 9222).

        Returns:
            A connected Chrome instance.

        Raises:
            ConnectionError: If Chrome is not reachable on the given port.
        """
        client = CdpClient.connect_sync(host=host, port=port)
        return cls(client)

    @contextmanager
    def new_page(self, url: str = "about:blank") -> Generator[Page, None, None]:
        """Create a new tab and return a Page as a context manager.

        The tab is automatically closed when the context manager exits.

        Args:
            url: Initial URL for the new tab (default: about:blank).

        Yields:
            A Page instance for the new tab.
        """
        result = self._client.send_sync(
            "Target.createTarget", {"url": url}
        )
        target_id = result["targetId"]

        attach_result = self._client.send_sync(
            "Target.attachToTarget",
            {"targetId": target_id, "flatten": True},
        )
        session_id = attach_result["sessionId"]

        page = Page(
            browser_client=self._client,
            session_id=session_id,
            target_id=target_id,
        )

        try:
            yield page
        finally:
            page.close()

    @property
    def closed(self) -> bool:
        """Whether the Chrome connection is closed."""
        return self._closed

    def close(self) -> None:
        """Close the browser connection (does NOT close Chrome)."""
        if self._closed:
            return
        self._closed = True
        self._client.close_sync()

    def __enter__(self) -> Chrome:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


__all__ = ["Chrome", "Page", "CdpClient", "CdpError"]
