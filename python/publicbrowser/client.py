"""ScriptApiClient — HTTP client for the Public Browser Script API.

Communicates with the Public Browser server via HTTP (default port 9223).
All browser automation logic (selector resolution, Shadow DOM, scroll-into-view,
paint-order filtering, ambient context) runs server-side. This client is a thin
HTTP wrapper that sends tool calls and parses responses.

Every request carries ``Authorization: Bearer <key>``. The key comes from the
``token`` argument, else ``PUBLIC_BROWSER_SCRIPT_TOKEN``, else the file
``~/.public-browser/script-api-<port>.token`` that a server started with
``--script`` writes (readable only by its user). A server this client starts
itself gets a fresh key through that environment variable.

Usage::

    from publicbrowser.client import ScriptApiClient

    client = ScriptApiClient("localhost", 9223)
    token, target_id = client.create_session()
    result = client.call_tool("navigate", {"url": "https://example.com"}, token)
    client.close_session(token)
"""

from __future__ import annotations

import atexit
import http.client
import json
import os
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Default timeouts (seconds)
DEFAULT_TIMEOUT = 30.0
LONG_TIMEOUT = 120.0
SERVER_START_TIMEOUT = 10.0
POLL_INTERVAL = 0.2

# The HTTP timeout sits this far above a tool's own ``timeout`` parameter
# (milliseconds), so the server's finding arrives before the socket gives up.
TOOL_TIMEOUT_MARGIN = 10.0

# Tools that need longer timeouts
_LONG_TIMEOUT_TOOLS = frozenset({"navigate", "wait_for"})

# S1: the key the server demands on every request.
TOKEN_ENV = "PUBLIC_BROWSER_SCRIPT_TOKEN"
# Identity reported by GET /health — anything else on the port is not our server.
SERVER_ID = "public-browser"
# Where a server started with --script leaves its key (one file per port).
TOKEN_DIR = Path.home() / ".public-browser"


def token_file(port: int) -> Path:
    """Path of the key file a server started with ``--script`` writes for ``port``."""
    return TOKEN_DIR / f"script-api-{port}.token"


def _read_json(source: Any) -> dict[str, Any]:
    """Parse a JSON object from an HTTP response or HTTPError; ``{}`` otherwise."""
    try:
        data = json.loads(source.read().decode("utf-8"))
    except (ValueError, OSError, AttributeError, http.client.HTTPException):
        return {}
    return data if isinstance(data, dict) else {}


