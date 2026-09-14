"""Sandbox-routed file tools for reading, writing, and editing files.

Three separate tools — ``read``, ``write``, ``edit`` — each exposed as its own
tool so the model can call them directly by name.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import read, write, edit

    agent = Agent(tools=[read, write, edit])
    ```
"""

from .file_tools import edit, make_edit, make_read, make_write, read, write

__all__ = [
    "edit",
    "make_edit",
    "make_read",
    "make_write",
    "read",
    "write",
]
