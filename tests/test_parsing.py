"""Tests for backend.parsing — canonical contract normalization."""
from __future__ import annotations

import json
import pytest

from backend.parsing import (
    _normalize_one,
    extract_json_text,
    parse_llm_suggestions,
    strip_markdown_fences,
)


# ---------------------------------------------------------------------------
# strip_markdown_fences
# ---------------------------------------------------------------------------

class TestStripMarkdownFences:
    def test_no_fence_unchanged(self):
        assert strip_markdown_fences('{"a": 1}') == '{"a": 1}'

    def test_bare_backtick_fence_stripped(self):
        raw = "```\n{}\n```"
        assert strip_markdown_fences(raw) == "{}"

    def test_language_tagged_fence_stripped(self):
        raw = "```json\n{}\n```"
        assert strip_markdown_fences(raw) == "{}"

    def test_empty_string(self):
        assert strip_markdown_fences("") == ""

    def test_whitespace_only(self):
        assert strip_markdown_fences("   ") == ""


# ---------------------------------------------------------------------------
# extract_json_text
# ---------------------------------------------------------------------------

class TestExtractJsonText:
    def test_plain_object(self):
        text = '{"suggestions": []}'
        assert extract_json_text(text) == '{"suggestions": []}'

    def test_object_inside_prose(self):
        text = 'Here is my output: {"suggestions": []} done'
        result = extract_json_text(text)
        assert result == '{"suggestions": []}'

    def test_array_wrapped_into_object(self):
        text = "[1, 2, 3]"
        result = extract_json_text(text)
        assert result == '{"suggestions": [1, 2, 3]}'

    def test_empty_input_returns_empty_object(self):
        assert extract_json_text("") == "{}"

    def test_fenced_json_extracted(self):
        text = "```json\n{\"suggestions\": []}\n```"
        result = extract_json_text(text)
        assert json.loads(result) == {"suggestions": []}


# ---------------------------------------------------------------------------
# _normalize_one
# ---------------------------------------------------------------------------

class TestNormalizeOne:
    def _valid_raw(self, **overrides):
        base = {
            "line": 5,
            "end_line": 7,
            "severity": "warning",
            "message": "Use a loop instead of repeated prints",
            "fix": {
                "before": "print(1)\nprint(2)\nprint(3)",
                "replacement": "for i in range(1, 4):\n    print(i)",
            },
        }
        base.update(overrides)
        return base

    def test_valid_suggestion_normalizes(self):
        result = _normalize_one(self._valid_raw())
        assert result is not None
        assert result["line"] == 5
        assert result["end_line"] == 7
        assert result["severity"] == "warning"
        assert result["fix"]["before"] == "print(1)\nprint(2)\nprint(3)"
        assert result["fix"]["replacement"].startswith("for i")
        assert result["fix"]["startLine"] == 5
        assert result["fix"]["endLine"] == 7
        assert result["source"] == "ai"

    def test_missing_before_drops_suggestion(self):
        raw = self._valid_raw()
        raw["fix"]["before"] = ""
        assert _normalize_one(raw) is None

    def test_whitespace_only_before_drops_suggestion(self):
        raw = self._valid_raw()
        raw["fix"]["before"] = "   \n  "
        assert _normalize_one(raw) is None

    def test_missing_replacement_drops_suggestion(self):
        raw = self._valid_raw()
        raw["fix"]["replacement"] = ""
        assert _normalize_one(raw) is None

    def test_whitespace_only_replacement_drops_suggestion(self):
        raw = self._valid_raw()
        raw["fix"]["replacement"] = "   "
        assert _normalize_one(raw) is None

    def test_no_fix_dict_drops_suggestion(self):
        raw = self._valid_raw()
        del raw["fix"]
        assert _normalize_one(raw) is None

    def test_severity_normalized_to_info_when_unknown(self):
        raw = self._valid_raw()
        raw["severity"] = "critical"
        result = _normalize_one(raw)
        assert result is not None
        assert result["severity"] == "info"

    def test_severity_error_preserved(self):
        raw = self._valid_raw(severity="error")
        result = _normalize_one(raw)
        assert result is not None
        assert result["severity"] == "error"

    def test_end_line_corrected_when_before_start(self):
        raw = self._valid_raw()
        raw["line"] = 10
        raw["end_line"] = 8  # invalid: before start
        result = _normalize_one(raw)
        assert result is not None
        assert result["end_line"] >= result["line"]

    def test_startline_falls_back_to_top_level_line(self):
        """When fix has no startLine, use the top-level line field."""
        raw = self._valid_raw()
        raw["line"] = 3
        raw["end_line"] = 5
        # fix has no startLine/endLine
        result = _normalize_one(raw)
        assert result is not None
        assert result["fix"]["startLine"] == 3
        assert result["fix"]["endLine"] == 5

    def test_explicit_startline_in_fix_takes_precedence(self):
        raw = self._valid_raw()
        raw["fix"]["startLine"] = 9
        raw["fix"]["endLine"] = 11
        result = _normalize_one(raw)
        assert result is not None
        assert result["fix"]["startLine"] == 9
        assert result["fix"]["endLine"] == 11

    def test_missing_message_uses_default(self):
        raw = self._valid_raw()
        raw["message"] = ""
        result = _normalize_one(raw)
        assert result is not None
        assert result["message"] == "Potential issue detected."

    def test_no_col_fields_in_output(self):
        """Verify that removed column fields are not present in output."""
        result = _normalize_one(self._valid_raw())
        assert result is not None
        assert "col" not in result
        assert "end_col" not in result
        assert "startCol" not in result
        assert "endCol" not in result
        fix = result["fix"]
        assert "range" not in fix
        assert "startCol" not in fix
        assert "endCol" not in fix


