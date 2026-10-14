"""Tests for the retrieve_context tool."""

import json

import pytest

from strands._context_manager.retrieval_tool import (
    RETRIEVAL_TOOL_NAME,
    _create_retrieval_tool,
    _extract_text,
    _track_retrieval_tool_use_ids,
)
from strands._context_manager.stash import Stash
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolUse


@pytest.fixture
def stash():
    return Stash(InMemoryStorage(), "test-session", "test-agent")


async def _store_text(stash, text):
    data = json.dumps({"text": text}).encode("utf-8")
    return await stash.store("tool-1", 0, data)


class TestRetrievalTool:
    """Tests for the retrieve_context tool."""

    def test_has_correct_name(self, stash):
        tool = _create_retrieval_tool(stash)
        assert tool.tool_name == RETRIEVAL_TOOL_NAME

    @pytest.mark.asyncio
    async def test_retrieves_full_content(self, stash):
        ref = await _store_text(stash, "hello world\nline two")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result == {
            "toolUseId": "t1",
            "status": "success",
            "content": [{"text": "[Lines 1-2 of 2]\n\n  1| hello world\n  2| line two"}],
        }

    @pytest.mark.asyncio
    async def test_searches_with_pattern(self, stash):
        lines = "\n".join(f"line {i}: {'ERROR' if i % 3 == 0 else 'ok'}" for i in range(1, 21))
        ref = await _store_text(stash, lines)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "pattern": "ERROR"}})
        assert result["status"] == "success"
        assert "match" in result["content"][0]["text"].lower()

    @pytest.mark.asyncio
    async def test_returns_line_range(self, stash):
        lines = "\n".join(f"line {i}" for i in range(1, 11))
        ref = await _store_text(stash, lines)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": 3, "end": 5}}}
        )
        assert result["status"] == "success"
        text = result["content"][0]["text"]
        assert "line 3" in text
        assert "line 5" in text

    @pytest.mark.asyncio
    async def test_returns_error_for_unknown_reference(self, stash):
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": "nonexistent"}})
        assert result["status"] == "error"
        assert result["content"][0]["text"] == "Error: reference not found: nonexistent. Nothing has been stashed yet."

    @pytest.mark.asyncio
    async def test_unknown_reference_lists_closest_refs_first(self, stash):
        for tool_use_id in ("tooluse_zzz", "tooluse_abc", "other"):
            await stash.store(tool_use_id, 0, json.dumps({"text": "x"}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": "tooluse_abc"}})
        assert result["status"] == "error"
        assert result["content"][0]["text"] == (
            "Error: reference not found: tooluse_abc. "
            "Available references: tooluse_abc_0, tooluse_zzz_0, other_0. "
            "Pass a ref exactly as it appears in a placeholder, or search with query."
        )

    @pytest.mark.asyncio
    async def test_unknown_reference_caps_listed_refs(self, stash):
        for index in range(25):
            await stash.store(f"tool-{index}", 0, json.dumps({"text": "x"}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": "missing"}})
        assert "(and 5 more)" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_error_without_reference_or_query(self, stash):
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {}})
        assert result == {
            "toolUseId": "t1",
            "status": "error",
            "content": [{"text": "Error: provide a reference or a query."}],
        }

    @pytest.mark.asyncio
    async def test_reference_takes_precedence_over_query(self, stash):
        ref = await _store_text(stash, "hello world")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "query": "unrelated"}})
        assert result["content"][0]["text"] == "[Lines 1-1 of 1]\n\n  1| hello world"

    def test_reference_is_optional_in_schema(self, stash):
        tool = _create_retrieval_tool(stash)
        schema = tool.tool_spec["inputSchema"]
        assert "required" not in schema
        assert "query" in schema["properties"]

    @pytest.mark.asyncio
    async def test_retrieves_json_content(self, stash):
        data = json.dumps({"json": {"key": "value"}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert result["content"][0]["text"] == '[Lines 1-3 of 3]\n\n  1| {\n  2|   "key": "value"\n  3| }'

    @pytest.mark.asyncio
    async def test_returns_error_for_non_text_content_with_pattern(self, stash):
        data = json.dumps({"image": {"format": "png", "source": "bytes"}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "pattern": "foo"}})
        assert result["status"] == "error"
        assert "cannot search non-text content" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_error_for_invalid_line_range(self, stash):
        ref = await _store_text(stash, "line 1\nline 2\nline 3")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": 100, "end": 5}}}
        )
        assert result["status"] == "error"


