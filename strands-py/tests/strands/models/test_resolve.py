"""Tests for the provider-prefixed model string resolver."""

from unittest.mock import MagicMock, patch

from strands.models._resolve import resolve_model_string


class TestResolveModelString:
    """Tests for resolve_model_string."""

    @patch("strands.models._resolve._build_bedrock")
    def test_bare_string_is_bedrock(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("anthropic.claude-sonnet-4-6-v1:0")
        # Bare string (no known provider prefix) goes to Bedrock
        from strands.models.bedrock import BedrockModel

        assert isinstance(tru_model, BedrockModel)

    @patch("strands.models._resolve._build_anthropic")
    def test_anthropic_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("anthropic/claude-sonnet-4-6")
        mock_build.assert_called_once_with("claude-sonnet-4-6")
        assert tru_model is mock_model

    @patch("strands.models._resolve._build_openai")
    def test_openai_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("openai/gpt-5.6-luna")
        mock_build.assert_called_once_with("gpt-5.6-luna")
        assert tru_model is mock_model

    @patch("strands.models._resolve._build_google")
    def test_google_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("google/gemini-3.5-flash")
        mock_build.assert_called_once_with("gemini-3.5-flash")
        assert tru_model is mock_model

    @patch("strands.models._resolve._build_ollama")
    def test_ollama_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("ollama/llama3")
        mock_build.assert_called_once_with("llama3")
        assert tru_model is mock_model

    @patch("strands.models._resolve._build_litellm")
    def test_litellm_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("litellm/some-model")
        mock_build.assert_called_once_with("some-model")
        assert tru_model is mock_model

    @patch("strands.models._resolve._build_bedrock")
    def test_bedrock_prefix(self, mock_build):
        mock_model = MagicMock()
        mock_build.return_value = mock_model
        tru_model = resolve_model_string("bedrock/us.anthropic.claude-sonnet-4-6-v1:0")
        mock_build.assert_called_once_with("us.anthropic.claude-sonnet-4-6-v1:0")
        assert tru_model is mock_model

    def test_unknown_prefix_falls_through_to_bedrock(self):
        """An unknown provider prefix is treated as part of a Bedrock model id."""
        from strands.models.bedrock import BedrockModel

        tru_model = resolve_model_string("unknownprovider/some-model")
        assert isinstance(tru_model, BedrockModel)

    def test_bedrock_arn_with_slash_treated_as_bedrock(self):
        """Bedrock inference-profile ARNs contain / but don't start with a known provider."""
        from strands.models.bedrock import BedrockModel

        tru_model = resolve_model_string("arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile")
        assert isinstance(tru_model, BedrockModel)


class TestAgentProviderString:
    """Tests for Agent(model='provider/name') integration."""

    @patch("strands.models._resolve._build_anthropic")
    def test_agent_with_provider_string(self, mock_build):
        from strands import Agent

        mock_model = MagicMock()
        mock_model.stateful = False
        mock_build.return_value = mock_model

        agent = Agent(model="anthropic/claude-sonnet-4-6", callback_handler=None)
        assert agent.model is mock_model
        mock_build.assert_called_once_with("claude-sonnet-4-6")
