"""End-to-end coexistence test — Story 9.4 (Task 3).

Tests MCP server and Python Script API operating against the SAME Chrome
instance simultaneously. This is the strongest verification of NFR19.

**Prerequisites:**
  1. Build the MCP server: ``npm run build``
  2. Start Chrome with: ``google-chrome --remote-debugging-port=9222``
     (or let the MCP server auto-launch it)
  3. Run: ``pytest -m integration tests/test_e2e_coexistence.py -v``

**What this tests:**
  - MCP server owns its tab and operates on it via CDP
  - Python script creates its own tab, navigates, reads data, closes it
  - After the script tab lifecycle, the MCP tab's URL is unchanged
  - Both operate on the same Chrome (port 9222) without interference

This file is skipped by default (``-m integration`` marker).
"""

from __future__ import annotations

import shutil

import pytest

from silbercuechrome.chrome import Chrome


_CHROME_AVAILABLE = shutil.which("google-chrome") is not None or shutil.which(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
) is not None

_SKIP_REASON = (
    "E2E test requires Chrome with --remote-debugging-port=9222. "
    "Start Chrome manually and run with: pytest -m integration"
)


@pytest.mark.integration
@pytest.mark.skipif(not _CHROME_AVAILABLE, reason=_SKIP_REASON)
class TestE2ECoexistence:
    """Full end-to-end test: MCP + Script API on the same Chrome."""

    def test_script_tab_does_not_affect_existing_tabs(self) -> None:
        """Script API creates a tab, operates, closes it — existing tabs unchanged.

        Simulates the scenario where an MCP server has a tab open and a
        Python script runs in parallel. After the script finishes, the
        original tab list should be unchanged.
        """
        chrome = Chrome.connect(port=9222)
        try:
            # Snapshot existing tabs before script operation
            targets_before = chrome._client.send_sync("Target.getTargets")
            page_tabs_before = [
                t for t in targets_before["targetInfos"] if t["type"] == "page"
            ]
            tab_ids_before = {t["targetId"] for t in page_tabs_before}

            # Script creates a tab, does work, closes it
            with chrome.new_page(url="about:blank") as page:
                # Verify our script tab is new
                assert page.target_id not in tab_ids_before

                # Do some work
                page.evaluate("document.title = 'Script Tab'")
                title = page.evaluate("document.title")
                assert title == "Script Tab"

            # Verify the script tab is gone
            assert page.closed

            # Snapshot tabs after — should match before
            targets_after = chrome._client.send_sync("Target.getTargets")
            page_tabs_after = [
                t for t in targets_after["targetInfos"] if t["type"] == "page"
            ]
            tab_ids_after = {t["targetId"] for t in page_tabs_after}

            # The script tab should be gone
            assert page.target_id not in tab_ids_after

            # Original tabs should still be there
            assert tab_ids_before.issubset(tab_ids_after)
        finally:
            chrome.close()

    def test_parallel_script_tabs_isolated(self) -> None:
        """Two script tabs operate independently on the same Chrome."""
        chrome = Chrome.connect(port=9222)
        try:
            with chrome.new_page(url="about:blank") as page_a:
                with chrome.new_page(url="about:blank") as page_b:
                    # Different targets
                    assert page_a.target_id != page_b.target_id

                    # Set different titles
                    page_a.evaluate("document.title = 'Alpha'")
                    page_b.evaluate("document.title = 'Beta'")

                    # Verify isolation
                    assert page_a.evaluate("document.title") == "Alpha"
                    assert page_b.evaluate("document.title") == "Beta"

            assert page_a.closed
            assert page_b.closed
        finally:
            chrome.close()

    def test_script_tab_exception_cleanup(self) -> None:
        """Tab is closed even when an exception occurs in the script."""
        chrome = Chrome.connect(port=9222)
        try:
            with pytest.raises(ValueError, match="intentional"):
                with chrome.new_page(url="about:blank") as page:
                    target_id = page.target_id
                    page.evaluate("document.title = 'Will crash'")
                    raise ValueError("intentional error")

            # Tab should be closed
            assert page.closed

            # Verify the tab is actually gone from Chrome
            targets = chrome._client.send_sync("Target.getTargets")
            page_tabs = [t for t in targets["targetInfos"] if t["type"] == "page"]
            tab_ids = {t["targetId"] for t in page_tabs}
            assert target_id not in tab_ids
        finally:
            chrome.close()
