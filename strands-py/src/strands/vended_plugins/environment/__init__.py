"""EnvironmentContext plugin for Strands Agents.

Injects working-environment and project-doc context (platform, date, working directory, AGENTS.md,
nearby README files) before each user turn. Reads through the agent's sandbox, so it honors
whatever sandbox the agent runs against.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.environment import EnvironmentContext

    agent = Agent(plugins=[EnvironmentContext()])
    ```
"""

from __future__ import annotations

import logging
from datetime import date
from typing import TYPE_CHECKING, Any

from ...plugins import Plugin
from ..context_injector import ContextInjector, InjectionContext

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...sandbox import Sandbox
    from ...sandbox.types import FileInfo

logger = logging.getLogger(__name__)

_DEFAULT_NAME = "strands:environment"
"""Default plugin name."""

_DISCOVERY_DEPTH = 2
"""How many directory levels to recurse when discovering project docs."""

_AGENTS_MD_CAP = 16_000
"""Maximum characters to include from AGENTS.md before truncating."""

_SKIP_DIRS = frozenset(
    {
        "node_modules",
        "dist",
        "build",
        "target",
        "__pycache__",
        "venv",
        "site-packages",
        "vendor",
    }
)
"""Directories to skip during project-doc discovery."""

_DISCOVERED_FILES = ("AGENTS.md", "README.md")
"""Filenames to discover in the project tree."""


class EnvironmentContext(Plugin):
    """Injects working-environment and project-doc context before each user turn.

    On the first user turn the plugin gathers environment information (platform, working
    directory) and discovers project documentation files (AGENTS.md, README.md) through
    the agent's :attr:`~strands.Agent.sandbox`. The gathered context is cached for the
    lifetime of the agent and surfaced as a ``<system-reminder>`` before each user turn
    via an internal :class:`~strands.vended_plugins.context_injector.ContextInjector`.

    Args:
        name: Plugin name. Defaults to ``"strands:environment"``.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.environment import EnvironmentContext

        agent = Agent(plugins=[EnvironmentContext()])
        ```
    """

    def __init__(self, *, name: str = _DEFAULT_NAME) -> None:
        """Initialize the EnvironmentContext plugin.

        Args:
            name: Plugin name. Defaults to ``"strands:environment"``.
        """
        self._name = name
        super().__init__()

    @property
    def name(self) -> str:
        """A stable string identifier for the plugin."""
        return self._name

    def init_agent(self, agent: Agent) -> None:
        """Register a ContextInjector that surfaces environment context before each user turn.

        Args:
            agent: The agent instance to initialize.
        """
        memo: dict[str, Any] = {}

        async def render(_context: InjectionContext) -> str | None:
            return await _render(agent, memo)

        ContextInjector(render, name=f"{self._name}:injector", trigger="userTurn").init_agent(agent)


async def _render(agent: Agent, memo: dict[str, Any]) -> str | None:
    """Build the system-reminder block from cached or freshly gathered environment data.

    Args:
        agent: The agent whose sandbox to query.
        memo: Per-agent cache dict; populated on first call and reused thereafter.

    Returns:
        A ``<system-reminder>`` block, or ``None`` if nothing could be gathered.
    """
    if "gathered" not in memo:
        memo["gathered"] = await _gather(agent)
    platform, cwd, agents_md, other_agents, readmes = memo["gathered"]

    env_lines: list[str] = []
    if platform:
        env_lines.append(f"Platform: {platform}")
    env_lines.append(f"Date: {date.today().isoformat()}")
    if cwd:
        env_lines.append(f"Working directory: {cwd}")

    sections = ["<environment>\n" + "\n".join(env_lines) + "\n</environment>"]
    if agents_md:
        sections.append(f"<AGENTS.md>\n{agents_md}\n</AGENTS.md>")
    if other_agents:
        sections.append("Other AGENTS.md files nearby (read as needed): " + ", ".join(other_agents))
    if readmes:
        sections.append("README files nearby (read as needed): " + ", ".join(readmes))

    return "<system-reminder>\n" + "\n\n".join(sections) + "\n</system-reminder>"


async def _gather(
    agent: Agent,
) -> tuple[str | None, str | None, str | None, list[str], list[str]]:
    """Gather environment info and discover project docs via the agent's sandbox.

    Args:
        agent: The agent whose sandbox to query.

    Returns:
        A tuple of (platform, cwd, agents_md_content, other_agents_paths, readme_paths).
    """
    try:
        sandbox: Sandbox = agent.sandbox
    except Exception:
        logger.debug("sandbox unavailable | skipping environment gathering")
        return None, None, None, [], []

    platform = await _probe(sandbox, "uname -s")
    cwd = await _probe(sandbox, "pwd")
    agents_md = await _read_text(sandbox, "AGENTS.md")
    found = await _discover(sandbox)
    other_agents = [path for path in found["AGENTS.md"] if path != "AGENTS.md"]

    return platform, cwd, agents_md, other_agents, found["README.md"]


async def _probe(sandbox: Sandbox, command: str) -> str | None:
    """Execute a command and return the first line of stdout, or ``None`` on failure.

    Args:
        sandbox: The sandbox to execute in.
        command: The shell command to run.

    Returns:
        The first line of stdout, or ``None`` if the command failed or produced no output.
    """
    try:
        result = await sandbox.execute(command)
    except Exception:
        logger.debug("command=<%s> | probe failed", command)
        return None
    if result.exit_code == 0 and result.stdout.strip():
        return result.stdout.strip().splitlines()[0]
    return None


async def _read_text(sandbox: Sandbox, path: str) -> str | None:
    """Read a text file from the sandbox, truncating if it exceeds the cap.

    Args:
        sandbox: The sandbox to read from.
        path: The file path to read.

    Returns:
        The file contents (possibly truncated), or ``None`` if unreadable.
    """
    try:
        text = await sandbox.read_text(path)
    except Exception:
        return None
    if len(text) > _AGENTS_MD_CAP:
        return text[:_AGENTS_MD_CAP] + "\n... (truncated -- read the full file if you need the rest)"
    return text


async def _discover(sandbox: Sandbox) -> dict[str, list[str]]:
    """Walk the sandbox working directory to find project documentation files.

    Recurses up to ``_DISCOVERY_DEPTH`` levels, skipping hidden directories and
    directories in ``_SKIP_DIRS``.

    Args:
        sandbox: The sandbox to list files in.

    Returns:
        A mapping from filename (e.g. ``"AGENTS.md"``) to the list of relative paths found.
    """
    found: dict[str, list[str]] = {name: [] for name in _DISCOVERED_FILES}

    async def visit(rel: str, depth: int) -> None:
        try:
            entries: list[FileInfo] = await sandbox.list_files(rel or ".")
        except Exception:
            return
        for entry in entries:
            path = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir:
                if depth < _DISCOVERY_DEPTH and entry.name not in _SKIP_DIRS and not entry.name.startswith("."):
                    await visit(path, depth + 1)
            elif entry.name in found:
                found[entry.name].append(path)

    await visit("", 0)
    return found


__all__ = [
    "EnvironmentContext",
]