class TestExtractText:
    """Tests for _extract_text helper."""

    def test_extracts_string(self):
        assert _extract_text("hello") == "hello"

    def test_extracts_text_field(self):
        assert _extract_text({"text": "hello"}) == "hello"

    def test_extracts_json_field(self):
        result = _extract_text({"json": {"key": "val"}})
        assert result is not None
        assert "key" in result

    def test_returns_none_for_non_text(self):
        assert _extract_text({"image": "data"}) is None

    def test_returns_none_for_non_dict(self):
        assert _extract_text(42) is None


class TestFullTextTruncation:
    """Tests for full-content retrieval truncation."""

    @pytest.mark.asyncio
    async def test_truncates_large_full_content(self, stash):
        ref = await _store_text(stash, "x" * 50_000)
        tool = _create_retrieval_tool(stash, max_result_tokens=10)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        text = result["content"][0]["text"]
        assert text.startswith("[Lines 1-1 of 1]")
        assert text.endswith("\n\n[output truncated, narrow your range]")

    @pytest.mark.asyncio
    async def test_truncates_unrecognized_content_as_json(self, stash):
        data = json.dumps({"video": {"format": "mp4", "source": {"bytes": "x" * 50_000}}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash, max_result_tokens=10)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert result["content"][0]["text"].endswith("\n\n[truncated]")


class TestMediaBlockRetrieval:
    """Tests for media block retrieval (image/document/video)."""

    @pytest.mark.asyncio
    async def test_restores_image_block(self, stash):
        data = json.dumps({"image": {"format": "png", "source": {"bytes": "UE5HX0RBVEE="}}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "image" in result["content"][0]
        assert result["content"][0]["image"]["format"] == "png"
        assert result["content"][0]["image"]["source"]["bytes"] == b"PNG_DATA"

    @pytest.mark.asyncio
    async def test_restores_document_block(self, stash):
        data = json.dumps({"document": {"format": "pdf", "source": {"bytes": "UERGX0RBVEE="}}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "document" in result["content"][0]
        assert result["content"][0]["document"]["format"] == "pdf"
        assert result["content"][0]["document"]["source"]["bytes"] == b"PDF_DATA"

    @pytest.mark.asyncio
    async def test_returns_text_content_normally(self, stash):
        ref = await _store_text(stash, "hello world")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "hello world" in result["content"][0]["text"]


class TestQuerySearch:
    """Tests for relevance search across the stash."""

    @pytest.mark.asyncio
    async def test_returns_matching_refs_with_snippets(self, stash):
        deploy_log = "\n".join(["build ok", "deploy started", "IAM permission denied for role", "rollback"])
        await stash.store("tooluse_deploy", 0, json.dumps({"text": deploy_log}).encode("utf-8"))
        await stash.store("tooluse_weather", 0, json.dumps({"text": "sunny and warm"}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)

        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "IAM permission"}})

        assert result == {
            "toolUseId": "t1",
            "status": "success",
            "content": [
                {
                    "text": (
                        "[1 match for 'IAM permission'; pass a ref with pattern or line_range to read more]\n\n"
                        "ref: tooluse_deploy_0 (4 lines, ~15 tokens)\n"
                        "> 3| IAM permission denied for role"
                    )
                }
            ],
        }

    @pytest.mark.asyncio
    async def test_ranks_best_match_first(self, stash):
        await stash.store("weak", 0, json.dumps({"text": "timeout"}).encode("utf-8"))
        await stash.store("strong", 0, json.dumps({"text": "database timeout error"}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "database timeout"}})
        text = result["content"][0]["text"]
        assert text.index("ref: strong_0 (1 line, ~5 tokens)") < text.index("ref: weak_0 (1 line, ~1 tokens)")

    @pytest.mark.asyncio
    async def test_snippet_shows_best_lines_in_document_order(self, stash):
        lines = ["alpha", "error one", "noise", "error two timeout", "noise", "error three timeout disk", "end"]
        await stash.store("log", 0, json.dumps({"text": "\n".join(lines)}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "error timeout disk"}})
        snippet = result["content"][0]["text"].split("\n", 3)[3]
        assert snippet == "> 2| error one\n---\n> 4| error two timeout\n---\n> 6| error three timeout disk"

    @pytest.mark.asyncio
    async def test_clips_long_lines_around_the_hit(self, stash):
        line = "a" * 1_000 + " needle " + "b" * 1_000
        await stash.store("blob", 0, json.dumps({"text": line}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "needle"}})
        snippet_line = result["content"][0]["text"].split("\n")[-1]
        assert "needle" in snippet_line
        assert snippet_line.startswith("> 1| ...")
        assert snippet_line.endswith("...")
        assert len(snippet_line) < 250

    @pytest.mark.asyncio
    async def test_describes_media_matches_without_snippet(self, stash):
        data = json.dumps({"image": {"format": "png", "source": {"bytes": "UE5H"}}}).encode("utf-8")
        await stash.store("screenshot", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "png"}})
        assert result["content"][0]["text"].endswith("ref: screenshot_0 (image content)")

    @pytest.mark.asyncio
    async def test_caps_number_of_results(self, stash):
        for index in range(8):
            await stash.store(f"tool-{index}", 0, json.dumps({"text": "shared term"}).encode("utf-8"))
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "shared"}})
        assert result["content"][0]["text"].count("ref: ") == 5

    @pytest.mark.asyncio
    async def test_reports_no_matches(self, stash):
        await _store_text(stash, "hello world")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"query": "kubernetes"}})
        assert result == {
            "toolUseId": "t1",
            "status": "success",
            "content": [{"text": "No stashed content matches query 'kubernetes'."}],
        }


