"""Shared test fixtures for CDP client tests."""

from __future__ import annotations

import asyncio
import json
import secrets
import shutil
import socket
from pathlib import Path
from typing import Any

import pytest
from websockets.exceptions import ConnectionClosed


class FakeWebSocket:
    """In-memory WebSocket mock for unit testing CdpClient.

    Simulates the websockets async iterator protocol that CdpClient._listen() uses.
    """

    def __init__(self) -> None:
        self._sent: list[str] = []
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self._closed = False

    async def send(self, data: str) -> None:
        """Record sent messages."""
        if self._closed:
            raise ConnectionClosed(None, None)
        self._sent.append(data)

    async def close(self) -> None:
        """Mark as closed and unblock any pending iteration."""
        self._closed = True
        # Sentinel None unblocks __anext__
        self._incoming.put_nowait(None)

    def inject_response(self, msg: dict[str, Any]) -> None:
        """Queue a response to be returned by the async iterator."""
        self._incoming.put_nowait(json.dumps(msg))

    @property
    def sent_messages(self) -> list[dict[str, Any]]:
        """Return all sent messages as parsed dicts."""
        return [json.loads(m) for m in self._sent]

    def __aiter__(self) -> FakeWebSocket:
        return self

    async def __anext__(self) -> str:
        msg = await self._incoming.get()
        if msg is None or self._closed:
            raise StopAsyncIteration
        return msg


@pytest.fixture
def fake_ws() -> FakeWebSocket:
    """Provide a fresh FakeWebSocket instance."""
    return FakeWebSocket()


@pytest.fixture(autouse=True)
def _isolated_script_api_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """S1: keep every test away from the real ~/.public-browser and a host-level key."""
    monkeypatch.setattr("publicbrowser.client.TOKEN_DIR", tmp_path / "pb-home", raising=False)
    monkeypatch.delenv("PUBLIC_BROWSER_SCRIPT_TOKEN", raising=False)


# ---------------------------------------------------------------------------
# P19: isolation from the developer's own Chrome setup
# ---------------------------------------------------------------------------

#: Ports of the developer's Chrome instances and of the benchmark. No test binds,
#: connects to or hands one of these to a server.
FORBIDDEN_PORTS = frozenset({9222, 9223, 9225, 9226, 9333})

#: Variables through which a started server or client would find a real profile,
#: a real Chrome, a real port, a real key or the real cortex and friction data.
CHROME_ENV_VARS: tuple[str, ...] = (
    "PUBLIC_BROWSER_PROFILE",
    "SILBERCUE_CHROME_PROFILE",
    "PUBLIC_BROWSER_CHROME_HOST",
    "SILBERCUE_CHROME_HOST",
    "PUBLIC_BROWSER_CHROME_PORT",
    "SILBERCUE_CHROME_PORT",
    "PUBLIC_BROWSER_SCRIPT_PORT",
    "SILBERCUE_SCRIPT_PORT",
    "SILBERCUE_CHROME_AUTO_LAUNCH",
    "SILBERCUE_CHROME_HEADLESS",
    "PUBLIC_BROWSER_CORTEX_DIR",
    "PUBLIC_BROWSER_SCRIPT_TOKEN",
    "SILBERCUE_CHROME_FRICTION_LOG",
)

#: The server of this checkout (``npm run build``).
LOCAL_SERVER_JS = Path(__file__).resolve().parents[2] / "build" / "index.js"

_CHROME_APP = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def free_test_port(start: int = 9340, taken: set[int] | None = None) -> int:
    """First free TCP port >= ``start`` on 127.0.0.1, never forbidden and never in ``taken``.

    Only binds to probe the port — nothing connects anywhere.
    """
    skip = FORBIDDEN_PORTS | (taken or set())
    for port in range(max(start, 1), 65536):
        if port in skip:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError(f"no free TCP port >= {start}")


def apply_isolated_chrome_env(
    monkeypatch: pytest.MonkeyPatch, tmp_dir: Path
) -> dict[str, int]:
    """Remove every variable in CHROME_ENV_VARS and point the cortex store at ``tmp_dir``.

    Returns two distinct free ports >= 9340 as ``cdp_port`` and ``script_port``.
    """
    for name in CHROME_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    cortex = tmp_dir / "cortex"
    cortex.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PUBLIC_BROWSER_CORTEX_DIR", str(cortex))
    cdp_port = free_test_port()
    script_port = free_test_port(taken={cdp_port})
    return {"cdp_port": cdp_port, "script_port": script_port}


@pytest.fixture
def isolated_chrome_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, int]:
    """P19: no test reaches the developer's Chrome, profile, ports, key or cortex data."""
    return apply_isolated_chrome_env(monkeypatch, tmp_path)


@pytest.fixture
def local_script_server(
    isolated_chrome_env: dict[str, int], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> dict[str, Any]:
    """``Chrome.connect(**...)`` arguments for a Public Browser from this checkout.

    The server listens on ``script_port`` and launches its own headless Chrome with
    a temp profile on ``cdp_port``. One key in the environment lets several
    ``Chrome.connect()`` calls of one test reach the same server.
    """
    if not LOCAL_SERVER_JS.exists():
        pytest.skip("build/index.js missing — run `npm run build` first")
    if shutil.which("google-chrome") is None and not _CHROME_APP.exists():
        pytest.skip("Chrome is not installed")
    monkeypatch.setenv("SILBERCUE_CHROME_PORT", str(isolated_chrome_env["cdp_port"]))
    monkeypatch.setenv("SILBERCUE_CHROME_HEADLESS", "true")
    monkeypatch.setenv("PUBLIC_BROWSER_SCRIPT_TOKEN", secrets.token_hex(32))
    monkeypatch.setenv("PUBLIC_BROWSER_DOWNLOAD_DIR", str(tmp_path / "downloads"))
    return {
        "host": "127.0.0.1",
        "port": isolated_chrome_env["script_port"],
        "server_path": str(LOCAL_SERVER_JS),
    }
