"""S10: The README example runs as a test.

The unit test executes the "Login and Data Extraction" block of
python/README.md verbatim against a fake Script API server and checks the
tool calls it produces. The integration tests run the same block — and a
click by text and by ref, also on a second page — against a real Public
Browser server (local build) and a local login page. They use test ports
from 9340 on only and never a real Chrome profile (Plancheck P19).
"""

from __future__ import annotations

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from publicbrowser import Chrome
from publicbrowser.page import Page, _extract_text
from tests.conftest import CHROME_ENV_VARS, FORBIDDEN_PORTS

PYTHON_DIR = Path(__file__).resolve().parents[1]
README_URL = "https://app.example.com/login"
# What local_script_server (conftest.py, Task 5) sets on purpose: its own CDP
# port, headless mode, a fresh key and a temp cortex store. Every other
# variable in CHROME_ENV_VARS would point the server at a real profile,
# another Chrome or another Script API port and must stay unset.
_SET_BY_FIXTURE = frozenset({
    "SILBERCUE_CHROME_PORT",
    "SILBERCUE_CHROME_HEADLESS",
    "PUBLIC_BROWSER_SCRIPT_TOKEN",
    "PUBLIC_BROWSER_CORTEX_DIR",
})
_MUST_BE_UNSET = tuple(name for name in CHROME_ENV_VARS if name not in _SET_BY_FIXTURE)
# A Markdown code fence, built at runtime so this file never contains one.
FENCE = "`" * 3


def _readme_block(heading: str) -> str:
    """Return the first fenced python block after ``heading`` in python/README.md."""
    text = (PYTHON_DIR / "README.md").read_text(encoding="utf-8")
    start = text.index(heading)
    match = re.search(FENCE + r"python\n(.*?)" + FENCE, text[start:], re.DOTALL)
    assert match, f"no python block after {heading!r}"
    return match.group(1)


def _run_readme_block(
    code: str, monkeypatch: pytest.MonkeyPatch, **connect_kwargs: Any
) -> dict[str, Any]:
    """exec the README block with Chrome.connect() bound to the given server."""
    original = Chrome.connect

    def connect(cls: type[Chrome], *args: Any, **kwargs: Any) -> Chrome:
        return original(**connect_kwargs)

    monkeypatch.setattr(Chrome, "connect", classmethod(connect))
    namespace: dict[str, Any] = {}
    try:
        exec(compile(code, "python/README.md", "exec"), namespace)
    finally:
        chrome = namespace.get("chrome")
        if isinstance(chrome, Chrome):
            chrome.close()
    return namespace


