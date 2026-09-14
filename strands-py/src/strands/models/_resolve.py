"""Resolve ``"provider/model-id"`` strings into concrete Model instances.

A bare string (no ``/``) is a Bedrock model id for backward compatibility.
A ``"provider/model-id"`` string is split on the first ``/`` and routed to the
matching provider's factory.  Each factory lazy-imports the provider module so
the base SDK never pulls optional dependencies.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Known provider prefixes. Bedrock inference-profile ARNs contain ``/`` but never
# start with a known provider name, so the prefix check is safe.
_PROVIDERS: dict[str, Any] = {
    "bedrock": "_build_bedrock",
    "anthropic": "_build_anthropic",
    "openai": "_build_openai",
    "google": "_build_google",
    "ollama": "_build_ollama",
    "litellm": "_build_litellm",
}


def resolve_model_string(model_str: str) -> Model:  # noqa: F821
    """Resolve a model string into a concrete Model instance.

    Args:
        model_str: A ``"provider/model-id"`` string or a bare Bedrock model id.

    Returns:
        A concrete Model instance.

    Raises:
        ValueError: If the provider prefix is not recognized.
    """
    provider, sep, model_id = model_str.partition("/")
    if not sep or provider not in _PROVIDERS:
        from .bedrock import BedrockModel

        return BedrockModel(model_id=model_str)

    builder_name = _PROVIDERS[provider]
    builder = globals()[builder_name]
    return builder(model_id)


def _build_bedrock(model_id: str) -> Any:
    from .bedrock import BedrockModel

    return BedrockModel(model_id=model_id)


def _build_anthropic(model_id: str) -> Any:
    from .anthropic import AnthropicModel

    return AnthropicModel(model_id=model_id)


def _build_openai(model_id: str) -> Any:
    from .openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(model_id=model_id)


def _build_google(model_id: str) -> Any:
    from .gemini import GeminiModel

    return GeminiModel(model_id=model_id)


def _build_ollama(model_id: str) -> Any:
    from .ollama import OllamaModel

    return OllamaModel(model_id=model_id)


def _build_litellm(model_id: str) -> Any:
    from .litellm import LiteLLMModel

    return LiteLLMModel(model_id=model_id)
