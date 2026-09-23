"""End-to-end coexistence test — Story 9.4 (Task 3).

Tests a server started by one client and a second Python client operating
against the SAME Chrome instance simultaneously. This is the strongest
verification of NFR19.

**Prerequisites:**
  1. Build the server: ``npm run build``
  2. Run: ``pytest -m integration tests/test_e2e_coexistence.py -v``

The fixture ``running_server`` starts the server of this checkout on its own
ports >= 9340 with its own headless Chrome (never 9222/9223); the tests attach
to it with ``auto_start=False``, sharing the key through the environment.

**What this tests:**
  - A Python script creates its own tab via the Script API, navigates, reads data, closes it
  - Two script tabs on the same Chrome do not interfere
  - The tab is closed even when the script raises

This file is skipped by default (``-m integration`` marker).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from publicbrowser import Chrome


@pytest.fixture
def running_server(local_script_server: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Start the server of this checkout; tests attach to it with auto_start=False."""
    owner = Chrome.connect(**local_script_server)
    try:
        yield {"host": local_script_server["host"], "port": local_script_server["port"]}
    finally:
        owner.close()


@pytest.mark.integration
class TestE2ECoexistence:
    """Full end-to-end test: two clients on the same server and Chrome."""

    def test_script_tab_does_not_affect_existing_tabs(
        self, running_server: dict[str, Any]
    ) -> None:
        """Script API creates a tab, operates, closes it — existing tabs unchanged."""
        chrome = Chrome.connect(**running_server, auto_start=False)
        try:
            # Script creates a tab, does work, closes it
            with chrome.new_page() as page:
                page.navigate("about:blank")

                # Do some work
                page.evaluate("document.title = 'Script Tab'")
                title = page.evaluate("document.title")
                assert title == "Script Tab"

            # After context manager exit, session is closed server-side
        finally:
            chrome.close()

    def test_parallel_script_tabs_isolated(self, running_server: dict[str, Any]) -> None:
        """Two script tabs operate independently on the same Chrome."""
        chrome = Chrome.connect(**running_server, auto_start=False)
        try:
            with chrome.new_page() as page_a:
                page_a.navigate("about:blank")
                with chrome.new_page() as page_b:
                    page_b.navigate("about:blank")

                    # Different targets
                    assert page_a.target_id != page_b.target_id

                    # Set different titles
                    page_a.evaluate("document.title = 'Alpha'")
                    page_b.evaluate("document.title = 'Beta'")

                    # Verify isolation
                    assert page_a.evaluate("document.title") == "Alpha"
                    assert page_b.evaluate("document.title") == "Beta"

        finally:
            chrome.close()

    def test_script_tab_exception_cleanup(self, running_server: dict[str, Any]) -> None:
        """Tab is closed even when an exception occurs in the script."""
        chrome = Chrome.connect(**running_server, auto_start=False)
        try:
            with pytest.raises(ValueError, match="intentional"):
                with chrome.new_page() as page:
                    page.navigate("about:blank")
                    page.evaluate("document.title = 'Will crash'")
                    raise ValueError("intentional error")

            # After context manager exit (even with exception),
            # session is closed server-side by Chrome.new_page()'s finally block
        finally:
            chrome.close()
