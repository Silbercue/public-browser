"""Tests for response parsing helpers in page.py.

Tests the _extract_text, _check_error, _parse_evaluate_response, and
_parse_tool_response functions with realistic server response examples.
"""

from __future__ import annotations

import pytest

from publicbrowser.page import (
    _check_error,
    _extract_text,
    _parse_evaluate_response,
    _parse_tool_response,
)

# ---------------------------------------------------------------------------
# _extract_text Tests
# ---------------------------------------------------------------------------


class TestExtractText:
    """Test _extract_text helper."""

    def test_extracts_text_from_standard_response(self) -> None:
        """Extracts text from a standard MCP ToolResponse."""
        response = {
            "content": [{"type": "text", "text": "Navigation complete: https://example.com"}],
            "isError": False,
        }
        assert _extract_text(response) == "Navigation complete: https://example.com"

    def test_returns_empty_for_no_content(self) -> None:
        """Returns empty string when content is missing."""
        assert _extract_text({}) == ""
        assert _extract_text({"content": []}) == ""

    def test_returns_empty_for_content_without_text(self) -> None:
        """Returns empty string when content item has no text field."""
        assert _extract_text({"content": [{"type": "text"}]}) == ""

    def test_handles_multiple_content_items(self) -> None:
        """Plancheck P35: all text items count, joined by a newline — not only content[0]."""
        response = {
            "content": [
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"},
            ],
        }
        assert _extract_text(response) == "first\nsecond"

    def test_skips_non_text_items(self) -> None:
        """Plancheck P35: an image item (capture_image) in front does not hide the text."""
        response = {
            "content": [
                {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
                {"type": "text", "text": "Screenshot saved"},
            ],
        }
        assert _extract_text(response) == "Screenshot saved"

    def test_handles_non_list_content(self) -> None:
        """Returns empty string for non-list content."""
        assert _extract_text({"content": "invalid"}) == ""


# ---------------------------------------------------------------------------
# _check_error Tests
# ---------------------------------------------------------------------------


class TestCheckError:
    """Test _check_error helper."""

    def test_does_not_raise_on_success(self) -> None:
        """Does not raise when isError is False."""
        response = {
            "content": [{"type": "text", "text": "ok"}],
            "isError": False,
        }
        _check_error(response)  # Should not raise

    def test_does_not_raise_when_is_error_missing(self) -> None:
        """Does not raise when isError is not present."""
        _check_error({"content": []})  # Should not raise

    def test_raises_runtime_error_on_error(self) -> None:
        """Raises RuntimeError when isError is True."""
        response = {
            "content": [{"type": "text", "text": "Element not found: #missing"}],
            "isError": True,
        }
        with pytest.raises(RuntimeError, match="Element not found"):
            _check_error(response)

    def test_raises_with_unknown_message_for_empty_error(self) -> None:
        """Raises RuntimeError with default message when error text is empty."""
        response = {"content": [], "isError": True}
        with pytest.raises(RuntimeError, match="Unknown server error"):
            _check_error(response)


# ---------------------------------------------------------------------------
# _parse_evaluate_response Tests
# ---------------------------------------------------------------------------


class TestParseEvaluateResponse:
    """Test _parse_evaluate_response helper."""

    def test_parses_number(self) -> None:
        """Parses integer from text."""
        response = {"content": [{"type": "text", "text": "42"}], "isError": False}
        assert _parse_evaluate_response(response) == 42

    def test_parses_float(self) -> None:
        """Parses float from text."""
        response = {"content": [{"type": "text", "text": "3.14"}], "isError": False}
        assert _parse_evaluate_response(response) == 3.14

    def test_parses_string(self) -> None:
        """Parses JSON string from text."""
        response = {"content": [{"type": "text", "text": '"hello"'}], "isError": False}
        assert _parse_evaluate_response(response) == "hello"

    def test_parses_boolean_true(self) -> None:
        """Parses true from text."""
        response = {"content": [{"type": "text", "text": "true"}], "isError": False}
        assert _parse_evaluate_response(response) is True

    def test_parses_boolean_false(self) -> None:
        """Parses false from text."""
        response = {"content": [{"type": "text", "text": "false"}], "isError": False}
        assert _parse_evaluate_response(response) is False

    def test_parses_null(self) -> None:
        """Parses null to None."""
        response = {"content": [{"type": "text", "text": "null"}], "isError": False}
        assert _parse_evaluate_response(response) is None

    def test_parses_object(self) -> None:
        """Parses JSON object from text."""
        response = {
            "content": [{"type": "text", "text": '{"name": "test", "count": 5}'}],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == {"name": "test", "count": 5}

    def test_parses_array(self) -> None:
        """Parses JSON array from text."""
        response = {
            "content": [{"type": "text", "text": '[1, "two", 3]'}],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == [1, "two", 3]

    def test_returns_raw_string_for_non_json(self) -> None:
        """Returns raw string when JSON parsing fails."""
        response = {
            "content": [{"type": "text", "text": "This is just plain text"}],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == "This is just plain text"

    def test_returns_none_for_empty_text(self) -> None:
        """Returns None when text is empty."""
        response = {"content": [{"type": "text", "text": ""}], "isError": False}
        assert _parse_evaluate_response(response) is None

    def test_returns_none_for_no_content(self) -> None:
        """Returns None when content is empty."""
        response = {"content": [], "isError": False}
        assert _parse_evaluate_response(response) is None

    def test_parses_nested_object(self) -> None:
        """Parses nested JSON objects."""
        response = {
            "content": [
                {"type": "text", "text": '{"user": {"name": "Alice", "roles": ["admin"]}}'}
            ],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == {"user": {"name": "Alice", "roles": ["admin"]}}


# ---------------------------------------------------------------------------
# _parse_tool_response Tests
# ---------------------------------------------------------------------------


class TestParseToolResponse:
    """Test _parse_tool_response helper."""

    def test_returns_text_content(self) -> None:
        """Returns the text from a standard tool response."""
        response = {
            "content": [{"type": "text", "text": "Clicked element"}],
            "isError": False,
        }
        assert _parse_tool_response(response) == "Clicked element"

    def test_returns_empty_for_no_content(self) -> None:
        """Returns empty string when no content."""
        assert _parse_tool_response({"content": []}) == ""


# ---------------------------------------------------------------------------
# Real Server Response Examples
# ---------------------------------------------------------------------------


class TestRealServerResponses:
    """Test parsing with responses matching real SilbercueChrome server output."""

    def test_navigate_success(self) -> None:
        """Parse a real navigate success response."""
        response = {
            "content": [
                {"type": "text", "text": "Navigation complete: https://example.com (200)"}
            ],
            "isError": False,
        }
        _check_error(response)  # Should not raise
        text = _extract_text(response)
        assert "example.com" in text

    def test_click_success(self) -> None:
        """Parse a real click success response."""
        response = {
            "content": [
                {"type": "text", "text": "Clicked <button id=\"submit\">Submit</button>"}
            ],
            "isError": False,
        }
        _check_error(response)

    def test_click_not_found(self) -> None:
        """Parse a real click error (element not found)."""
        response = {
            "content": [
                {"type": "text", "text": "No element matches selector: #nonexistent"}
            ],
            "isError": True,
        }
        with pytest.raises(RuntimeError, match="No element matches"):
            _check_error(response)

    def test_evaluate_document_title(self) -> None:
        """Parse a real evaluate response for document.title."""
        response = {
            "content": [{"type": "text", "text": '"Example Domain"'}],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == "Example Domain"

    def test_evaluate_complex_object(self) -> None:
        """Parse a real evaluate response returning a complex object."""
        response = {
            "content": [
                {
                    "type": "text",
                    "text": '{"width": 1280, "height": 720, "devicePixelRatio": 2}',
                }
            ],
            "isError": False,
        }
        result = _parse_evaluate_response(response)
        assert result == {"width": 1280, "height": 720, "devicePixelRatio": 2}

    def test_wait_for_timeout(self) -> None:
        """Parse a real wait_for timeout response."""
        response = {
            "content": [
                {"type": "text", "text": "Timeout: condition not met within 30s"}
            ],
            "isError": True,
        }
        # This should trigger TimeoutError in wait_for (tested in test_page_v2.py)
        assert response["isError"] is True
        assert "timeout" in _extract_text(response).lower()

    def test_fill_form_success(self) -> None:
        """Parse a real fill_form success response."""
        response = {
            "content": [{"type": "text", "text": "Filled 3 fields"}],
            "isError": False,
        }
        _check_error(response)
        text = _extract_text(response)
        assert "Filled" in text


# ---------------------------------------------------------------------------
# Stufe 1 (E5): appended hints and added blocks are never part of the value
# ---------------------------------------------------------------------------

_TIP = (
    "\n\nTip: Reading .innerText/.textContent? The a11y tree already contains visible text."
    " Try view_page(ref: 'eN', filter: 'all') — table cells, static codes, paragraphs all"
    " show up with stable refs."
)
_WARNING = (
    "\n\nWarning: 3 consecutive querySelector-based evaluate calls detected. This usually"
    " means a ref went stale or a tool failed silently and you fell back to evaluate."
)
_NOTICE = (
    "\n\nNotice: 5 consecutive evaluate calls. Consider: navigate(url) for cross-page moves,"
    ' view_page(filter:"all") for exhaustive refs.'
)
_NOTE = "\n\nNote: 82 interactive elements are hidden (display: none)."


def _evaluate_response(*texts: str) -> dict:
    return {"content": [{"type": "text", "text": t} for t in texts], "isError": False}


class TestParseEvaluateResponseHints:
    """Stufe 1 (E5): only the raw value — no Tip/Note/Warning/Notice, no diff."""

    def test_strips_tip(self) -> None:
        """run3 #88: the export length came back with a Tip attached."""
        assert _parse_evaluate_response(_evaluate_response("4024" + _TIP)) == 4024

    def test_strips_warning(self) -> None:
        """Evaluate streak, tier 1."""
        assert _parse_evaluate_response(_evaluate_response('"PASS"' + _WARNING)) == "PASS"

    def test_strips_notice(self) -> None:
        """Evaluate streak, tier 2."""
        result = _parse_evaluate_response(_evaluate_response('{"a": 1}' + _NOTICE))
        assert result == {"a": 1}

    def test_strips_note(self) -> None:
        """A Note paragraph is cut like the other hints."""
        assert _parse_evaluate_response(_evaluate_response("true" + _NOTE)) is True

    def test_strips_several_hints_in_a_row(self) -> None:
        """run5 #60: tips and a warning after the needle."""
        text = '"NEEDLE-841JYJEE"' + _TIP + _TIP + _WARNING
        assert _parse_evaluate_response(_evaluate_response(text)) == "NEEDLE-841JYJEE"

    def test_skips_a_dom_diff_block_before_the_value(self) -> None:
        """A deferred click diff arrives as the first block of the next call."""
        diff = '--- Action Result (3 changes) — /page ---\n NEW    StaticText "PASS"'
        assert _parse_evaluate_response(_evaluate_response(diff, '"PASS"')) == "PASS"

    def test_skips_notices_after_the_value(self) -> None:
        """Dialog and relaunch notices are separate blocks after the value."""
        response = _evaluate_response(
            '"ok"',
            '[dialog] alert: "Saved"',
            "Note: Chrome was not reachable — Public Browser silently launched a fresh browser.",
        )
        assert _parse_evaluate_response(response) == "ok"

    def test_skips_a_download_notice_after_the_value(self) -> None:
        """A completed download is announced as a separate block after the value."""
        download = "--- Download completed ---\nFile: report.csv\nPath: /tmp/report.csv\nSize: 1 KB"
        assert _parse_evaluate_response(_evaluate_response('"ok"', download)) == "ok"

    def test_skips_the_pipe_fallback_warning(self) -> None:
        """Preflight V5: the pipe-fallback warning (Task 6) is its own block after the value."""
        warning = (
            'Public Browser: Chrome refused --remote-debugging-pipe for profile "Default" '
            "and was restarted with a random debugging port. While this Chrome runs, any local"
            " program can control the logged-in profile via 127.0.0.1:53211."
        )
        assert _parse_evaluate_response(_evaluate_response('"ok"', warning)) == "ok"

    def test_keeps_hint_words_inside_the_value(self) -> None:
        """Hint words inside a JSON value are part of the value."""
        assert _parse_evaluate_response(_evaluate_response('"Tip: none"')) == "Tip: none"
        result = _parse_evaluate_response(_evaluate_response('{"note": "Note: 5 left"}'))
        assert result == {"note": "Note: 5 left"}

    def test_joins_all_own_blocks_like_the_ts_parser(self) -> None:
        """Plancheck P35: all own blocks count, joined by a newline — as in extractResultValue."""
        response = _evaluate_response('"first"', '"second"' + _TIP)
        assert _parse_evaluate_response(response) == '"first"\n"second"'
