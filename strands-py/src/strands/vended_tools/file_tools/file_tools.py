"""Sandbox-routed file tools: ``read``, ``write``, ``edit``.

Three separate tools for reading, writing, and editing files through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.

Unlike :mod:`~strands.vended_tools.file_editor`, which bundles four operations
behind a single ``command`` parameter, these tools expose each operation as its
own tool so the model can call them directly by name.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...tools.decorator import tool
from ...types.media import DocumentFormat, ImageFormat
from ...types.tools import ToolContext, ToolResult

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_READ_DEFAULT_LIMIT = 2000
_IMAGE_FORMATS: dict[str, ImageFormat] = {
    "png": "png",
    "jpg": "jpeg",
    "jpeg": "jpeg",
    "gif": "gif",
    "webp": "webp",
}
_DOCUMENT_FORMATS: tuple[DocumentFormat, ...] = ("pdf", "doc", "docx", "xls", "xlsx")


def _validate_path(path: str) -> None:
    """Validate that a path is absolute and contains no directory traversal.

    Args:
        path: The path to validate.

    Raises:
        ValueError: If the path is not absolute or contains a ``..`` segment.
    """
    if not path.startswith("/"):
        raise ValueError(f"The path {path} is not absolute; it should start with '/'.")
    if ".." in re.split(r"[/\\]", path):
        raise ValueError("Invalid path: path traversal is not allowed.")


def _number_lines(content: str, start: int) -> str:
    """Number each line of content starting from the given line number.

    Args:
        content: Text content to number.
        start: The 1-indexed line number for the first line.

    Returns:
        Content with each line prefixed by its right-aligned line number and a tab.
    """
    return "\n".join(f"{index + start:>6}\t{line}" for index, line in enumerate(content.split("\n")))


def _extension(path: str) -> str:
    """Extract the lowercase file extension from a path.

    Args:
        path: The file path.

    Returns:
        The lowercase extension without the dot, or an empty string if none.
    """
    name = re.split(r"[/\\]", path)[-1]
    return name.rpartition(".")[2].lower() if "." in name else ""


def _document_name(path: str) -> str:
    """Derive a safe document name from a file path for the document content block.

    Args:
        path: The file path.

    Returns:
        A sanitized document name suitable for the ``name`` field of a document content block.
    """
    name = re.split(r"[/\\]", path)[-1]
    name = re.sub(r"[^a-zA-Z0-9\s\-()\[\]]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name or "document"


# ---------------------------------------------------------------------------
# Tool factories
# ---------------------------------------------------------------------------


def make_read(
    *,
    sandbox: Sandbox | None = None,
    name: str = "read",
    description: str = ("Read a file. Text returns numbered lines; images and binary documents return viewable media."),
) -> DecoratedFunctionTool:
    """Create a sandbox-routed file read tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"read"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that reads files through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def read_tool(
        path: str, tool_context: ToolContext, offset: int | None = None, limit: int | None = None
    ) -> str | ToolResult:
        """Read a file. Text returns numbered lines; images and binary documents return viewable media.

        Args:
            path: Absolute path to the file.
            tool_context: Injected by the framework. Not user-facing.
            offset: 1-indexed line to start from. Defaults to the first line. Text files only.
            limit: Maximum number of lines to return. Defaults to 2000. Text files only.
        """
        _validate_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        extension = _extension(path)

        if image_format := _IMAGE_FORMATS.get(extension):
            data = await active.read_file(path)
            image_result: ToolResult = {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"image": {"format": image_format, "source": {"bytes": data}}}],
            }
            return image_result

        if extension in _DOCUMENT_FORMATS:
            data = await active.read_file(path)
            document_result: ToolResult = {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [
                    {"document": {"format": extension, "name": _document_name(path), "source": {"bytes": data}}}
                ],
            }
            return document_result

        content = await active.read_text(path)
        lines = content.split("\n")
        start = max(0, (offset - 1) if offset else 0)
        count = limit if limit is not None else _READ_DEFAULT_LIMIT
        window = lines[start : start + count]
        if not window:
            return f"[File has {len(lines)} lines; offset {offset} is past the end.]"

        numbered = _number_lines("\n".join(window), start + 1)
        if start > 0 or start + count < len(lines):
            shown_end = start + len(window)
            numbered += f"\n[Showing lines {start + 1}-{shown_end} of {len(lines)}. Use offset/limit to read more.]"
        return numbered

    return read_tool


def make_write(
    *,
    sandbox: Sandbox | None = None,
    name: str = "write",
    description: str = "Write a file, creating it or overwriting it. Use ``edit`` for surgical changes.",
) -> DecoratedFunctionTool:
    """Create a sandbox-routed file write tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"write"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that writes files through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def write_tool(path: str, content: str, tool_context: ToolContext) -> str:
        """Write a file, creating it or overwriting it. Use ``edit`` for surgical changes.

        Args:
            path: Absolute path to the file.
            content: The full file content to write.
            tool_context: Injected by the framework. Not user-facing.
        """
        _validate_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        await active.write_text(path, content)
        line_count = 0 if content == "" else len(content.split("\n"))
        return f"Wrote {line_count} lines to {path}."

    return write_tool


def make_edit(
    *,
    sandbox: Sandbox | None = None,
    name: str = "edit",
    description: str = "Replace an exact string in a file. ``old_str`` must appear exactly once.",
) -> DecoratedFunctionTool:
    """Create a sandbox-routed file edit tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"edit"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that edits files through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def edit_tool(path: str, old_str: str, new_str: str, tool_context: ToolContext) -> str:
        """Replace an exact string in a file. ``old_str`` must appear exactly once.

        Args:
            path: Absolute path to the file.
            old_str: Exact text to find. Must be unique within the file.
            new_str: Replacement text.
            tool_context: Injected by the framework. Not user-facing.
        """
        _validate_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        content = await active.read_text(path)
        occurrences = content.count(old_str)
        if occurrences == 0:
            raise ValueError(f"old_str did not appear verbatim in {path}.")
        if occurrences > 1:
            raise ValueError(f"old_str appears {occurrences} times in {path}; make it unique.")
        await active.write_text(path, content.replace(old_str, new_str, 1))
        return f"Edited {path}."

    return edit_tool


# ---------------------------------------------------------------------------
# Default instances — read the sandbox from the agent at call time.
# ---------------------------------------------------------------------------

read = make_read()
"""Default sandbox-routed file read tool. Reads the sandbox from the agent's context at call time."""

write = make_write()
"""Default sandbox-routed file write tool. Reads the sandbox from the agent's context at call time."""

edit = make_edit()
"""Default sandbox-routed file edit tool. Reads the sandbox from the agent's context at call time."""