class ScriptApiClient:
    """HTTP client for the Public Browser Script API (default port 9223).

    Handles server auto-start, session management, and tool calls.
    """

    def __init__(self, host: str, port: int, *, token: str | None = None) -> None:
        self._host = host
        self._port = port
        self._base_url = f"http://{host}:{port}"
        self._server_proc: subprocess.Popen[bytes] | None = None
        self._closed = False
        self._atexit_registered = False
        # S1: a key given explicitly (argument or environment) wins over the token file.
        self._given_token = (token or os.environ.get(TOKEN_ENV) or "").strip() or None
        self._token: str | None = self._given_token

    @property
    def base_url(self) -> str:
        """The base URL of the Script API server."""
        return self._base_url

    @property
    def closed(self) -> bool:
        """Whether the client has been closed."""
        return self._closed

    # ------------------------------------------------------------------
    # Server lifecycle
    # ------------------------------------------------------------------

    def _resolve_token(self) -> str | None:
        """The key for this port: the given key, else the token file of a --script server."""
        if self._token is None:
            try:
                self._token = token_file(self._port).read_text(encoding="utf-8").strip() or None
            except OSError:
                return None
        return self._token

    def _is_server_running(self) -> bool:
        """Check whether a Public Browser server listens on the port and accepts our key.

        Asks ``GET /health`` and checks the identity instead of accepting any answer.

        Returns:
            True if Public Browser answers and accepts the key, False if nothing listens.

        Raises:
            PermissionError: A Public Browser server listens but rejects the key.
            ConnectionError: Another program answers on the port, with HTTP or without.
        """
        return self._check_health(self._resolve_token(), timeout=2.0)

    def _check_health(self, token: str | None, *, timeout: float) -> bool:
        """``GET /health`` with ``token``; outcomes as in ``_is_server_running``."""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        req = urllib.request.Request(f"{self._base_url}/health", headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status, body = resp.status, _read_json(resp)
        except urllib.error.HTTPError as e:
            status, body = e.code, _read_json(e)
        except (urllib.error.URLError, OSError):
            return False
        except http.client.HTTPException as e:
            # Something listens but does not speak HTTP (e.g. an SSH or database port).
            # urllib passes these through unwrapped (BadStatusLine and friends).
            raise ConnectionError(
                f"Port {self._port} on {self._host} answers, but not with HTTP "
                f"({type(e).__name__}). Another program uses this port. "
                f"Use another port: Chrome.connect(port=...)."
            ) from e
        if status == 200 and body.get("server") == SERVER_ID:
            return True
        if status == 401 and body.get("server") == SERVER_ID:
            raise PermissionError(
                f"The Public Browser server on {self._host}:{self._port} rejected the "
                f"Script API key. If another script started this server at the same "
                f"moment, connect once and share the Chrome object, or start the server "
                f"beforehand with 'public-browser --script'. A server started with "
                f"--script keeps its key in {token_file(self._port)}; a server started "
                f"with its own key needs token=... or {TOKEN_ENV}."
            )
        raise ConnectionError(
            f"Port {self._port} on {self._host} answers, but not as a Public Browser "
            f"Script API (HTTP {status}). Another program uses this port, or a Public "
            f"Browser older than the Script API key runs there. "
            f"Use another port: Chrome.connect(port=...)."
        )

    def configure_profile(self, profile: str) -> dict[str, Any]:
        """Configure Chrome profile on a running server.

        Calls the /config/profile endpoint. If Chrome is already running,
        it will be restarted with the new profile.

        Args:
            profile: Chrome profile name (e.g. "Julian", "Business").

        Returns:
            Server response dict.

        Raises:
            RuntimeError: If the server returns an error.
        """
        return self._post(
            "/config/profile",
            {"profile": profile},
            timeout=LONG_TIMEOUT,
        )

    def start_server(
        self,
        server_path: str | None = None,
        *,
        profile: str | None = None,
    ) -> None:
        """Start the Public Browser server as a subprocess.

        Tries in order:
        1. Explicit ``server_path`` if provided
        2. ``public-browser`` in PATH (Homebrew binary)
        3. ``npx -y public-browser@latest -- --script`` as fallback

        Args:
            server_path: Explicit path to the server binary.
            profile: Chrome profile name to launch with.

        Raises:
            FileNotFoundError: If no server binary can be found.
            TimeoutError: If the server does not become ready in time.
            PermissionError: If another Public Browser server holds the port.
            ConnectionError: If another program holds the port.
        """
        cmd: list[str] | None = None

        if server_path:
            cmd = [server_path, "--script"]
        else:
            # Try public-browser in PATH
            binary = shutil.which("public-browser")
            if binary:
                cmd = [binary, "--script"]
            else:
                # Fallback to npx
                npx = shutil.which("npx")
                if npx:
                    cmd = [npx, "-y", "public-browser@latest", "--", "--script"]

        if cmd is None:
            raise FileNotFoundError(
                "Cannot find Public Browser server. Install via "
                "'brew install silbercue/tap/public-browser' or "
                "'npm install -g public-browser', or pass server_path= explicitly."
            )

        # The server listens where this client looks — before this, Chrome.connect(port=X)
        # started a server on 9223 and then waited on X.
        cmd.extend(["--script-port", str(self._port)])
        if profile:
            cmd.extend(["--profile", profile])

        # S1: the server gets its key through the environment, never as an argument
        # (the process list would show it).
        self._token = self._given_token or secrets.token_hex(32)
        self._server_proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, TOKEN_ENV: self._token},
        )
        if not self._atexit_registered:
            atexit.register(self._shutdown_server)
            self._atexit_registered = True

        # A server that cannot serve this port is useless — stop it again.
        try:
            self._wait_for_server()
        except BaseException:
            self._shutdown_server()
            raise

    def _wait_for_server(self, timeout: float = SERVER_START_TIMEOUT) -> None:
        """Poll ``GET /health`` until our server answers and accepts our key.

        Args:
            timeout: Maximum wait time in seconds.

        Raises:
            TimeoutError: If the server does not respond in time.
            RuntimeError: If the server process exits.
            PermissionError: If another Public Browser server answers on the port.
            ConnectionError: If another program answers on the port.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # Check if server process died
            if self._server_proc and self._server_proc.poll() is not None:
                raise RuntimeError(
                    f"Server process exited with code {self._server_proc.returncode}. "
                    f"Port {self._port} may be in use."
                )
            if self._check_health(self._token, timeout=1.0):
                return  # Server is ready
            time.sleep(POLL_INTERVAL)

        raise TimeoutError(
            f"Server did not become ready on port {self._port} within {timeout}s. "
            f"Try passing server_path= if the server is not in PATH."
        )

    def _shutdown_server(self) -> None:
        """Terminate the auto-started server process."""
        if self._server_proc and self._server_proc.poll() is None:
            # Close stdin pipe first — this signals the MCP stdio transport
            # to shut down gracefully before we send SIGTERM.
            if self._server_proc.stdin:
                try:
                    self._server_proc.stdin.close()
                except OSError:
                    pass
            self._server_proc.terminate()
            try:
                self._server_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                self._server_proc.kill()

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def create_session(self) -> tuple[str, str, str, str]:
        """Create a new session on the server.

        Returns:
            Tuple of (session_token, target_id, cdp_ws_url, cdp_session_id).

        Raises:
            RuntimeError: If the server returns an error.
            ConnectionError: If the server is not reachable.
        """
        result = self._post("/session/create", {})
        session_token = result["session_token"]
        target_id = result["target_id"]
        cdp_ws_url = result["cdp_ws_url"]
        cdp_session_id = result["cdp_session_id"]
        return session_token, target_id, cdp_ws_url, cdp_session_id

    def close_session(self, session_token: str) -> None:
        """Close a session on the server.

        Args:
            session_token: The session token to close.

        Raises:
            RuntimeError: If the server returns an error.
            ConnectionError: If the server is not reachable.
        """
        self._post(
            "/session/close",
            {"session_token": session_token},
            session_token=session_token,
        )

    # ------------------------------------------------------------------
    # Tool calls
    # ------------------------------------------------------------------

    def call_tool(
        self,
        name: str,
        params: dict[str, Any],
        session_token: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Call a tool on the server.

        Args:
            name: Tool name (e.g. "navigate", "click").
            params: Tool parameters as a dict.
            session_token: Session token for tab routing.
            timeout: Request timeout in seconds. Defaults to LONG_TIMEOUT
                for navigate/wait_for, DEFAULT_TIMEOUT for others. If
                ``params`` carries a tool ``timeout`` (milliseconds), the
                request waits at least that long plus TOOL_TIMEOUT_MARGIN.

        Returns:
            The raw server response dict (MCP ToolResponse format).

        Raises:
            RuntimeError: If the server returns an HTTP error.
            ConnectionError: If the server is not reachable.
        """
        if timeout is None:
            timeout = LONG_TIMEOUT if name in _LONG_TIMEOUT_TOOLS else DEFAULT_TIMEOUT
        tool_timeout_ms = params.get("timeout")
        if isinstance(tool_timeout_ms, (int, float)):
            timeout = max(timeout, tool_timeout_ms / 1000 + TOOL_TIMEOUT_MARGIN)

        return self._post(
            f"/tool/{name}",
            params,
            session_token=session_token,
            timeout=timeout,
        )

    # ------------------------------------------------------------------
    # HTTP internals
    # ------------------------------------------------------------------

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        session_token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> dict[str, Any]:
        """Send a POST request to the Script API server.

        Args:
            path: URL path (e.g. "/session/create").
            payload: JSON body.
            session_token: Optional session token for X-Session header.
            timeout: Request timeout in seconds.

        Returns:
            Parsed JSON response as dict.

        Raises:
            RuntimeError: On HTTP 4xx/5xx errors.
            ConnectionError: If the server is not reachable.
        """
        url = f"{self._base_url}{path}"
        body = json.dumps(payload).encode("utf-8")

        headers: dict[str, str] = {"Content-Type": "application/json"}
        token = self._resolve_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if session_token:
            headers["X-Session"] = session_token

        req = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode("utf-8")
            except Exception:
                pass
            raise RuntimeError(
                f"Script API error (HTTP {e.code}): {error_body}"
            ) from e
        except urllib.error.URLError as e:
            raise ConnectionError(
                f"Server not reachable at {url} — was it stopped? ({e.reason})"
            ) from e

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the client and terminate any auto-started server."""
        if self._closed:
            return
        self._closed = True
        self._shutdown_server()

    def __enter__(self) -> ScriptApiClient:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        self.close()
        return False
