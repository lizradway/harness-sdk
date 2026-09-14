"""Tests for the harness protocol and Agent(harness=...) integration."""

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from strands.agent.harness import _HARNESS_REGISTRY, Harness, apply_harness_defaults, resolve_harness


class SimpleHarness:
    """Minimal harness for testing."""

    def __init__(self, **defaults: Any) -> None:
        self._defaults = defaults

    def defaults(self) -> dict[str, Any]:
        return dict(self._defaults)


class TestHarnessProtocol:
    """Tests for the Harness protocol."""

    def test_simple_harness_satisfies_protocol(self):
        harness = SimpleHarness(context_manager="auto")
        assert isinstance(harness, Harness)

    def test_defaults_returns_dict(self):
        harness = SimpleHarness(context_manager="auto", model="some-model")
        tru_defaults = harness.defaults()
        assert tru_defaults == {"context_manager": "auto", "model": "some-model"}


class TestResolveHarness:
    """Tests for resolve_harness."""

    def test_resolve_instance(self):
        harness = SimpleHarness(context_manager="auto")
        tru_resolved = resolve_harness(harness)
        assert tru_resolved is harness

    def test_resolve_registered_name(self):
        _HARNESS_REGISTRY["test-harness"] = SimpleHarness
        try:
            tru_resolved = resolve_harness("test-harness")
            assert isinstance(tru_resolved, SimpleHarness)
        finally:
            del _HARNESS_REGISTRY["test-harness"]

    def test_resolve_unknown_name_raises(self):
        with pytest.raises(ValueError, match="Unknown harness 'nonexistent'"):
            resolve_harness("nonexistent")


class TestApplyHarnessDefaults:
    """Tests for apply_harness_defaults."""

    def test_scalar_fills_none(self):
        harness = SimpleHarness(context_manager="auto")
        kwargs: dict[str, Any] = {"context_manager": None, "model": None}
        apply_harness_defaults(harness, kwargs)
        assert kwargs["context_manager"] == "auto"
        assert kwargs["model"] is None

    def test_scalar_caller_wins(self):
        harness = SimpleHarness(context_manager="auto")
        kwargs: dict[str, Any] = {"context_manager": "agentic"}
        apply_harness_defaults(harness, kwargs)
        assert kwargs["context_manager"] == "agentic"

    def test_list_union_when_caller_provides(self):
        harness = SimpleHarness(tools=["harness_tool"])
        kwargs: dict[str, Any] = {"tools": ["user_tool"]}
        apply_harness_defaults(harness, kwargs)
        assert kwargs["tools"] == ["harness_tool", "user_tool"]

    def test_list_fills_when_caller_none(self):
        harness = SimpleHarness(tools=["harness_tool"])
        kwargs: dict[str, Any] = {"tools": None}
        apply_harness_defaults(harness, kwargs)
        assert kwargs["tools"] == ["harness_tool"]

    def test_list_union_plugins(self):
        plugin_a = MagicMock()
        plugin_b = MagicMock()
        harness = SimpleHarness(plugins=[plugin_a])
        kwargs: dict[str, Any] = {"plugins": [plugin_b]}
        apply_harness_defaults(harness, kwargs)
        assert kwargs["plugins"] == [plugin_a, plugin_b]

    def test_multiple_list_keys(self):
        harness = SimpleHarness(
            tools=["t1"],
            plugins=["p1"],
            hooks=["h1"],
            interventions=["i1"],
        )
        kwargs: dict[str, Any] = {
            "tools": ["t2"],
            "plugins": None,
            "hooks": ["h2"],
            "interventions": None,
        }
        apply_harness_defaults(harness, kwargs)
        assert kwargs["tools"] == ["t1", "t2"]
        assert kwargs["plugins"] == ["p1"]
        assert kwargs["hooks"] == ["h1", "h2"]
        assert kwargs["interventions"] == ["i1"]


class TestAgentHarnessIntegration:
    """Tests for Agent(harness=...) constructor integration."""

    @patch("strands.agent.agent.BedrockModel")
    def test_harness_instance(self, mock_bedrock_cls):
        from strands import Agent

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        harness = SimpleHarness(context_manager="auto")
        agent = Agent(harness=harness, callback_handler=None)
        assert agent is not None

    @patch("strands.agent.agent.BedrockModel")
    def test_harness_string_stan(self, mock_bedrock_cls):
        from strands import Agent
        from strands.experimental.stan import Stan  # noqa: F401 - registers "stan"

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        agent = Agent(harness="stan", callback_handler=None)
        assert agent is not None

    @patch("strands.agent.agent.BedrockModel")
    def test_harness_caller_overrides_scalar(self, mock_bedrock_cls):
        from strands import Agent

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        harness = SimpleHarness(context_manager="auto")
        agent = Agent(harness=harness, context_manager="agentic", callback_handler=None)
        from strands.agent.conversation_manager import SummarizingConversationManager

        assert isinstance(agent.conversation_manager, SummarizingConversationManager)

    @patch("strands.agent.agent.BedrockModel")
    def test_harness_unknown_string_raises(self, mock_bedrock_cls):
        from strands import Agent

        with pytest.raises(ValueError, match="Unknown harness"):
            Agent(harness="nonexistent")