# ---------------------------------------------------------------------------
# parse_llm_suggestions (integration)
# ---------------------------------------------------------------------------

class TestParseLlmSuggestions:
    def _wrap(self, suggestions: list) -> str:
        return json.dumps({"suggestions": suggestions})

    def _valid_item(self):
        return {
            "line": 1,
            "end_line": 2,
            "severity": "warning",
            "message": "Off-by-one error",
            "fix": {
                "before": "for i in range(n + 1):",
                "replacement": "for i in range(n):",
            },
            "source": "ai",
        }

    def test_valid_suggestions_parsed(self):
        raw = self._wrap([self._valid_item()])
        result = parse_llm_suggestions(raw)
        assert len(result) == 1
        assert result[0]["message"] == "Off-by-one error"

    def test_empty_suggestions_array(self):
        assert parse_llm_suggestions('{"suggestions": []}') == []

    def test_invalid_json_returns_empty(self):
        assert parse_llm_suggestions("not json at all") == []

    def test_item_without_before_filtered(self):
        item = self._valid_item()
        item["fix"]["before"] = ""
        result = parse_llm_suggestions(self._wrap([item]))
        assert result == []

    def test_item_without_replacement_filtered(self):
        item = self._valid_item()
        item["fix"]["replacement"] = ""
        result = parse_llm_suggestions(self._wrap([item]))
        assert result == []

    def test_mixed_valid_and_invalid_items(self):
        valid = self._valid_item()
        invalid = self._valid_item()
        invalid["fix"]["before"] = ""
        result = parse_llm_suggestions(self._wrap([valid, invalid]))
        assert len(result) == 1

    def test_markdown_fenced_json_parsed(self):
        raw = "```json\n" + self._wrap([self._valid_item()]) + "\n```"
        result = parse_llm_suggestions(raw)
        assert len(result) == 1

    def test_multiple_valid_suggestions(self):
        item1 = self._valid_item()
        item2 = self._valid_item()
        item2["message"] = "Missing None check"
        item2["fix"]["before"] = "return x.value"
        item2["fix"]["replacement"] = "return x.value if x else None"
        result = parse_llm_suggestions(self._wrap([item1, item2]))
        assert len(result) == 2

    def test_non_list_suggestions_field_returns_empty(self):
        result = parse_llm_suggestions('{"suggestions": "not a list"}')
        assert result == []

    def test_old_nested_range_not_accepted(self):
        """Old fix.range.startLine shape is no longer supported — suggestion dropped."""
        item = {
            "line": 1,
            "end_line": 3,
            "severity": "warning",
            "message": "Some issue",
            "fix": {
                # Old nested range shape — no before/replacement at top level
                "range": {"startLine": 1, "endLine": 3, "startCol": 0, "endCol": 10},
                "replacement": "new code",
            },
        }
        # No 'before' field → should be dropped
        result = parse_llm_suggestions(self._wrap([item]))
        assert result == []