class _RecordingHandler(BaseHTTPRequestHandler):
    """Fake Script API: records tool calls, answers evaluate with a list."""

    requests: list[tuple[str, dict[str, Any]]] = []

    def do_GET(self) -> None:
        self._reply(200, {"server": "public-browser", "version": "test"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        _RecordingHandler.requests.append((self.path, body))
        if self.path == "/session/create":
            self._reply(200, {
                "session_token": "S1",
                "target_id": "T1",
                "cdp_ws_url": None,
                "cdp_session_id": "C1",
            })
        elif self.path == "/tool/evaluate":
            data = [{"name": "Alpha", "href": "/a"}]
            self._reply(200, {"content": [{"type": "text", "text": json.dumps(data)}], "isError": False})
        else:
            self._reply(200, {"content": [{"type": "text", "text": "ok"}], "isError": False})

    def _reply(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass


def test_readme_login_example_sends_the_documented_tool_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RecordingHandler.requests = []
    server = HTTPServer(("127.0.0.1", 0), _RecordingHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        namespace = _run_readme_block(
            _readme_block("## Login and Data Extraction"),
            monkeypatch,
            host="127.0.0.1",
            port=server.server_address[1],
            auto_start=False,
        )
    finally:
        server.shutdown()
        server.server_close()

    tools = [(path, body) for path, body in _RecordingHandler.requests if path.startswith("/tool/")]
    assert [path for path, _ in tools] == [
        "/tool/navigate",
        "/tool/fill_form",
        "/tool/click",
        "/tool/wait_for",
        "/tool/evaluate",
    ]
    assert tools[0][1] == {"url": README_URL}
    assert tools[1][1] == {"fields": [
        {"selector": "#email", "value": "user@example.com"},
        {"selector": "#password", "value": "secret"},
    ]}
    assert tools[2][1] == {"selector": "#submit"}
    assert tools[3][1] == {"condition": "text", "text": "Dashboard", "timeout": 120000}
    assert "querySelectorAll('.item')" in tools[4][1]["expression"]
    assert namespace["data"] == [{"name": "Alpha", "href": "/a"}]


# ---------------------------------------------------------------------------
# Integration: real server from this checkout (npm run build), test ports only
# ---------------------------------------------------------------------------

_LOGIN_PAGE = """<!doctype html>
<title>Login</title>
<form onsubmit="event.preventDefault(); document.body.innerHTML = '<h1>Dashboard</h1><a class=item href=/a>Alpha</a><a class=item href=/b>Beta</a>';">
  <input id="email" type="email" aria-label="Email">
  <input id="password" type="password" aria-label="Password">
  <button id="submit" type="submit">Sign in</button>
</form>
"""


class _LoginSite(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        data = _LOGIN_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def login_site():
    server = HTTPServer(("127.0.0.1", 0), _LoginSite)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture
def real_server(
    local_script_server: dict[str, Any], isolated_chrome_env: dict[str, int]
) -> dict[str, Any]:
    """A real Public Browser from this checkout, on test ports only (Plancheck P19).

    Built on local_script_server (conftest.py, Task 5): isolated_chrome_env
    removed every profile, host and port variable and chose two free ports
    from 9340 on; the server starts its own headless Chrome with a temp
    profile on the CDP port and the Script API on the script port. This
    fixture only re-checks that nothing can reach the user's real Chromes
    (9222/9223/9225/9226), the benchmark port 9333 or a real profile.
    """
    cdp_port = isolated_chrome_env["cdp_port"]
    script_port = local_script_server["port"]
    assert script_port == isolated_chrome_env["script_port"]
    assert cdp_port >= 9340 and script_port >= 9340, (cdp_port, script_port)
    assert not {cdp_port, script_port} & FORBIDDEN_PORTS, (cdp_port, script_port)
    assert os.environ.get("SILBERCUE_CHROME_PORT") == str(cdp_port)
    leftover = [name for name in _MUST_BE_UNSET if os.environ.get(name)]
    assert not leftover, f"isolated_chrome_env left {leftover} set"
    assert os.environ.get("PUBLIC_BROWSER_CORTEX_DIR"), "cortex store must be a temp dir"
    return local_script_server


def _ref_of(page: Page, name: str) -> str:
    """The ref view_page shows for the interactive element named ``name``."""
    tree = _extract_text(page._call_tool("view_page", {"filter": "interactive"}))
    match = re.search(r"\[(e\d+)\][^\n]*" + re.escape(name), tree)
    assert match, tree
    return match.group(1)


@pytest.mark.integration
def test_readme_login_example_against_real_server(
    real_server: dict[str, Any], login_site: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    code = _readme_block("## Login and Data Extraction").replace(README_URL, f"{login_site}/login")
    namespace = _run_readme_block(code, monkeypatch, **real_server)
    assert namespace["data"] == [
        {"name": "Alpha", "href": f"{login_site}/a"},
        {"name": "Beta", "href": f"{login_site}/b"},
    ]


@pytest.mark.integration
def test_click_by_text_and_ref_against_real_server(
    real_server: dict[str, Any], login_site: str
) -> None:
    chrome = Chrome.connect(**real_server)
    try:
        with chrome.new_page() as page:
            # By text. wait_for first: navigate can return before the page has
            # settled, and click does not wait for the element.
            page.navigate(f"{login_site}/login")
            page.wait_for("#submit")
            page.click("text=Sign in")
            page.wait_for("text=Dashboard")

            # By ref, as view_page shows it.
            page.navigate(f"{login_site}/login")
            page.wait_for("#submit")
            page.click(_ref_of(page, "Sign in"))
            page.wait_for("text=Dashboard")
    finally:
        chrome.close()


@pytest.mark.integration
def test_new_page_after_closing_the_previous_one(
    real_server: dict[str, Any], login_site: str
) -> None:
    """Plancheck P35: a page opened after the previous one was closed works.

    Before Task 8 (a ref table per Script API tab) the second page failed in
    1 of 3 runs with "CDP error -32001: Session with given id not found".
    Three pages in a row, each with a ref click, so state left behind by a
    closed tab shows up.
    """
    chrome = Chrome.connect(**real_server)
    try:
        for _ in range(3):
            with chrome.new_page() as page:
                page.navigate(f"{login_site}/login")
                page.wait_for("#submit")
                page.click(_ref_of(page, "Sign in"))
                page.wait_for("text=Dashboard")
    finally:
        chrome.close()


@pytest.mark.integration
def test_click_selector_errors_raise_against_real_server(
    real_server: dict[str, Any], login_site: str
) -> None:
    """Task 10: an ambiguous or invalid selector reaches the caller as an exception."""
    chrome = Chrome.connect(**real_server)
    try:
        with chrome.new_page() as page:
            page.navigate(f"{login_site}/login")
            page.wait_for("#submit")
            with pytest.raises(RuntimeError, match=r"Selector 'input' matches 2 elements"):
                page.click("input")
            with pytest.raises(RuntimeError, match=r"Invalid CSS selector"):
                page.click("button:has-text('Sign in')")
            # Nothing was clicked: the form is still there, and a unique selector works.
            page.click("#submit")
            page.wait_for("text=Dashboard")
    finally:
        chrome.close()
