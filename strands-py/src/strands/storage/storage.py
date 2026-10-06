"""Unified storage interface and key-normalization helpers."""

from __future__ import annotations

import builtins
import os
import re
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from typing_extensions import TypeVar

from ..types.exceptions import StorageError

ListQuery = TypeVar("ListQuery", default=str, contravariant=True)
SearchQuery = TypeVar("SearchQuery", default=str, contravariant=True)

_NAMESPACED: object = object()
"""Internal sentinel marking a storage view as already namespace-scoped.

SDK constructs use this to detect whether the caller already scoped the storage,
so the default auto-prefix can be skipped.
"""

_EPHEMERAL: object = object()
"""Internal sentinel marking a storage backend as ephemeral (data does not survive restarts).

Set on :class:`InMemoryStorage` and propagated by :class:`_NamespacedStorage` so that
consumers (e.g. the session manager's stash integration) can detect ephemeral backends
without an ``isinstance`` check that breaks for namespaced views of ephemeral storage.
"""


@dataclass
class StorageSearchResult:
    """A single result from a storage search call.

    Attributes:
        key: Storage key of the matched item.
        score: Relevance score; higher values indicate greater relevance.
            Backends using distance-based scoring (e.g. vector distance) must
            invert to similarity before returning results.
        data: Stored bytes, present only when the backend includes them.
    """

    key: str
    score: float
    data: bytes | None = field(default=None, repr=False)


def _normalize_key(key: str) -> str:
    """Validate and normalize a storage key for path-based backends.

    Collapses runs of '/', strips leading and trailing '/', rejects empty
    keys, rejects backslashes, and rejects any '..' segment.

    Used by the shipped path-based backends (InMemoryStorage, LocalFileStorage,
    S3Storage), not required by the Storage protocol itself.

    Args:
        key: The raw key to normalize.

    Returns:
        The normalized key.

    Raises:
        StorageError: If the key is empty, contains backslashes, or contains a '..' segment.
    """
    if "\\" in key:
        raise StorageError(f"Invalid storage key '{key}': backslashes are not allowed")
    normalized = re.sub(r"/+", "/", key).strip("/")
    if not normalized:
        raise StorageError("Storage key must not be empty")
    if ".." in normalized.split("/"):
        raise StorageError(f"Invalid storage key '{key}': '..' path segments are not allowed")
    return normalized


def _normalize_prefix(prefix: str) -> str:
    """Normalize a list prefix for path-based backends.

    Collapses slash runs, strips leading slashes. Unlike a key, an empty
    prefix is valid and matches everything. A trailing slash is preserved
    because it is semantically significant for prefix matching.

    Used by the shipped path-based backends alongside :func:`_normalize_key`.

    Args:
        prefix: The raw prefix to normalize.

    Returns:
        The normalized prefix.

    Raises:
        StorageError: If the prefix contains backslashes or a '..' segment.
    """
    if "\\" in prefix:
        raise StorageError(f"Invalid storage prefix '{prefix}': backslashes are not allowed")
    normalized = re.sub(r"/+", "/", prefix).lstrip("/")
    if ".." in normalized.split("/"):
        raise StorageError(f"Invalid storage prefix '{prefix}': '..' path segments are not allowed")
    return normalized


