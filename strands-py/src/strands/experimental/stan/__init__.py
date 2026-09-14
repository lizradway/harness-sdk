"""Stan — an opinionated, benchmark-validated agent preset.

Stan is a code-as-config harness that configures an Agent with
production-tested defaults: a behavioral system prompt, built-in tools
(shell, file editor), and context management. Use it directly or pass
it to ``Agent(harness=Stan())``.

Example::

    from strands import Agent
    from strands.experimental.stan import Stan

    agent = Agent(harness=Stan(), tools=[my_tool])

    # String sugar (equivalent to the above):
    agent = Agent(harness="stan", tools=[my_tool])

This module is experimental and subject to change.
"""

from .prompt import HARNESS_CONTRACT, build_system_prompt
from .stan import Stan

__all__ = ["HARNESS_CONTRACT", "Stan", "build_system_prompt"]
