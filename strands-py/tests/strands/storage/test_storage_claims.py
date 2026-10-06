"""Tests for subsystem storage resolution and per-agent overlap detection."""

import pytest

from strands import Agent
from strands._context_manager.context_manager import ContextManager
from strands.session.snapshot_session_manager import SnapshotSessionManager
from strands.storage.in_memory_storage import InMemoryStorage
from strands.storage.local_file_storage import LocalFileStorage
from strands.storage.storage import _claim_storage, _resolve_namespace, _storage_location
from strands.vended_plugins.context_offloader import ContextOffloader
from tests.fixtures.mocked_model_provider import MockedModelProvider


class _Agent:
    """Minimal weak-referenceable stand-in for an agent."""


class TestResolveNamespace:
    def test_explicit_namespaced_view_is_used_as_given(self):
        view = InMemoryStorage().namespace("team")
        assert _resolve_namespace(view, "context") is view

    @pytest.mark.asyncio
    async def test_inherited_namespaced_view_gets_the_prefix(self):
        root = InMemoryStorage()
        resolved = _resolve_namespace(root.namespace("tenant-a"), "context", inherited=True)
        await resolved.write("k", b"{}")
        assert await root.list("") == ["tenant-a/context/k"]


class TestClaimStorage:
    def test_same_location_conflicts(self):
        agent, view = _Agent(), InMemoryStorage().namespace("team")
        _claim_storage(agent, object(), "A", view)
        with pytest.raises(ValueError, match="B storage at 'team/' overlaps A storage at 'team/'"):
            _claim_storage(agent, object(), "B", view)

    def test_exclusive_root_conflicts_with_a_nested_claim(self):
        agent, root = _Agent(), InMemoryStorage()
        _claim_storage(agent, object(), "stash", root.namespace("team"), exclusive=True)
        with pytest.raises(ValueError):
            _claim_storage(agent, object(), "session", root.namespace("team/session"))

    def test_nested_claim_under_a_non_exclusive_root_is_allowed(self):
        agent, root = _Agent(), InMemoryStorage()
        _claim_storage(agent, object(), "session", root.namespace("team"))
        _claim_storage(agent, object(), "stash", root.namespace("team/context"), exclusive=True)

    def test_sibling_prefixes_do_not_conflict(self):
        agent, root = _Agent(), InMemoryStorage()
        _claim_storage(agent, object(), "stash", root.namespace("context"), exclusive=True)
        _claim_storage(agent, object(), "session", root.namespace("session"))

    def test_different_agents_may_share_a_view(self):
        view = InMemoryStorage().namespace("team")
        _claim_storage(_Agent(), object(), "stash", view, exclusive=True)
        _claim_storage(_Agent(), object(), "stash", view, exclusive=True)

    def test_reclaim_by_the_same_owner_replaces_its_claim(self):
        agent, owner, view = _Agent(), object(), InMemoryStorage().namespace("team")
        _claim_storage(agent, owner, "stash", view, exclusive=True)
        _claim_storage(agent, owner, "stash", view, exclusive=True)

    def test_file_storages_on_the_same_directory_conflict(self, tmp_path):
        agent = _Agent()
        _claim_storage(agent, object(), "A", LocalFileStorage(str(tmp_path)).namespace("x"))
        with pytest.raises(ValueError):
            _claim_storage(agent, object(), "B", LocalFileStorage(str(tmp_path)).namespace("x"))


class TestAgentWiring:
    def test_namespaced_agent_storage_is_prefixed_per_subsystem(self):
        root = InMemoryStorage()
        manager = SnapshotSessionManager("s1")
        offloader = ContextOffloader()
        context_manager = ContextManager()
        Agent(
            model=MockedModelProvider([]),
            storage=root.namespace("tenant-a"),
            session_manager=manager,
            context_manager=context_manager,
            plugins=[offloader],
            agent_id="a1",
        )

        assert _storage_location(manager._storage)[1] == "tenant-a/session/"
        assert _storage_location(offloader._storage)[1] == "tenant-a/offloader/"
        assert _storage_location(context_manager.stash._root)[1] == "tenant-a/context/"

    def test_stash_view_enclosing_the_session_storage_raises(self):
        view = InMemoryStorage().namespace("team")
        with pytest.raises(ValueError, match="overlaps"):
            Agent(
                model=MockedModelProvider([]),
                storage=view,
                session_manager=SnapshotSessionManager("s1"),
                context_manager=ContextManager(stash={"storage": view}),
            )
