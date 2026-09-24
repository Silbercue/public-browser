"""Page — high-level API for a single browser tab (v2 — Shared Core Client).

A Page wraps a Script API session attached to a specific tab.
All browser automation logic runs server-side. Page methods send HTTP
tool calls and parse the MCP-format responses.

    with chrome.new_page() as page:
        page.navigate("https://example.com")
        page.click("#login")
        page.type("#user", "admin")

All public methods are synchronous.
"""

from __future__ import annotations

import json
import re
from typing import Any

from publicbrowser.client import DEFAULT_TIMEOUT, LONG_TIMEOUT, ScriptApiClient
from publicbrowser.escape_hatch import CdpEscapeHatch


class Page:
    """High-level API for a single browser tab.

    Do not instantiate directly — use ``chrome.new_page()`` instead.

    Args:
        client: The ScriptApiClient for HTTP communication.
        session_token: The session token for this tab.
        target_id: The CDP target ID of this tab.
    """

    def __init__(
        self,
        client: ScriptApiClient,
        session_token: str,
        target_id: str,
        cdp_ws_url: str | None = None,
        cdp_session_id: str | None = None,
    ) -> None:
        self._client = client
        self._session_token = session_token
        self._target_id = target_id
        self._cdp_ws_url = cdp_ws_url
        self._cdp_session_id = cdp_session_id
        self._escape_hatch: CdpEscapeHatch | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _call_tool(
        self,
        name: str,
        params: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send a tool call to the server and return the raw response."""
        return self._client.call_tool(
            name, params, self._session_token, timeout=timeout
        )

    @property
    def target_id(self) -> str:
        """The CDP target ID of this tab."""
        return self._target_id

    @property
    def session_token(self) -> str:
        """The session token for this tab."""
        return self._session_token

    @property
    def cdp(self) -> CdpEscapeHatch:
        """Direct CDP access for this tab (Escape Hatch).

        Returns a ``CdpEscapeHatch`` instance that communicates directly
        with Chrome via WebSocket, bypassing the Script API server.
        The instance is created lazily on first access and reused on
        subsequent accesses. The WebSocket connection itself is only
        opened on the first ``send()`` call.

        Raises:
            RuntimeError: If no CDP WebSocket URL is available.
        """
        if self._escape_hatch is None:
            if not self._cdp_ws_url:
                raise RuntimeError(
                    "CDP Escape Hatch not available: the server returned no "
                    "cdp_ws_url because Chrome runs over --remote-debugging-pipe "
                    "(a real profile via --profile, or transport \"pipe\") and "
                    "opens no debugging port. All page methods work as usual."
                )
            self._escape_hatch = CdpEscapeHatch(
                self._cdp_ws_url, self._cdp_session_id
            )
        return self._escape_hatch

    # ------------------------------------------------------------------
    # Page methods
    # ------------------------------------------------------------------

    def navigate(self, url: str, *, timeout: float = LONG_TIMEOUT) -> None:
        """Navigate to a URL and wait for the page to load.

        Args:
            url: The URL to navigate to.
            timeout: Maximum wait time (seconds).

        Raises:
            RuntimeError: If navigation fails.
        """
        response = self._call_tool("navigate", {"url": url}, timeout=timeout)
        _check_error(response)

    def click(self, selector: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Click an element.

        The server handles scroll-into-view, Shadow DOM traversal, and
        paint-order filtering.

        Args:
            selector: A CSS selector (``"#login"``), visible text with the
                ``text=`` prefix (``"text=Sign in"``), or a ref as shown by
                ``view_page`` (``"e12"``, also ``"ref:12"``). Without a prefix
                the string is a CSS selector.
            timeout: Timeout for the operation.

        Raises:
            ValueError: If a ``ref:`` selector is malformed.
            RuntimeError: If the element is not found or click fails.
        """
        response = self._call_tool("click", _click_target(selector), timeout=timeout)
        _check_error(response)

    def type(self, selector: str, text: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Type text into an element.

        Args:
            selector: CSS selector of the input element.
            text: The text to type.
            timeout: Timeout for the operation.

        Raises:
            RuntimeError: If the element is not found.
        """
        response = self._call_tool(
            "type", {"selector": selector, "text": text}, timeout=timeout
        )
        _check_error(response)

    def fill(self, fields: dict[str, str], *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Fill multiple form fields at once.

        Args:
            fields: Mapping of selector to value.
            timeout: Timeout for the operation.

        Raises:
            RuntimeError: If any element is not found.
        """
        field_list = [
            {"selector": selector, "value": value}
            for selector, value in fields.items()
        ]
        response = self._call_tool("fill_form", {"fields": field_list}, timeout=timeout)
        _check_error(response)

    def wait_for(self, condition: str, *, timeout: float = LONG_TIMEOUT) -> None:
        """Wait until a condition holds. The server handles all polling.

        Args:
            condition: One of

                - ``"text=Dashboard"`` — the page text contains ``Dashboard``
                - a ref as shown by ``view_page`` (``"e12"``, also ``"ref:12"``)
                  — the element is visible
                - a CSS selector starting with ``#``, ``.`` or ``[`` — the element
                  is visible
                - ``"network_idle"`` — no network activity
                - anything else — a JavaScript expression that evaluates to
                  ``true`` (strictly: an element or a non-empty string is
                  not enough, write ``document.querySelector('#x') !== null``)
            timeout: Maximum wait time (seconds).

        Raises:
            ValueError: If a ``ref:`` condition is malformed.
            TimeoutError: If the condition does not become true in time.
            RuntimeError: If the wait fails for other reasons.
        """
        # The HTTP gateway doesn't apply Zod schema defaults, so we must
        # always include timeout explicitly (server expects milliseconds).
        timeout_ms = int(timeout * 1000)
        if condition == "network_idle":
            params: dict[str, Any] = {"condition": "network_idle", "timeout": timeout_ms}
        elif condition.startswith(_TEXT_PREFIX):
            params = {
                "condition": "text",
                "text": condition[len(_TEXT_PREFIX):],
                "timeout": timeout_ms,
            }
        elif (ref := _as_ref(condition)) is not None:
            params = {"condition": "element", "selector": ref, "timeout": timeout_ms}
        elif condition.startswith(("#", ".", "[")):
            params = {"condition": "element", "selector": condition, "timeout": timeout_ms}
        else:
            params = {"condition": "js", "expression": condition, "timeout": timeout_ms}
        response = self._call_tool("wait_for", params, timeout=timeout)
        # wait_for may return isError for timeouts
        if response.get("isError"):
            text = _extract_text(response)
            if "timeout" in text.lower() or "timed out" in text.lower():
                raise TimeoutError(text)
            raise RuntimeError(text)

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
            The evaluated value. Attempts to parse JSON from the server
            response; returns the raw string if parsing fails.

        Raises:
            RuntimeError: If the evaluation throws an exception.
        """
        params: dict[str, Any] = {"expression": expression}
        if await_promise:
            params["await_promise"] = True

        response = self._call_tool("evaluate", params, timeout=timeout)
        _check_error(response)
        return _parse_evaluate_response(response)

    def download(self, *, timeout: float = DEFAULT_TIMEOUT) -> str:
        """Wait for pending downloads and return the download tool's report.

        Calls the ``download`` tool with its default action ``status``: it
        waits for downloads still in progress and reports the finished ones.

        Returns:
            The report text: JSON (``{"downloads": [...], "pending": n}``,
            each download with filename, path, size and url) or a plain
            notice such as ``"No downloads in progress or completed."``.
            Blocks the server adds around it (download, dialog and relaunch
            notices) are not part of it.

        Raises:
            RuntimeError: If the operation fails.
        """
        response = self._call_tool("download", {}, timeout=timeout)
        _check_error(response)
        return _value_text(response)

    def close(self) -> None:
        """Close the Escape Hatch WebSocket connection if open.

        The tab itself is not closed here — tab lifecycle is managed via
        session create/close. The context manager (Chrome.new_page()) calls
        close_session to close the tab.
        """
        if self._escape_hatch is not None:
            self._escape_hatch.close()
            self._escape_hatch = None


# ------------------------------------------------------------------
# Selector helpers (S10)
# ------------------------------------------------------------------

_TEXT_PREFIX = "text="
_REF_PREFIX = "ref:"
_BARE_REF = re.compile(r"e\d+")
_REF_BODY = re.compile(r"e?(\d+)")


def _as_ref(selector: str) -> str | None:
    """``ref:42``, ``ref:e42`` or ``e42`` → ``"e42"``; anything else → None."""
    if selector.startswith(_REF_PREFIX):
        match = _REF_BODY.fullmatch(selector[len(_REF_PREFIX):])
        if match is None:
            raise ValueError(
                f"Invalid ref {selector!r}: expected ref:<number> or e<number> "
                f"(as shown by view_page)"
            )
        return f"e{match.group(1)}"
    if _BARE_REF.fullmatch(selector):
        return selector
    return None


def _click_target(selector: str) -> dict[str, str]:
    """Map the Python selector syntax onto the click tool's target parameter."""
    if selector.startswith(_TEXT_PREFIX):
        return {"text": selector[len(_TEXT_PREFIX):]}
    ref = _as_ref(selector)
    if ref is not None:
        return {"ref": ref}
    return {"selector": selector}


# ------------------------------------------------------------------
# Response parsing helpers
# ------------------------------------------------------------------


def _extract_text(response: dict[str, Any]) -> str:
    """Extract the text content from a MCP ToolResponse.

    The server response format is:
    ``{"content": [{"type": "text", "text": "..."}], "isError": false}``

    Returns:
        The text of all text items, joined by a newline — not only the
        first one — or an empty string. Non-text items (images) are skipped.
    """
    content = response.get("content", [])
    if not isinstance(content, list):
        return ""
    return "\n".join(
        item.get("text", "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    )


def _check_error(response: dict[str, Any]) -> None:
    """Check if the server response indicates an error.

    Args:
        response: The parsed server response.

    Raises:
        RuntimeError: If ``isError`` is true in the response.
    """
    if response.get("isError"):
        text = _extract_text(response)
        raise RuntimeError(text or "Unknown server error")


# Stufe 1 (E5): hint paragraphs the server appends after a result.
_HINT_PARAGRAPH = re.compile(r"\n\n(?:Tip|Note|Warning|Notice): ")
# Stufe 1 (E5): blocks the server adds next to the tool's own output — the DOM
# diff of an earlier click, dialog and download notices, whole-block hints and
# the pipe-fallback warning of a real profile ("Public Browser: Chrome refused …").
_ADDED_BLOCK = re.compile(
    r"(?:--- Action Result \(|\[dialog\] |--- Download completed ---|Public Browser: "
    r"|(?:Tip|Note|Warning|Notice): )"
)


def _value_text(response: dict[str, Any]) -> str:
    """Return the text the tool itself produced, without appended hints.

    Skips blocks the server adds around the result (a DOM diff from an
    earlier click, dialog and download notices, the pipe-fallback warning)
    and cuts every remaining block from its first hint paragraph
    ("\\n\\nTip: ", "\\n\\nNote: ", "\\n\\nWarning: ", "\\n\\nNotice: ") on.
    The remaining blocks are joined by a newline — the same rule as
    extractResultValue() in src/plan/plan-variables.ts.
    """
    content = response.get("content", [])
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text", "")
        if _ADDED_BLOCK.match(text):
            continue
        match = _HINT_PARAGRAPH.search(text)
        parts.append(text[: match.start()] if match else text)
    return "\n".join(parts)


def _parse_evaluate_response(response: dict[str, Any]) -> Any:
    """Parse the evaluate tool response into a Python value.

    The server returns the JS value as serialized text. We try to parse
    it as JSON first (handles numbers, booleans, objects, arrays, null).
    If that fails, return the raw string. Hints the server appends and
    blocks it adds around the result are never part of the value.

    Returns:
        The parsed Python value (str, int, float, dict, list, None, bool).
    """
    text = _value_text(response)
    if not text:
        return None

    # Try JSON parse for structured values
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text


def _parse_tool_response(response: dict[str, Any]) -> str:
    """Parse a generic tool response, returning the text content.

    This is a convenience alias for _extract_text used in tests.
    """
    return _extract_text(response)
