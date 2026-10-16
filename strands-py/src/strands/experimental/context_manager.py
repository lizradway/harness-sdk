"""Deprecated: Context management has moved to strands.context_manager.

This module provides backwards-compatible aliases that emit deprecation warnings.
"""

import warnings
from typing import Any

_DEPRECATED_NAMES = {
    "ContextManager",
    "ContextManagerConfig",
    "ContextState",
    "ContextStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadTarget",
    "STRATEGY_PRESET_NAMES",
    "StashConfig",
    "StrategyPresetName",
    "SummarizeConfig",
    "TruncateConfig",
}


def __getattr__(name: str) -> Any:
    if name in _DEPRECATED_NAMES:
        from strands import context_manager

        warnings.warn(
            f"strands.experimental.context_manager.{name} is deprecated and will be removed in v1.63.0. "
            f"Import {name} from strands.context_manager instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(context_manager, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__: list[str] = []
