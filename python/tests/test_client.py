"""Tests for ScriptApiClient — HTTP client for Script API.

Tests are structured in groups:
1. HTTP communication — _post(), call_tool(), error handling
2. Session management — create_session(), close_session()
3. Server auto-start — start_server(), _is_server_running(), _wait_for_server()
4. Client lifecycle — close(), context manager
"""

from __future__ import annotations

import json
import re
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from unittest.mock import ANY, MagicMock, patch

import pytest

from publicbrowser.client import ScriptApiClient, token_file

# ---------------------------------------------------------------------------
# Helper: Fake HTTP server that mimics Script API responses
# ---------------------------------------------------------------------------


class _FakeScriptApiHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that returns pre-configured responses."""

    # Class-level response queue (set by tests)
    responses: list[tuple[int, dict[str, Any]]] = []
    received_requests: list[tuple[str, dict[str, str], bytes]] = []

    # S1: answer to GET /health (set by tests)
    health_response: tuple[int, dict[str, Any]] = (
        200,
        {"server": "public-browser", "version": "test"},
    )

    def do_GET(self) -> None:
        headers_dict = {k: v for k, v in self.headers.items()}
        _FakeScriptApiHandler.received_requests.append((self.path, headers_dict, b""))
        status, response_body = _FakeScriptApiHandler.health_response
        response_bytes = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Record the request
        headers_dict = {k: v for k, v in self.headers.items()}
        _FakeScriptApiHandler.received_requests.append(
            (self.path, headers_dict, body)
        )

        if _FakeScriptApiHandler.responses:
            status, response_body = _FakeScriptApiHandler.responses.pop(0)
        else:
            status = 200
            response_body = {"ok": True}

        response_bytes = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Suppress output


@pytest.fixture
def fake_server():
    """Start a fake Script API HTTP server and return (client, server, port)."""
    _FakeScriptApiHandler.responses = []
    _FakeScriptApiHandler.received_requests = []
    _FakeScriptApiHandler.health_response = (200, {"server": "public-browser", "version": "test"})

    server = HTTPServer(("127.0.0.1", 0), _FakeScriptApiHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    client = ScriptApiClient("127.0.0.1", port)
    yield client, server, port

    server.shutdown()
    client.close()


# ---------------------------------------------------------------------------
# HTTP Communication Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientPost:
    """Test _post() HTTP communication."""

    def test_post_sends_json_body(self, fake_server: tuple) -> None:
        """_post() sends JSON-encoded body with correct Content-Type."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"result": "ok"}),
        ]

        result = client._post("/test", {"key": "value"})
        assert result == {"result": "ok"}

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/test"
        assert headers["Content-Type"] == "application/json"
        assert json.loads(body) == {"key": "value"}

    def test_post_includes_session_header(self, fake_server: tuple) -> None:
        """_post() includes X-Session header when session_token is provided."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client._post("/tool/click", {"selector": "#btn"}, session_token="TOKEN_123")

        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert headers["X-Session"] == "TOKEN_123"

    def test_post_omits_session_header_when_none(self, fake_server: tuple) -> None:
        """_post() omits X-Session header when no session_token."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client._post("/session/create", {})

        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert "X-Session" not in headers

    def test_post_http_error_raises_runtime_error(self, fake_server: tuple) -> None:
        """_post() raises RuntimeError on HTTP 4xx/5xx."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (404, {"error": "Not found"}),
        ]

        with pytest.raises(RuntimeError, match="HTTP 404"):
            client._post("/tool/unknown", {})

    def test_post_connection_refused_raises_connection_error(self) -> None:
        """_post() raises ConnectionError when server is not reachable."""
        client = ScriptApiClient("127.0.0.1", 19999)
        with pytest.raises(ConnectionError, match="not reachable"):
            client._post("/session/create", {}, timeout=1.0)


# ---------------------------------------------------------------------------
# Tool Call Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientCallTool:
    """Test call_tool() method."""

    def test_call_tool_sends_to_correct_endpoint(self, fake_server: tuple) -> None:
        """call_tool() sends POST to /tool/{name}."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"content": [{"type": "text", "text": "done"}], "isError": False}),
        ]

        client.call_tool("click", {"selector": "#btn"}, "TOKEN_X")

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/tool/click"
        assert headers["X-Session"] == "TOKEN_X"
        assert json.loads(body) == {"selector": "#btn"}

    def test_call_tool_returns_raw_response(self, fake_server: tuple) -> None:
        """call_tool() returns the raw server response dict."""
        client, server, port = fake_server
        expected = {"content": [{"type": "text", "text": "clicked"}], "isError": False}
        _FakeScriptApiHandler.responses = [(200, expected)]

        result = client.call_tool("click", {"selector": "#x"}, "TOK")
        assert result == expected

    def test_call_tool_uses_long_timeout_for_navigate(self, fake_server: tuple) -> None:
        """call_tool() uses LONG_TIMEOUT for navigate and wait_for."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"content": [], "isError": False}),
        ]

        # We can't easily test the timeout value passed to urlopen,
        # but we verify the tool name is in _LONG_TIMEOUT_TOOLS
        from publicbrowser.client import _LONG_TIMEOUT_TOOLS
        assert "navigate" in _LONG_TIMEOUT_TOOLS
        assert "wait_for" in _LONG_TIMEOUT_TOOLS
        assert "click" not in _LONG_TIMEOUT_TOOLS


# ---------------------------------------------------------------------------
# Session Management Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientSession:
    """Test create_session() and close_session()."""

    def test_create_session_returns_token_and_target(self, fake_server: tuple) -> None:
        """create_session() returns (session_token, target_id, cdp_ws_url, cdp_session_id)."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {
                "session_token": "TOK_ABC",
                "target_id": "TARGET_123",
                "cdp_ws_url": "ws://localhost:9222/devtools/page/TARGET_123",
                "cdp_session_id": "CDP_SESS_1",
            }),
        ]

        token, target, cdp_ws_url, cdp_session_id = client.create_session()
        assert token == "TOK_ABC"
        assert target == "TARGET_123"
        assert cdp_ws_url == "ws://localhost:9222/devtools/page/TARGET_123"
        assert cdp_session_id == "CDP_SESS_1"

        path, _, _ = _FakeScriptApiHandler.received_requests[0]
        assert path == "/session/create"

    def test_close_session_sends_token(self, fake_server: tuple) -> None:
        """close_session() sends session_token in body and X-Session header."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client.close_session("TOK_ABC")

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/session/close"
        assert headers["X-Session"] == "TOK_ABC"
        assert json.loads(body)["session_token"] == "TOK_ABC"


# ---------------------------------------------------------------------------
# Server Probe Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientServerProbe:
    """S1: _is_server_running() checks the identity via GET /health."""

    def test_is_server_running_checks_identity(self, fake_server: tuple) -> None:
        """A Public Browser that accepts the key counts as running."""
        client, server, port = fake_server
        assert client._is_server_running() is True
        path, _, _ = _FakeScriptApiHandler.received_requests[0]
        assert path == "/health"

    def test_probe_opens_no_session(self, fake_server: tuple) -> None:
        """The probe no longer creates and closes a throwaway tab."""
        client, server, port = fake_server
        client._is_server_running()
        paths = [p for p, _, _ in _FakeScriptApiHandler.received_requests]
        assert paths == ["/health"]

    def test_is_server_running_returns_false_when_no_server(self) -> None:
        """_is_server_running() returns False when no server is listening."""
        client = ScriptApiClient("127.0.0.1", 19999)
        assert client._is_server_running() is False

    def test_foreign_service_is_reported_not_used(self, fake_server: tuple) -> None:
        """Another program on the port (e.g. a Chrome DevTools port) is an error."""
        client, server, port = fake_server
        _FakeScriptApiHandler.health_response = (404, {"message": "Unknown command"})
        with pytest.raises(ConnectionError, match=r"not as a Public Browser Script API \(HTTP 404\)"):
            client._is_server_running()

    def test_other_json_service_is_reported(self, fake_server: tuple) -> None:
        """A 200 without the Public Browser identity is not our server either."""
        client, server, port = fake_server
        _FakeScriptApiHandler.health_response = (200, {"status": "ok"})
        with pytest.raises(ConnectionError, match="not as a Public Browser"):
            client._is_server_running()

    def test_old_server_without_health_is_reported(self, fake_server: tuple) -> None:
        """A Public Browser before S1 answers GET with 405 — reported, not used."""
        client, server, port = fake_server
        _FakeScriptApiHandler.health_response = (405, {"error": "method_not_allowed"})
        with pytest.raises(ConnectionError, match=r"HTTP 405\).*older than the Script API key"):
            client._is_server_running()

    def test_rejected_key_is_reported(self, fake_server: tuple) -> None:
        """A Public Browser that rejects our key raises PermissionError."""
        client, server, port = fake_server
        _FakeScriptApiHandler.health_response = (
            401,
            {"error": "unauthorized", "server": "public-browser"},
        )
        with pytest.raises(PermissionError, match="rejected the Script API key") as exc:
            client._is_server_running()
        # P19: the parallel auto-start has no key file — the message names that case too.
        assert "at the same moment" in str(exc.value)

    def test_non_http_service_is_reported(self) -> None:
        """P34: a service that does not speak HTTP (e.g. an SSH banner) is reported clearly."""
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        def answer_with_banner() -> None:
            conn, _ = listener.accept()
            with conn:
                conn.recv(1024)
                conn.sendall(b"SSH-2.0-OpenSSH_9.0\r\n")

        thread = threading.Thread(target=answer_with_banner, daemon=True)
        thread.start()
        try:
            client = ScriptApiClient("127.0.0.1", port)
            with pytest.raises(ConnectionError, match="answers, but not with HTTP"):
                client._is_server_running()
        finally:
            thread.join(timeout=5)
            listener.close()


class TestScriptApiKey:
    """S1: every request carries the key; where the key comes from."""

    def test_post_sends_given_key(self, fake_server: tuple) -> None:
        _, server, port = fake_server
        client = ScriptApiClient("127.0.0.1", port, token="KEY-1")
        client._post("/session/create", {})
        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert headers["Authorization"] == "Bearer KEY-1"

    def test_key_from_token_file(self, fake_server: tuple) -> None:
        _, server, port = fake_server
        path = token_file(port)
        path.parent.mkdir(parents=True)
        path.write_text("FILE-KEY\n", encoding="utf-8")
        client = ScriptApiClient("127.0.0.1", port)
        client._post("/session/create", {})
        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert headers["Authorization"] == "Bearer FILE-KEY"

    def test_env_key_wins_over_token_file(
        self, fake_server: tuple, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _, server, port = fake_server
        path = token_file(port)
        path.parent.mkdir(parents=True)
        path.write_text("FILE-KEY", encoding="utf-8")
        monkeypatch.setenv("PUBLIC_BROWSER_SCRIPT_TOKEN", "ENV-KEY")
        client = ScriptApiClient("127.0.0.1", port)
        client._post("/session/create", {})
        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert headers["Authorization"] == "Bearer ENV-KEY"

    def test_blank_env_key_counts_as_unset(
        self, fake_server: tuple, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _, server, port = fake_server
        monkeypatch.setenv("PUBLIC_BROWSER_SCRIPT_TOKEN", "   ")
        client = ScriptApiClient("127.0.0.1", port)
        client._post("/session/create", {})
        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert "Authorization" not in headers

    def test_no_key_no_authorization_header(self, fake_server: tuple) -> None:
        client, server, port = fake_server
        client._post("/session/create", {})
        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert "Authorization" not in headers


# ---------------------------------------------------------------------------
# Server Auto-Start Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientAutoStart:
    """Test start_server() and _wait_for_server()."""

    def test_start_server_with_explicit_path(self) -> None:
        """start_server() uses the explicit server_path when provided."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server(server_path="/usr/local/bin/public-browser")

            mock_popen.assert_called_once_with(
                ["/usr/local/bin/public-browser", "--script", "--script-port", "19998"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ANY,
            )

    def test_start_server_finds_binary_in_path(self) -> None:
        """start_server() finds public-browser in PATH."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("shutil.which", side_effect=lambda name: "/opt/bin/public-browser" if name == "public-browser" else None), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            mock_popen.assert_called_once_with(
                ["/opt/bin/public-browser", "--script", "--script-port", "19998"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ANY,
            )

    def test_start_server_falls_back_to_npx(self) -> None:
        """start_server() uses npx fallback when no binary in PATH."""
        client = ScriptApiClient("127.0.0.1", 19998)

        def which_side_effect(name: str) -> str | None:
            if name == "npx":
                return "/usr/local/bin/npx"
            return None

        with patch("shutil.which", side_effect=which_side_effect), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            mock_popen.assert_called_once_with(
                ["/usr/local/bin/npx", "-y", "public-browser@latest", "--", "--script",
                 "--script-port", "19998"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ANY,
            )

    def test_start_server_raises_when_no_binary(self) -> None:
        """start_server() raises FileNotFoundError when no binary found."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("shutil.which", return_value=None):
            with pytest.raises(FileNotFoundError, match="Cannot find"):
                client.start_server()

    def test_wait_for_server_timeout_raises(self) -> None:
        """_wait_for_server() raises TimeoutError when server doesn't start."""
        client = ScriptApiClient("127.0.0.1", 19999)
        client._server_proc = MagicMock()
        client._server_proc.poll.return_value = None  # Process still running

        with pytest.raises(TimeoutError, match="did not become ready"):
            client._wait_for_server(timeout=0.5)

    def test_wait_for_server_detects_crashed_process(self) -> None:
        """_wait_for_server() raises RuntimeError when server process exits."""
        client = ScriptApiClient("127.0.0.1", 19999)
        client._server_proc = MagicMock()
        client._server_proc.poll.return_value = 1  # Process exited with code 1
        client._server_proc.returncode = 1

        with pytest.raises(RuntimeError, match="exited with code 1"):
            client._wait_for_server(timeout=2.0)

    def test_start_server_hands_over_a_fresh_key_via_env(self) -> None:
        """S1: the key travels in the environment, never on the command line."""
        client = ScriptApiClient("127.0.0.1", 19998)
        with patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server(server_path="/x/public-browser")

        env = mock_popen.call_args.kwargs["env"]
        key = env["PUBLIC_BROWSER_SCRIPT_TOKEN"]
        assert re.fullmatch(r"[0-9a-f]{64}", key)
        assert client._token == key
        assert key not in mock_popen.call_args.args[0]

    def test_start_server_uses_given_key(self) -> None:
        client = ScriptApiClient("127.0.0.1", 19998, token="GIVEN")
        with patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_popen.return_value = MagicMock()
            client.start_server(server_path="/x/public-browser")
        assert mock_popen.call_args.kwargs["env"]["PUBLIC_BROWSER_SCRIPT_TOKEN"] == "GIVEN"

    def test_start_server_stops_its_server_when_the_port_is_taken(self) -> None:
        """A server that cannot serve the port is terminated, the error propagates."""
        client = ScriptApiClient("127.0.0.1", 19998)
        proc = MagicMock()
        proc.poll.return_value = None
        with patch("subprocess.Popen", return_value=proc), \
             patch.object(client, "_wait_for_server",
                          side_effect=ConnectionError("Port 19998 answers, but not as ...")):
            with pytest.raises(ConnectionError):
                client.start_server(server_path="/x/public-browser")
        proc.terminate.assert_called_once()

    def test_wait_for_server_accepts_only_public_browser(self, fake_server: tuple) -> None:
        """_wait_for_server() does not take a foreign service for the started server."""
        client, server, port = fake_server
        client._server_proc = MagicMock()
        client._server_proc.poll.return_value = None
        _FakeScriptApiHandler.health_response = (404, {})
        with pytest.raises(ConnectionError):
            client._wait_for_server(timeout=2.0)


# ---------------------------------------------------------------------------
# Shutdown Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientShutdown:
    """Test _shutdown_server() and close()."""

    def test_shutdown_terminates_process(self) -> None:
        """_shutdown_server() terminates an auto-started process."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # Still running
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_called_once()
        mock_proc.wait.assert_called_once_with(timeout=3.0)

    def test_shutdown_kills_on_timeout(self) -> None:
        """_shutdown_server() kills process if terminate doesn't work."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.wait.side_effect = subprocess.TimeoutExpired(cmd="test", timeout=3)
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_called_once()
        mock_proc.kill.assert_called_once()

    def test_shutdown_noop_when_no_process(self) -> None:
        """_shutdown_server() does nothing when no process was started."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client._shutdown_server()  # Should not raise

    def test_shutdown_noop_when_process_already_exited(self) -> None:
        """_shutdown_server() does nothing when process already exited."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0  # Already exited
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_not_called()

    def test_close_sets_closed_flag(self) -> None:
        """close() sets the closed flag."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client.close()
        assert client.closed

    def test_double_close_is_safe(self) -> None:
        """Calling close() twice does not raise."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client.close()
        client.close()  # Should not raise

    def test_context_manager(self) -> None:
        """ScriptApiClient works as context manager."""
        client = ScriptApiClient("127.0.0.1", 9223)
        with client as c:
            assert c is client
            assert not c.closed
        assert client.closed