@runtime_checkable
class Storage(Protocol[ListQuery, SearchQuery]):
    """A backend for storing and retrieving raw bytes under string keys.

    The interface is deliberately minimal — four operations over opaque bytes
    values. Keys are opaque strings — implementations must round-trip the bytes
    they are given unchanged. The shipped backends interpret '/' as a logical
    separator (collapsing runs, rejecting '..'), but custom backends may apply
    their own key scheme.

    The ``ListQuery`` type parameter controls what ``list`` accepts. It defaults to
    ``str`` (a key prefix), which every backend supports. Implementations may
    widen it to accept a richer query object while still accepting a plain string
    for SDK-internal callers.

    Implement this to add a custom backend; the SDK ships :class:`InMemoryStorage`,
    :class:`LocalFileStorage`, and :class:`S3Storage`.
    """

    async def write(self, key: str, data: bytes) -> None:
        """Store data under key, overwriting any existing value.

        Args:
            key: Opaque string key identifying the value.
            data: Raw bytes to persist.

        Raises:
            StorageError: If the write fails.
        """
        ...

    async def read(self, key: str) -> bytes | None:
        """Retrieve the bytes previously stored under key.

        Args:
            key: The key to read.

        Returns:
            The stored bytes, or None if no value exists for key.

        Raises:
            StorageError: If the read fails for a reason other than a missing key.
        """
        ...

    async def delete(self, key: str) -> None:
        """Delete the value stored under key. A no-op if the key does not exist.

        Args:
            key: The key to delete.

        Raises:
            StorageError: If the delete fails.
        """
        ...

    async def list(self, query: ListQuery) -> builtins.list[str]:
        """List keys matching the given prefix query.

        Returns full keys (not the suffix after the prefix), sorted
        lexicographically. An empty string lists every key.

        Args:
            query: A string prefix to match.

        Returns:
            The matching keys, sorted ascending.

        Raises:
            StorageError: If the listing fails.
        """
        ...

    async def search(self, query: SearchQuery) -> builtins.list[StorageSearchResult]:
        """Search stored content by query.

        The default implementation uses :class:`~strands.storage.search.KeywordSearchStrategy`
        (token-overlap scoring over all keys). Backends may override with a richer
        strategy (vector similarity, full-text index, etc.).

        The ``SearchQuery`` type parameter controls what this method accepts. It defaults
        to ``str`` (a natural-language query). Implementations may widen it to accept
        richer query objects (e.g. a pre-computed embedding vector with metadata filters).

        Args:
            query: A string query or backend-specific query object.

        Returns:
            Matched keys with relevance scores, ranked best-first.
        """
        from .search.keyword import KeywordSearchStrategy

        return await KeywordSearchStrategy().search(self, query)  # type: ignore[arg-type]


class _NamespacedStorage:
    """A storage view that prepends a prefix to all keys.

    Composable — calling ``.namespace()`` on the result nests prefixes.
    Uses :func:`_normalize_prefix` to sanitize the prefix, so it assumes a
    '/'-separated key scheme. Backends with a different key scheme should
    implement their own namespacing.
    """

    _namespaced = _NAMESPACED

    def __init__(self, storage: Storage, prefix: str) -> None:
        normalized = _normalize_prefix(prefix).rstrip("/")
        self._storage = storage
        self._prefix = f"{normalized}/" if normalized else ""
        if getattr(storage, "_ephemeral", None) is _EPHEMERAL:
            self._ephemeral = _EPHEMERAL

    async def write(self, key: str, data: bytes) -> None:
        """Store data under the prefixed key."""
        await self._storage.write(f"{self._prefix}{key}", data)

    async def read(self, key: str) -> bytes | None:
        """Read from the prefixed key."""
        return await self._storage.read(f"{self._prefix}{key}")

    async def delete(self, key: str) -> None:
        """Delete the prefixed key."""
        await self._storage.delete(f"{self._prefix}{key}")

    async def list(self, query: str = "") -> builtins.list[str]:
        """List keys under the prefix, stripping it from results."""
        keys = await self._storage.list(f"{self._prefix}{query}")
        return [key[len(self._prefix) :] for key in keys]

    async def search(self, query: str) -> builtins.list[StorageSearchResult]:
        """Search within this namespace, filtering results to the prefix."""
        results: builtins.list[StorageSearchResult] = await self._storage.search(query)
        scoped: builtins.list[StorageSearchResult] = []
        for result in results:
            if result.key.startswith(self._prefix):
                scoped.append(
                    StorageSearchResult(
                        key=result.key[len(self._prefix) :],
                        score=result.score,
                        data=result.data,
                    )
                )
        return scoped

    def namespace(self, prefix: str) -> _NamespacedStorage:
        """Return a further-scoped view by nesting prefixes."""
        return _NamespacedStorage(self._storage, f"{self._prefix}{prefix}")

    def for_sandbox(self, sandbox: object) -> _NamespacedStorage:
        """Delegate sandbox binding to the underlying storage and re-wrap."""
        inner = self._storage
        if not hasattr(inner, "for_sandbox"):
            return self
        bound = inner.for_sandbox(sandbox)
        return _NamespacedStorage(bound, self._prefix.rstrip("/"))


