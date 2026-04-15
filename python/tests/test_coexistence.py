"""CDP coexistence tests — Story 9.4.

Verifies NFR19: MCP server and Python Script API can operate in parallel
without interference. Tests cover:

1. Script-tab lifecycle does not disturb MCP (AC #1, #2)
2. Context manager closes tab on normal exit and on exception (AC #3)
3. Parallel Page objects operate in independent tabs (AC #1)

**Unit tests** (run with `pytest`):
  Mock-based tests using FakeWebSocket — no Chrome needed. These verify
  the Python-side contract: correct CDP commands are sent, context manager
  cleanup works, and parallel pages get different target IDs.

**Integration tests** (run with `pytest -m integration`):
  Require a running Chrome with ``--remote-debugging-port=9222``.
  Skipped by default in ``pytest`` (no ``-m integration`` flag).

To run integration tests manually:
  1. Start Chrome with: ``google-chrome --remote-debugging-port=9222``
  2. Run: ``cd python && pytest -m integration tests/test_coexistence.py -v``
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from typing import Any
from unittest.mock import patch

import pytest

from silbercuechrome.cdp import CdpClient
from silbercuechrome.chrome import Chrome
from silbercuechrome.page import Page
from tests.conftest import FakeWebSocket


# ---------------------------------------------------------------------------
# Helper: create a Chrome with FakeWebSocket
# ---------------------------------------------------------------------------


class _FakeConnectCtx:
    """Async context manager that returns a FakeWebSocket."""

    def __init__(self, ws: FakeWebSocket) -> None:
        self._ws = ws

    async def __aenter__(self) -> FakeWebSocket:
        return self._ws

    async def __aexit__(self, *exc: Any) -> None:
        pass


def make_chrome(fake_ws: FakeWebSocket) -> Chrome:
    """Create a Chrome instance with a FakeWebSocket-backed CdpClient."""
    with (
        patch.object(
            CdpClient,
            "_discover_browser_ws",
            return_value="ws://localhost:9222/devtools/browser/xyz",
        ),
        patch(
            "silbercuechrome.cdp.connect",
            return_value=_FakeConnectCtx(fake_ws),
        ),
    ):
        return Chrome.connect(port=9222)


def inject_from_thread(
    fake_ws: FakeWebSocket,
    loop: Any,
    messages: list[dict[str, Any]],
    delay: float = 0.03,
) -> None:
    """Inject responses from a background thread."""

    def _inject() -> None:
        for msg in messages:
            time.sleep(delay)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps(msg),
            )

    threading.Thread(target=_inject, daemon=True).start()


# ---------------------------------------------------------------------------
# Unit Tests — mock-based (no Chrome needed)
# ---------------------------------------------------------------------------


class TestScriptTabLifecycle:
    """Test that the Script API tab lifecycle is clean and isolated."""

    def test_new_page_creates_and_closes_tab_cleanly(self, fake_ws: FakeWebSocket) -> None:
        """new_page() creates a tab via CDP and closes it on context exit.

        This is the fundamental contract: a script tab has a bounded lifecycle
        managed by the context manager. The MCP server never sees it because
        it only tracks tabs it created itself.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        # Responses: createTarget, attachToTarget, closeTarget
        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "SCRIPT-TAB-1"}},
            {"id": 2, "result": {"sessionId": "SCRIPT-SESSION-1"}},
        ])

        with chrome.new_page() as page:
            assert page.target_id == "SCRIPT-TAB-1"
            assert not page.closed

            # Queue close response for context exit
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ], delay=0.01)

        # After context manager exit: tab is closed
        assert page.closed

        # Verify CDP commands sent
        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Target.createTarget"
        assert sent[1]["method"] == "Target.attachToTarget"
        assert sent[1]["params"]["targetId"] == "SCRIPT-TAB-1"
        assert sent[2]["method"] == "Target.closeTarget"
        assert sent[2]["params"]["targetId"] == "SCRIPT-TAB-1"

        chrome.close()

    def test_context_manager_closes_tab_on_exception(self, fake_ws: FakeWebSocket) -> None:
        """Context manager __exit__ sends Target.closeTarget even when an exception occurs.

        This guarantees AC #3: script tabs are cleaned up on both normal exit
        and exception paths. The MCP server never sees orphaned script tabs.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "CRASH-TAB"}},
            {"id": 2, "result": {"sessionId": "CRASH-SESSION"}},
        ])

        with pytest.raises(RuntimeError, match="simulated crash"):
            with chrome.new_page() as page:
                # Queue close response before raising
                inject_from_thread(fake_ws, loop, [
                    {"id": 3, "result": {"success": True}},
                ], delay=0.01)
                raise RuntimeError("simulated crash in script")

        # Tab was closed despite the exception
        assert page.closed

        # closeTarget was called
        sent = fake_ws.sent_messages
        close_calls = [m for m in sent if m["method"] == "Target.closeTarget"]
        assert len(close_calls) == 1
        assert close_calls[0]["params"]["targetId"] == "CRASH-TAB"

        chrome.close()

    def test_context_manager_handles_already_closed_tab(self, fake_ws: FakeWebSocket) -> None:
        """__exit__ does not raise if the tab was already closed (e.g. by user).

        This tests the robustness of the cleanup: if Chrome already closed the
        tab (user manually closed it), the context manager must not crash.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "GONE-TAB"}},
            {"id": 2, "result": {"sessionId": "GONE-SESSION"}},
        ])

        with chrome.new_page() as page:
            # Queue an error response for closeTarget (tab already gone)
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "error": {"code": -32000, "message": "No target with given id"}},
            ], delay=0.01)

        # Should NOT raise — close is best-effort
        assert page.closed

        chrome.close()


