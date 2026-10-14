"""Retrieval tool for accessing stashed (L1) content.

Registered automatically when the ContextManager has storage configured.
"""

from __future__ import annotations

import base64
import difflib
import json
import logging
from typing import TYPE_CHECKING, Any

from ..storage.search.keyword import token_overlap_score, tokenize
from ..tools.tools import PythonAgentTool
from ..types.tools import ToolResult, ToolResultContent, ToolResultStatus, ToolSpec
from ..vended_plugins.context_offloader.search import _format_lines, _search_content, _truncate
from .methods.truncate import CHARS_PER_TOKEN

if TYPE_CHECKING:
    from ..types.content import Message
    from .stash import Stash

logger = logging.getLogger(__name__)

RETRIEVAL_TOOL_NAME = "retrieve_context"

_DEFAULT_MAX_RESULT_TOKENS = 10_000

_MAX_QUERY_RESULTS = 5
_SNIPPET_LINES = 3
_SNIPPET_LINE_CHARS = 200
_MAX_LISTED_REFS = 20


_MEDIA_KEYS = frozenset({"image", "document"})


def _restore_media(data: dict[str, Any]) -> ToolResultContent | None:
    """Reconstruct a media ToolResultContent from stash data, or None if not media."""
    for key in _MEDIA_KEYS:
        if key in data:
            media = data[key]
            source = media.get("source", {})
            if isinstance(source.get("bytes"), str):
                media = {**media, "source": {**source, "bytes": base64.b64decode(source["bytes"])}}
            return ToolResultContent(**{key: media})  # type: ignore[misc]
    return None


def _extract_text(data: object) -> str | None:
    """Extract searchable text from decoded stash data."""
    if isinstance(data, str):
        return data
    if isinstance(data, dict):
        text = data.get("text")
        if isinstance(text, str):
            return text
        json_val = data.get("json")
        if json_val is not None:
            return json.dumps(json_val, indent=2)
    return None


def _text_result(tool_use_id: str, text: str, status: ToolResultStatus = "success") -> ToolResult:
    return ToolResult(toolUseId=tool_use_id, status=status, content=[ToolResultContent(text=text)])