class TestStanHarness:
    """Tests for the Stan harness implementation."""

    def test_stan_defaults_include_system_prompt(self):
        from strands.experimental.stan import HARNESS_CONTRACT, Stan

        stan = Stan()
        tru_defaults = stan.defaults()
        assert "system_prompt" in tru_defaults
        assert HARNESS_CONTRACT in tru_defaults["system_prompt"]

    def test_stan_defaults_include_tools(self):
        from strands.experimental.stan import Stan

        stan = Stan()
        tru_defaults = stan.defaults()
        assert "tools" in tru_defaults
        tool_names = {t.tool_name for t in tru_defaults["tools"]}
        assert "shell" in tool_names
        assert "file_editor" in tool_names
        assert "read" in tool_names
        assert "write" in tool_names
        assert "edit" in tool_names

    def test_stan_defaults_include_plugins(self):
        from strands.experimental.stan import Stan
        from strands.vended_plugins.environment import EnvironmentContext
        from strands.vended_plugins.todos import Todos

        stan = Stan()
        tru_defaults = stan.defaults()
        assert "plugins" in tru_defaults
        plugin_types = {type(p) for p in tru_defaults["plugins"]}
        assert Todos in plugin_types
        assert EnvironmentContext in plugin_types

    def test_stan_defaults_include_context_manager(self):
        from strands.experimental.stan import Stan

        stan = Stan()
        tru_defaults = stan.defaults()
        assert tru_defaults["context_manager"] == "auto"

    def test_stan_custom_instructions(self):
        from strands.experimental.stan import HARNESS_CONTRACT, Stan

        stan = Stan(instructions="You are a Python expert.")
        tru_defaults = stan.defaults()
        assert HARNESS_CONTRACT in tru_defaults["system_prompt"]
        assert "You are a Python expert." in tru_defaults["system_prompt"]

    def test_stan_no_tools(self):
        from strands.experimental.stan import Stan

        stan = Stan(include_tools=False)
        tru_defaults = stan.defaults()
        assert "tools" not in tru_defaults

    def test_stan_no_plugins(self):
        from strands.experimental.stan import Stan

        stan = Stan(include_plugins=False)
        tru_defaults = stan.defaults()
        assert "plugins" not in tru_defaults

    def test_stan_no_context_manager(self):
        from strands.experimental.stan import Stan

        stan = Stan(context_manager=None)
        tru_defaults = stan.defaults()
        assert "context_manager" not in tru_defaults

    @patch("strands.agent.agent.BedrockModel")
    def test_stan_agent_has_system_prompt(self, mock_bedrock_cls):
        from strands import Agent
        from strands.experimental.stan import HARNESS_CONTRACT, Stan

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        agent = Agent(harness=Stan(), callback_handler=None)
        assert HARNESS_CONTRACT in agent._system_prompt

    @patch("strands.agent.agent.BedrockModel")
    def test_stan_agent_has_tools(self, mock_bedrock_cls):
        from strands import Agent
        from strands.experimental.stan import Stan

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        agent = Agent(harness=Stan(), callback_handler=None)
        tool_names = set(agent.tool_registry.registry.keys())
        assert "shell" in tool_names
        assert "file_editor" in tool_names
        assert "read" in tool_names
        assert "write" in tool_names
        assert "edit" in tool_names

    @patch("strands.agent.agent.BedrockModel")
    def test_stan_user_tools_merged(self, mock_bedrock_cls):
        from strands import Agent, tool
        from strands.experimental.stan import Stan

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        @tool
        def my_custom_tool() -> str:
            """A custom tool."""
            return "hello"

        agent = Agent(harness=Stan(), tools=[my_custom_tool], callback_handler=None)
        tool_names = set(agent.tool_registry.registry.keys())
        assert "shell" in tool_names
        assert "read" in tool_names
        assert "my_custom_tool" in tool_names

    @patch("strands.agent.agent.BedrockModel")
    def test_stan_caller_system_prompt_wins(self, mock_bedrock_cls):
        from strands import Agent
        from strands.experimental.stan import Stan

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_bedrock_cls.return_value = mock_model

        agent = Agent(harness=Stan(), system_prompt="Custom prompt", callback_handler=None)
        assert agent._system_prompt == "Custom prompt"

    def test_stan_registered_as_string(self):
        from strands.experimental.stan import Stan  # noqa: F401 - triggers registration

        assert "stan" in _HARNESS_REGISTRY
