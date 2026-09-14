"""Harness protocol for agent configuration presets.

A harness supplies default values for Agent constructor parameters.  Scalar
options fill the gap when the caller leaves them at None; list-valued options
(tools, plugins, hooks, interventions) are unioned so a harness never removes
a caller-supplied item.
"""

from typing import Any, Protocol, runtime_checkable

_LIST_KEYS = frozenset({"tools", "plugins", "hooks", "interventions"})

_HARNESS_REGISTRY: dict[str, type["Harness"]] = {}


@runtime_checkable
class Harness(Protocol):
    """Protocol for agent configuration presets.

    Implement ``defaults`` to return a dict of Agent kwargs.  The caller's
    explicit values always win; list-valued options are unioned.

    Example::

        class MyPreset:
            def defaults(self) -> dict[str, Any]:
                return {"context_manager": "auto"}

        agent = Agent(harness=MyPreset(), tools=[my_tool])
    """

    def defaults(self) -> dict[str, Any]:
        """Return default values for Agent constructor parameters."""
        ...


def resolve_harness(harness: "Harness | str") -> "Harness":
    """Resolve a harness from a string name or return it as-is.

    Args:
        harness: A Harness instance or a registered name (e.g. ``"stan"``).

    Returns:
        The resolved Harness instance.

    Raises:
        ValueError: If the string name is not registered.
    """
    if isinstance(harness, str):
        if harness not in _HARNESS_REGISTRY:
            registered = ", ".join(sorted(_HARNESS_REGISTRY)) or "(none)"
            raise ValueError(f"Unknown harness {harness!r}. Registered: {registered}")
        return _HARNESS_REGISTRY[harness]()
    return harness


def apply_harness_defaults(harness: "Harness", caller_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Merge harness defaults into the caller's kwargs.

    Scalar values fill the gap when the caller's value is None.  List values
    are prepended so the harness never removes a caller-supplied item.

    Args:
        harness: The resolved harness instance.
        caller_kwargs: The caller's keyword arguments (mutated in place and returned).

    Returns:
        The merged kwargs dict.
    """
    defaults = harness.defaults()
    for key, value in defaults.items():
        if key in _LIST_KEYS:
            caller_value = caller_kwargs.get(key)
            if caller_value is None:
                caller_kwargs[key] = list(value)
            else:
                caller_kwargs[key] = [*value, *caller_value]
        else:
            if caller_kwargs.get(key) is None:
                caller_kwargs[key] = value
    return caller_kwargs
