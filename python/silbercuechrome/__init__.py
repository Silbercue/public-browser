"""SilbercueChrome — Python client for Chrome browser automation.

v2: Uses the SilbercueChrome Script API server (HTTP on port 9223).
All browser automation logic runs server-side for maximum quality.

CdpClient and CdpError are re-exported for backward compatibility
and for the cdp.py escape hatch (Story 9.9).
"""

from silbercuechrome.cdp import CdpClient, CdpError
from silbercuechrome.chrome import Chrome
from silbercuechrome.client import ScriptApiClient
from silbercuechrome.escape_hatch import CdpEscapeHatch
from silbercuechrome.page import Page

__version__ = "1.0.0"
__all__ = [
    "Chrome",
    "Page",
    "ScriptApiClient",
    "CdpClient",
    "CdpError",
    "CdpEscapeHatch",
]