def _clip_line(line: str, query_tokens: set[str]) -> str:
    """Clip a long line to a window centered on the first query-token hit."""
    if len(line) <= _SNIPPET_LINE_CHARS:
        return line
    lowered = line.lower()
    hit = min((position for token in query_tokens if (position := lowered.find(token)) >= 0), default=0)
    start = max(0, hit - _SNIPPET_LINE_CHARS // 2)
    end = start + _SNIPPET_LINE_CHARS
    return ("..." if start > 0 else "") + line[start:end] + ("..." if end < len(line) else "")


def _describe_match(reference: str, entry: object, query_tokens: set[str]) -> str:
    """Format one search hit as a ref header plus its best-matching lines."""
    text = _extract_text(entry)
    if text is None:
        kind = next((key for key in _MEDIA_KEYS if isinstance(entry, dict) and key in entry), "non-text")
        return f"ref: {reference} ({kind} content)"

    lines = text.split("\n")
    line_noun = "line" if len(lines) == 1 else "lines"
    header = f"ref: {reference} ({len(lines):,} {line_noun}, ~{len(text) // CHARS_PER_TOKEN:,} tokens)"
    scores = [token_overlap_score(query_tokens, line) for line in lines]
    best = sorted((index for index, score in enumerate(scores) if score > 0), key=lambda index: -scores[index])
    indices = sorted(best[:_SNIPPET_LINES]) or list(range(min(_SNIPPET_LINES, len(lines))))
    for index in indices:
        lines[index] = _clip_line(lines[index], query_tokens)
    return f"{header}\n{_format_lines(lines, indices, set(best))}"


async def _search_stash(stash: Stash, query: str, max_chars: int) -> str:
    """Rank stashed entries against a query and format the top hits with snippets."""
    matches = await stash.search(query, limit=_MAX_QUERY_RESULTS)
    logger.debug("query=<%s>, results=<%d> | searched stash", query, len(matches))
    if not matches:
        return f"No stashed content matches query '{query}'."

    query_tokens = tokenize(query)
    sections = [_describe_match(reference, entry, query_tokens) for reference, entry in matches]
    noun = "match" if len(matches) == 1 else "matches"
    header = f"[{len(matches)} {noun} for '{query}'; pass a ref with pattern or line_range to read more]"
    return _truncate(f"{header}\n\n" + "\n\n".join(sections), max_chars, "output truncated, narrow your query")


async def _not_found_message(stash: Stash, reference: str) -> str:
    """Build a not-found error that lists the closest existing refs."""
    keys = await stash.list()
    if not keys:
        return f"Error: reference not found: {reference}. Nothing has been stashed yet."

    guidance = "Pass a ref exactly as it appears in a placeholder, or search with query."
    ranked = sorted(keys, key=lambda key: -difflib.SequenceMatcher(None, reference, key).ratio())
    listed = ", ".join(ranked[:_MAX_LISTED_REFS])
    more = f" (and {len(keys) - _MAX_LISTED_REFS} more)" if len(keys) > _MAX_LISTED_REFS else ""
    return f"Error: reference not found: {reference}. Available references: {listed}{more}. {guidance}"


def _non_text_result(tool_use_id: str, entry: object, max_chars: int) -> ToolResult:
    """Return media as a native content block, or anything else as capped JSON."""
    media = _restore_media(entry) if isinstance(entry, dict) else None
    if media is not None:
        return ToolResult(toolUseId=tool_use_id, status="success", content=[media])
    full_text = json.dumps(entry)
    if len(full_text) > max_chars:
        full_text = full_text[:max_chars] + "\n\n[truncated]"
    return _text_result(tool_use_id, full_text)


async def _read_reference(stash: Stash, tool_use_id: str, inputs: dict[str, Any], max_chars: int) -> ToolResult:
    """Read one stashed entry, whole or narrowed by pattern or line_range."""
    reference: str = inputs["reference"]
    pattern: str | None = inputs.get("pattern")
    line_range: dict[str, int] | None = inputs.get("line_range")
    context_lines: int | None = inputs.get("context_lines")

    entry = await stash.retrieve(reference)
    if entry is None:
        return _text_result(tool_use_id, await _not_found_message(stash, reference), "error")

    text_content = _extract_text(entry)
    if text_content is None and pattern is None and line_range is None:
        return _non_text_result(tool_use_id, entry, max_chars)
    if text_content is None:
        text = "Error: cannot search non-text content. Omit pattern/line_range to retrieve full content."
        return _text_result(tool_use_id, text, "error")

    line_range_pair: tuple[int, int] | None = None
    if line_range is not None:
        try:
            line_range_pair = (int(line_range["start"]), int(line_range["end"]))
        except (KeyError, TypeError, ValueError) as error:
            return _text_result(tool_use_id, f"Error: invalid line_range: {error}", "error")

    try:
        search_result = _search_content(
            text_content,
            pattern=pattern,
            line_range=line_range_pair,
            context_lines=context_lines if context_lines is not None else 5,
            max_chars=max_chars,
        )
    except ValueError as error:
        return _text_result(tool_use_id, str(error), "error")
    return _text_result(tool_use_id, search_result)


def _create_retrieval_tool(stash: Stash, max_result_tokens: int | None = None) -> PythonAgentTool:
    """Create the ``retrieve_context`` tool backed by the given stash."""
    max_chars = (max_result_tokens or _DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

    async def _invoke(tool_use: dict[str, Any], **kwargs: Any) -> ToolResult:
        tool_use_id = tool_use["toolUseId"]
        inputs = tool_use.get("input", {})
        if inputs.get("reference"):
            return await _read_reference(stash, tool_use_id, inputs, max_chars)
        query: str | None = inputs.get("query")
        if query:
            return _text_result(tool_use_id, await _search_stash(stash, query, max_chars))
        return _text_result(tool_use_id, "Error: provide a reference or a query.", "error")

    _invoke.__name__ = RETRIEVAL_TOOL_NAME

    tool_spec = ToolSpec(
        name=RETRIEVAL_TOOL_NAME,
        description=(
            "Retrieve content that was offloaded from context.\n\n"
            "Content is stashed before it is offloaded. Placeholders for offloaded blocks carry a ref, "
            'such as "[Dropped] [ref: tooluse_abc123_0]". Placeholders for removed messages carry no ref, '
            'such as "[Dropped: 4 messages] [stashed: search by query]"; find those originals with query.\n\n'
            "Options:\n"
            "  - query: keywords to search all stashed content; returns matching refs with snippets. "
            "Results can include content that is still in context.\n"
            "  - reference: read one stashed entry as numbered lines, truncated when large\n"
            "  - reference + pattern: regex/keyword to find matching lines with context\n"
            "  - reference + line_range: { start, end } to read a specific span\n\n"
            "Examples:\n"
            '  { query: "IAM permission denied" }\n'
            '  { reference: "tooluse_abc123_0", pattern: "error" }\n'
            '  { reference: "tooluse_abc123_0", line_range: { start: 10, end: 25 } }\n'
            '  { reference: "tooluse_abc123_0" }'
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "description": "A ref exactly as it appears in a placeholder or query result.",
                },
                "query": {
                    "type": "string",
                    "description": "Keywords to search all stashed content. Ignored when reference is set.",
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex or keyword to grep for within the reference. Returns matching lines.",
                },
                "line_range": {
                    "type": "object",
                    "description": "Line range to extract from the reference (1-indexed, inclusive).",
                    "properties": {
                        "start": {"type": "integer", "minimum": 1, "description": "First line to return."},
                        "end": {"type": "integer", "minimum": 1, "description": "Last line to return."},
                    },
                    "required": ["start", "end"],
                },
                "context_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Lines of context around each match (default: 5).",
                },
            },
        },
    )

    return PythonAgentTool(
        tool_name=RETRIEVAL_TOOL_NAME,
        tool_spec=tool_spec,
        tool_func=_invoke,
    )


def _track_retrieval_tool_use_ids(message: Message, skip_set: set[str]) -> None:
    """Track tool-use IDs from retrieve_context calls for loop prevention."""
    if message.get("role") != "assistant":
        return
    for block in message.get("content", []):
        if "toolUse" in block and block["toolUse"].get("name") == RETRIEVAL_TOOL_NAME:
            skip_set.add(block["toolUse"]["toolUseId"])
