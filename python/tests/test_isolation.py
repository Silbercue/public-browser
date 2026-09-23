"""P19: the isolation helpers keep tests away from the developer's Chrome setup."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.conftest import (
    CHROME_ENV_VARS,
    FORBIDDEN_PORTS,
    apply_isolated_chrome_env,
    free_test_port,
)


def test_isolation_removes_real_profile_ports_and_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Values that point at a real profile, a real Chrome port or a real key are gone."""
    dangerous = {
        "PUBLIC_BROWSER_PROFILE": "/Users/x/Library/Application Support/Google/Chrome/Default",
        "SILBERCUE_CHROME_PROFILE": "Default",
        "SILBERCUE_CHROME_PORT": "9222",
        "PUBLIC_BROWSER_CHROME_PORT": "9223",
        "SILBERCUE_CHROME_HOST": "127.0.0.1",
        "PUBLIC_BROWSER_SCRIPT_PORT": "9223",
        "SILBERCUE_CHROME_AUTO_LAUNCH": "false",
        "PUBLIC_BROWSER_SCRIPT_TOKEN": "real-key",
        "PUBLIC_BROWSER_CORTEX_DIR": "/Users/x/.public-browser/cortex",
    }
    for name, value in dangerous.items():
        monkeypatch.setenv(name, value)

    ports = apply_isolated_chrome_env(monkeypatch, tmp_path)

    for name in CHROME_ENV_VARS:
        if name != "PUBLIC_BROWSER_CORTEX_DIR":
            assert name not in os.environ, name
    cortex = Path(os.environ["PUBLIC_BROWSER_CORTEX_DIR"])
    assert cortex.is_dir()
    assert tmp_path in cortex.parents
    assert set(ports) == {"cdp_port", "script_port"}
    assert ports["cdp_port"] != ports["script_port"]
    for port in ports.values():
        assert port >= 9340
        assert port not in FORBIDDEN_PORTS


def test_env_list_covers_profile_port_and_key_variables() -> None:
    """Every variable the server or the client reads to find Chrome, a profile or a key."""
    for name in (
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
    ):
        assert name in CHROME_ENV_VARS, name
    assert FORBIDDEN_PORTS == frozenset({9222, 9223, 9225, 9226, 9333})


def test_free_test_port_skips_forbidden_and_taken_ports() -> None:
    """Binding only probes the port; nothing connects to anything."""
    first = free_test_port()
    assert first >= 9340
    assert first not in FORBIDDEN_PORTS
    second = free_test_port(start=first, taken={first})
    assert second > first
    assert free_test_port(start=9333) >= 9334