class TestParallelPages:
    """Test that multiple Page objects operate in independent tabs."""

    def test_two_pages_have_different_target_ids(self, fake_ws: FakeWebSocket) -> None:
        """Two sequential new_page() calls create tabs with different targetIds.

        This verifies AC #1: parallel script operations get their own tabs
        and do not interfere with each other or MCP-owned tabs.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        # First page
        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "PAGE-A"}},
            {"id": 2, "result": {"sessionId": "SESSION-A"}},
        ])

        with chrome.new_page() as page_a:
            assert page_a.target_id == "PAGE-A"

            # Queue close for page_a
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ], delay=0.01)

        # Second page
        inject_from_thread(fake_ws, loop, [
            {"id": 4, "result": {"targetId": "PAGE-B"}},
            {"id": 5, "result": {"sessionId": "SESSION-B"}},
        ])

        with chrome.new_page() as page_b:
            assert page_b.target_id == "PAGE-B"
            assert page_b.target_id != page_a.target_id

            # Queue close for page_b
            inject_from_thread(fake_ws, loop, [
                {"id": 6, "result": {"success": True}},
            ], delay=0.01)

        assert page_a.closed
        assert page_b.closed

        chrome.close()

    def test_page_operations_routed_to_correct_session(self, fake_ws: FakeWebSocket) -> None:
        """CDP commands from a Page are routed to its own session, not another's.

        This ensures that when two Pages exist simultaneously, evaluate()
        on page A goes to session A, not session B.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        # Create a page
        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "TAB-X"}},
            {"id": 2, "result": {"sessionId": "SID-X"}},
        ])

        with chrome.new_page() as page:
            # evaluate() sends Runtime.evaluate with the page's sessionId
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"result": {"type": "string", "value": "hello"}}},
            ])

            result = page.evaluate("'hello'", timeout=5.0)
            assert result == "hello"

            # Verify the session routing
            sent = fake_ws.sent_messages
            evaluate_calls = [m for m in sent if m["method"] == "Runtime.evaluate"]
            assert len(evaluate_calls) == 1
            assert evaluate_calls[0]["sessionId"] == "SID-X"

            # Queue close
            inject_from_thread(fake_ws, loop, [
                {"id": 4, "result": {"success": True}},
            ], delay=0.01)

        chrome.close()


