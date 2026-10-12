"""Configuration types for the FileMemoryStore."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ...memory.types import MemoryStoreConfig

if TYPE_CHECKING:
    from ...storage.search.types import SearchStrategy
    from ...storage.storage import Storage


class FileMemoryStoreConfig(MemoryStoreConfig, total=False):
    """Configuration for :class:`~strands.vended_memory_stores.file_memory_store.FileMemoryStore`.

    Attributes:
        storage: The unified Storage backend for file operations. Defaults to
            LocalFileStorage at ``./.strands/``. Keys are auto-scoped under
            ``memory/<name>/`` unless the provided storage is already namespaced, so
            stores with distinct names safely share one backend. Two stores with the same
            name on the same backend share storage -- give them different names (or
            separate storage) to isolate them.
        search_strategy: Search strategy for the default storage backend. The
            store builds its default ``LocalFileStorage`` with this strategy, so
            ``add()`` indexes each write and ``search()`` delegates to it. Cannot
            be combined with ``storage`` (raises ``ValueError``): to use a
            strategy with your own backend, pass it to that backend instead, e.g.
            ``LocalFileStorage(search_strategy=...)``, so the backend's guards
            (such as rejecting host-filesystem strategies with a sandbox) apply.
    """

    storage: Storage
    search_strategy: SearchStrategy[Any]
