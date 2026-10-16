"""Strategy-driven context management for agents.

The ContextManager is a first-class agent component that manages context reduction
via an ordered strategy pipeline. Pass it via the ``context_manager`` parameter on
the Agent constructor.
"""

from .context_manager import ContextManager, ContextManagerStrategy
from .methods.summarize import SummarizeConfig
from .methods.truncate import TruncateConfig
from .presets import STRATEGY_PRESET_NAMES, StrategyPresetName
from .strategies.offload import Offload
from .strategies.offload.base import OffloadConditions, OffloadTarget
from .types import ContextManagerConfig, ContextState, ContextStrategy, StashConfig

__all__ = [
    "ContextManager",
    "ContextManagerConfig",
    "ContextManagerStrategy",
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
]
