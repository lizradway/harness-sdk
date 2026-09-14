"""Stan harness implementation."""

from typing import Any

from ...agent.harness import _HARNESS_REGISTRY
from .prompt import build_system_prompt


class Stan:
    """Benchmark-validated agent preset.

    Stan configures an Agent with production-tested defaults: a behavioral
    system prompt, built-in tools (shell, file editor, read, write, edit),
    context management, and feature plugins (Todos, EnvironmentContext).
    All defaults can be overridden by passing explicit kwargs to ``Agent``.

    Args:
        instructions: Domain-specific instructions appended after the harness contract.
            Ignored when an explicit ``system_prompt`` is passed to ``Agent``.
        context_manager: Context management strategy. Defaults to ``"auto"``.
        include_tools: Whether to include Stan's default tools. Defaults to True.
        include_plugins: Whether to include Stan's default plugins. Defaults to True.

    Example::

        from strands import Agent
        from strands.experimental.stan import Stan

        # Benchmarked defaults in one line
        agent = Agent(harness=Stan(), tools=[my_tool])

        # With custom instructions
        agent = Agent(harness=Stan(instructions="You are a Python expert."))

        # String sugar
        agent = Agent(harness="stan", tools=[my_tool])
    """

    def __init__(
        self,
        *,
        instructions: str | None = None,
        context_manager: str | None = "auto",
        include_tools: bool = True,
        include_plugins: bool = True,
    ) -> None:
        """Initialize the Stan harness.

        Args:
            instructions: Domain-specific instructions appended after the harness contract.
            context_manager: Context management strategy. Defaults to ``"auto"``.
            include_tools: Whether to include Stan's default tools. Defaults to True.
            include_plugins: Whether to include Stan's default plugins. Defaults to True.
        """
        self._instructions = instructions
        self._context_manager = context_manager
        self._include_tools = include_tools
        self._include_plugins = include_plugins

    def defaults(self) -> dict[str, Any]:
        """Return Stan's default Agent kwargs.

        Returns:
            A dict of Agent constructor keyword arguments.
        """
        result: dict[str, Any] = {}

        result["system_prompt"] = build_system_prompt(self._instructions)

        if self._context_manager is not None:
            result["context_manager"] = self._context_manager

        if self._include_tools:
            from ...vended_tools import file_editor, shell
            from ...vended_tools.file_tools import edit, read, write

            result["tools"] = [shell, file_editor, read, write, edit]

        if self._include_plugins:
            from ...vended_plugins.environment import EnvironmentContext
            from ...vended_plugins.todos import Todos

            result["plugins"] = [Todos(), EnvironmentContext()]

        return result


_HARNESS_REGISTRY["stan"] = Stan