class TestInvalidLineRange:
    """Tests for malformed line_range input."""

    @pytest.mark.asyncio
    async def test_returns_error_for_missing_start_key(self, stash):
        ref = await _store_text(stash, "line 1\nline 2")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "line_range": {"end": 2}}})
        assert result["status"] == "error"
        assert "invalid line_range" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_error_for_non_numeric_values(self, stash):
        ref = await _store_text(stash, "line 1\nline 2")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": "abc", "end": 2}}}
        )
        assert result["status"] == "error"
        assert "invalid line_range" in result["content"][0]["text"]


class TestTrackRetrievalToolUseIds:
    """Tests for _track_retrieval_tool_use_ids."""

    def test_tracks_retrieve_context_tool_use_ids(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[
                ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name=RETRIEVAL_TOOL_NAME, input={})),
            ],
        )
        _track_retrieval_tool_use_ids(message, skip_set)
        assert "tu-ret" in skip_set

    def test_ignores_non_retrieval_tool_uses(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[
                ContentBlock(toolUse=ToolUse(toolUseId="tu-other", name="bash", input={})),
            ],
        )
        _track_retrieval_tool_use_ids(message, skip_set)
        assert len(skip_set) == 0

    def test_ignores_user_messages(self):
        skip_set: set[str] = set()
        message = Message(role="user", content=[ContentBlock(text="hello")])
        _track_retrieval_tool_use_ids(message, skip_set)
        assert len(skip_set) == 0
