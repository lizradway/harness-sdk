"""Todos plugin for Strands Agents — a structured task list the agent maintains for multi-step work.

The plugin gives the agent a ``todo_write`` tool and keeps the current list visible via a
``ContextInjector``. State is persisted to ``agent.state`` and re-surfaced as a
``<system-reminder>`` before each model call.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.todos import Todos

    agent = Agent(plugins=[Todos()])
    agent("Build a REST API with auth, validation, and tests.")
    ```
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from typing_extensions import TypedDict

from ...plugins import Plugin
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ..context_injector import ContextInjector, InjectionContext

if TYPE_CHECKING:
    from ...agent.agent import Agent

_STATE_KEY = "todos"
_DEFAULT_NAME = "strands:todos"


class TodoItem(TypedDict):
    """A single entry in the agent's task list.

    Attributes:
        content: Short description of the task.
        activeForm: Present-tense label shown while the task is ``in_progress``.
        status: Current lifecycle state of the task.
    """

    content: str
    activeForm: str
    status: Literal["pending", "in_progress", "completed"]


def _todo_line(todo: TodoItem) -> str:
    """Render one todo item as a bracketed status line.

    When the item is ``in_progress`` and has an ``activeForm``, the active form is shown
    instead of the static ``content``.

    Args:
        todo: The item to render.

    Returns:
        A single formatted line, e.g. ``"  [in_progress] Writing tests"``.
    """
    status = todo.get("status", "pending")
    label = todo["activeForm"] if status == "in_progress" and todo.get("activeForm") else todo.get("content", "")
    return f"  [{status}] {label}"


def _render_list(todos: list[TodoItem]) -> str:
    """Render the full todo list as newline-separated status lines.

    Args:
        todos: The items to render.

    Returns:
        A multi-line string with one ``_todo_line`` per item.
    """
    return "\n".join(_todo_line(item) for item in todos)


class Todos(Plugin):
    """Gives the agent a ``todo_write`` tool and keeps the current list in view.

    The tool persists the list to ``agent.state`` under ``state_key``; before each model call
    the plugin re-surfaces the list as a ``<system-reminder>`` (ephemeral, never written to
    durable history). Sharing one instance across agents is safe: state is per-agent.

    Args:
        name: Plugin name. Defaults to ``"strands:todos"``.
        state_key: Agent-state key the list is stored under. Defaults to ``"todos"``.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.todos import Todos

        agent = Agent(plugins=[Todos()])
        agent("Build a REST API with auth, validation, and tests.")
        ```
    """

    def __init__(self, *, name: str = _DEFAULT_NAME, state_key: str = _STATE_KEY) -> None:
        """Initialize the Todos plugin.

        Args:
            name: Plugin name. Defaults to ``"strands:todos"``.
            state_key: Agent-state key the list is stored under. Defaults to ``"todos"``.
        """
        self._name = name
        self._state_key = state_key
        super().__init__()

    @property
    def name(self) -> str:
        """A stable string identifier for the plugin."""
        return self._name

    def init_agent(self, agent: Agent) -> None:
        """Register a ContextInjector that surfaces the todo list before each model call.

        Args:
            agent: The agent instance to initialize.
        """
        ContextInjector(
            self._render_reminder,
            name=f"{self._name}:injector",
            trigger="everyTurn",
        ).init_agent(agent)

    def _render_reminder(self, context: InjectionContext) -> str | None:
        """Render the current todo list as a system reminder, or None if empty.

        Args:
            context: The injection context for the current model call.

        Returns:
            A ``<system-reminder>`` block with the todo list, or ``None`` if no todos exist.
        """
        todos: list[TodoItem] | None = context.state.get(self._state_key)
        if not todos:
            return None
        return (
            "<system-reminder>\nYour current todo list:\n"
            f"{_render_list(todos)}\n"
            "Keep it up to date with todo_write as you work.\n</system-reminder>"
        )

    @tool(name="todo_write", context="tool_context")
    def todo_write(self, todos: list[TodoItem], tool_context: ToolContext) -> str:
        """Create and maintain a structured task list for the current session.

        Use proactively for multi-step work (roughly 3+ distinct steps). Keep exactly one item
        ``in_progress`` at a time, and update status as you go rather than batching.

        Args:
            todos: The full updated list. Each item has ``content`` (the task),
                ``activeForm`` (shown while in progress), and ``status``.
            tool_context: Injected by the framework. Not user-facing.

        Returns:
            A summary of remaining items and the rendered list, or a confirmation that
            the list was cleared.
        """
        if not todos:
            tool_context.agent.state.delete(self._state_key)
            return "Todo list cleared"
        tool_context.agent.state.set(self._state_key, todos)
        remaining = sum(1 for item in todos if item.get("status") != "completed")
        return f"{remaining} todos remaining\n{_render_list(todos)}"


__all__ = [
    "TodoItem",
    "Todos",
]