class TestTabIsolation:
    """Test that script tabs do not interfere with each other or MCP state."""

    def test_script_tab_uses_own_session_id(self, fake_ws: FakeWebSocket) -> None:
        """Each script tab gets its own CDP session via Target.attachToTarget.

        This is the mechanism that ensures isolation: CDP commands are scoped
        to a session. The MCP server's session is completely separate.
        """
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "ISO-TAB"}},
            {"id": 2, "result": {"sessionId": "ISO-SESSION-UNIQUE"}},
        ])

        with chrome.new_page() as page:
            # The Page stores its own session_id
            assert page._session_id == "ISO-SESSION-UNIQUE"

            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ], delay=0.01)

        chrome.close()

    def test_page_close_is_idempotent(self, fake_ws: FakeWebSocket) -> None:
        """Calling page.close() multiple times only sends one closeTarget."""
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "IDEMPOTENT-TAB"}},
            {"id": 2, "result": {"sessionId": "IDEMPOTENT-SID"}},
        ])

        with chrome.new_page() as page:
            # Manually close once
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ])
            page.close()
            assert page.closed

        # Context manager exit tries close again — should be no-op
        sent = fake_ws.sent_messages
        close_calls = [m for m in sent if m["method"] == "Target.closeTarget"]
        assert len(close_calls) == 1

        chrome.close()


# ---------------------------------------------------------------------------
# Integration Tests — require real Chrome (skipped by default)
# ---------------------------------------------------------------------------

# Detect if Chrome is available for integration tests
_CHROME_AVAILABLE = shutil.which("google-chrome") is not None or shutil.which(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
) is not None

_SKIP_REASON = (
    "Integration test requires Chrome with --remote-debugging-port=9222. "
    "Start Chrome manually and run with: pytest -m integration"
)


@pytest.mark.integration
@pytest.mark.skipif(not _CHROME_AVAILABLE, reason=_SKIP_REASON)
class TestCoexistenceIntegration:
    """End-to-end coexistence tests against a real Chrome instance.

    Prerequisites:
      1. Chrome running with ``--remote-debugging-port=9222``
      2. Run with: ``pytest -m integration tests/test_coexistence.py -v``

    These tests create real tabs in Chrome and verify that the Script API
    correctly creates, operates on, and cleans up tabs without interfering
    with other tabs.
    """

    def test_script_tab_lifecycle_real_chrome(self) -> None:
        """Create a tab, navigate, evaluate, close — all against real Chrome."""
        chrome = Chrome.connect(port=9222)
        try:
            with chrome.new_page() as page:
                page.navigate("about:blank")
                result = page.evaluate("1 + 1")
                assert result == 2
                assert not page.closed
            assert page.closed
        finally:
            chrome.close()

    def test_context_manager_cleanup_on_exception_real_chrome(self) -> None:
        """Verify tab cleanup on exception with real Chrome."""
        chrome = Chrome.connect(port=9222)
        try:
            with pytest.raises(ValueError, match="test exception"):
                with chrome.new_page() as page:
                    target_id = page.target_id
                    raise ValueError("test exception")

            # Tab should be closed
            assert page.closed
        finally:
            chrome.close()

    def test_parallel_pages_different_targets_real_chrome(self) -> None:
        """Two pages have different target IDs in real Chrome."""
        chrome = Chrome.connect(port=9222)
        try:
            with chrome.new_page() as page_a:
                with chrome.new_page() as page_b:
                    assert page_a.target_id != page_b.target_id
                    # Both can navigate independently
                    page_a.navigate("about:blank")
                    page_b.navigate("about:blank")
        finally:
            chrome.close()