def _resolve_namespace(storage: Storage, prefix: str, *, inherited: bool = False) -> Storage:
    """Scope a subsystem's storage under its own ``prefix``.

    Storage handed directly to a subsystem and already marked with the internal ``_NAMESPACED``
    sentinel is used as given. Storage the subsystem inherited from ``agent.storage`` is always
    prefixed, namespaced or not: an agent-level view is shared by every subsystem, so each keeps
    its own prefix under it. Otherwise delegates to the storage's own ``namespace()`` method or
    wraps with ``_NamespacedStorage``.

    Args:
        storage: The storage to scope.
        prefix: Prefix to apply.
        inherited: Whether the storage came from ``agent.storage`` rather than the subsystem's config.

    Returns:
        A namespaced Storage view (or the original if it is an explicitly passed namespaced view).
    """
    if not inherited and getattr(storage, "_namespaced", None) is _NAMESPACED:
        return storage
    if hasattr(storage, "namespace"):
        result: Storage = storage.namespace(prefix)
        return result
    return _NamespacedStorage(storage, prefix)


@dataclass(frozen=True)
class _StorageClaim:
    """One subsystem's claim on a storage location for an agent."""

    owner: object
    name: str
    backend: object
    path: str
    exclusive: bool


_STORAGE_CLAIMS: weakref.WeakKeyDictionary[object, builtins.list[_StorageClaim]] = weakref.WeakKeyDictionary()


def _storage_location(storage: Storage) -> tuple[object, str]:
    """Return a comparable ``(backend, path)`` for a storage view.

    ``path`` is ``/``-terminated (or empty for a backend root). File storage is identified by its
    resolved directory so two instances on the same directory compare equal; any other backend is
    identified by the instance, so a backend this function cannot see through never collides.
    """
    from .local_file_storage import LocalFileStorage

    if isinstance(storage, _NamespacedStorage):
        backend, path = _storage_location(storage._storage)
        return backend, f"{path}{storage._prefix}"
    if isinstance(storage, LocalFileStorage):
        return "file", f"{Path(os.path.realpath(storage.base_dir)).as_posix().rstrip('/')}/"
    return storage, ""


def _claim_storage(agent: object, owner: object, name: str, storage: Storage, *, exclusive: bool = False) -> None:
    """Record that ``owner`` uses ``storage`` for ``agent``, refusing an overlap with another subsystem.

    Two claims on one agent conflict when they resolve to the same location, or when one sits under
    the other and the outer one is ``exclusive`` (it lists or deletes everything under its root, so
    it would read or delete the inner subsystem's keys). Claims are per agent: agents that share a
    view on purpose, such as a stash shared by an orchestrator and its subagents, never conflict.

    Args:
        agent: The agent the subsystem is attached to.
        owner: The subsystem instance; re-claiming by the same owner replaces its earlier claim.
        name: Subsystem name for the error message.
        storage: The subsystem's resolved storage view.
        exclusive: Whether the subsystem lists or deletes everything under its root.

    Raises:
        ValueError: If the location overlaps another subsystem's storage on the same agent.
    """
    backend, path = _storage_location(storage)
    claim = _StorageClaim(owner, name, backend, path, exclusive)
    try:
        claims = _STORAGE_CLAIMS.setdefault(agent, [])
    except TypeError:
        return  # agent cannot be weakly referenced; skip the check
    claims[:] = [existing for existing in claims if existing.owner is not owner]
    for existing in claims:
        if existing.backend is not backend and existing.backend != backend:
            continue
        nested = path.startswith(existing.path) and existing.exclusive
        encloses = existing.path.startswith(path) and exclusive
        if path == existing.path or nested or encloses:
            raise ValueError(
                f"{name} storage at '{path or '<root>'}' overlaps {existing.name} storage at "
                f"'{existing.path or '<root>'}' on the same agent. Give each subsystem its own namespace."
            )
    claims.append(claim)
