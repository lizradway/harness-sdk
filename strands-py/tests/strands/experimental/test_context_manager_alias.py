"""The experimental context_manager aliases resolve to strands.context_manager and warn on access."""

import pytest

import strands.context_manager as context_manager
import strands.experimental.context_manager as experimental_context_manager


@pytest.mark.parametrize("name", sorted(experimental_context_manager._DEPRECATED_NAMES))
def test_alias_warns_and_resolves_to_stable(name):
    with pytest.warns(DeprecationWarning, match=f"Import {name} from strands.context_manager"):
        aliased = getattr(experimental_context_manager, name)

    assert aliased is getattr(context_manager, name)


def test_alias_names_match_stable_exports():
    assert experimental_context_manager._DEPRECATED_NAMES <= set(context_manager.__all__)


def test_unknown_attribute_raises():
    with pytest.raises(AttributeError, match="has no attribute"):
        _ = experimental_context_manager.NonExistent
