"""L1 stash — durable storage for offloaded context content.

When the ContextManager offloads content, the original is persisted here
so the agent can retrieve it on demand via the retrieval tool.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import TYPE_CHECKING, Any

from ..storage.storage import _NamespacedStorage, _resolve_namespace
from ..types.content import ContentBlock

if TYPE_CHECKING:
    from ..storage.storage import Storage
    from ..types.content import Message

logger = logging.getLogger(__name__)

STASH_PREFIX = "context"


class _BytesEncoder(json.JSONEncoder):
    """JSON encoder that base64-encodes bytes values."""

    def default(self, obj: object) -> object:
        if isinstance(obj, (bytes, bytearray)):
            return base64.b64encode(obj).decode("ascii")
        return super().default(obj)


def _encode(value: object) -> bytes:
    return json.dumps(value, cls=_BytesEncoder).encode("utf-8")


def _decode(data: bytes) -> object:
    return json.loads(data.decode("utf-8"))


def _format_stash_refs(refs: list[str]) -> str:
    """Format stash refs as a standalone bracket token for offload placeholders.

    Returns an empty string when refs is empty. With one ref returns
    ``' [ref: <ref>]'``; with multiple returns ``' [refs: <r1>, <r2>]'``.
    Note the leading space in non-empty returns.
    """
    if not refs:
        return ""
    if len(refs) == 1:
        return f" [ref: {refs[0]}]"
    return f" [refs: {', '.join(refs)}]"


class Stash:
    """Namespaced storage wrapper for persisting offloaded content blocks."""

    def __init__(self, storage: Storage, session_id: str, agent_id: str, *, inherited: bool = False) -> None:
        """Create a stash over ``storage``.

        Args:
            storage: Storage backend or scoped view.
            session_id: Session the stash belongs to.
            agent_id: Agent the stash belongs to.
            inherited: Whether ``storage`` came from ``agent.storage``. An inherited view is shared by
                every subsystem, so the stash keeps its ``context/<session_id>/scopes/agent/<agent_id>/``
                layout under it; only a view passed in ``StashConfig.storage`` is the stash root verbatim.
        """
        root = _resolve_namespace(storage, STASH_PREFIX, inherited=inherited)
        self._base_storage = storage
        self._root = root
        # raw storage:  context/<session_id>/scopes/agent/<agent_id>/<ref>
        # scoped view:  <view>/<ref>
        # _session_storage is None for a caller-supplied view: the stash cannot tell which
        # keys under it belong to this session, so it never deletes from it.
        self._session_storage: Storage | None
        if root is storage:
            self._session_storage = None
            self._storage = root
        else:
            self._session_storage = _NamespacedStorage(root, session_id)
            self._storage = _NamespacedStorage(self._session_storage, f"scopes/agent/{agent_id}")

    @property
    def storage_type_name(self) -> str:
        """Name of the base storage class, for diagnostic logging."""
        return type(self._base_storage).__name__

    async def store(self, block_id: str, block_index: int, data: bytes, *, keep_existing: bool = False) -> str:
        """Store a content block and return its deterministic reference key.

        With ``keep_existing``, an entry already stored under the key is left untouched.
        """
        key = f"{block_id}_{block_index}"
        if keep_existing and await self._storage.read(key) is not None:
            return key
        await self._storage.write(key, data)
        return key

    def refs_for(self, block: ContentBlock, message: Message, block_index: int) -> list[str]:
        """Compute deterministic reference keys for a content block."""
        if "toolResult" in block:
            tool_result = block["toolResult"]
            return [f"{tool_result['toolUseId']}_{index}" for index in range(len(tool_result["content"]))]
        return [f"{message.get('tracking_id', 'unknown')}_{block_index}"]

    async def store_message(
        self,
        message: Message,
        skip_tool_use_ids: frozenset[str] | None = None,
        *,
        keep_existing: bool = False,
    ) -> None:
        """Eagerly persist all stashable blocks from a message.

        With ``keep_existing``, entries already stored under a block's key are left untouched.
        """
        for block_index, block in enumerate(message["content"]):
            if "toolResult" in block:
                tool_result = block["toolResult"]
                if skip_tool_use_ids and tool_result["toolUseId"] in skip_tool_use_ids:
                    continue
                await self._store_tool_result(block, keep_existing=keep_existing)
            elif "toolUse" in block or "reasoningContent" in block or "cachePoint" in block:
                continue
            else:
                try:
                    await self.store(
                        message.get("tracking_id", "unknown"), block_index, _encode(block), keep_existing=keep_existing
                    )
                except Exception:
                    logger.warning(
                        "tracking_id=<%s>, block_index=<%s> | failed to stash block",
                        message.get("tracking_id"),
                        block_index,
                        exc_info=True,
                    )

    async def retrieve(self, reference: str) -> object | None:
        """Retrieve a stashed block by reference. Returns None if not found."""
        data = await self._storage.read(reference)
        if data is None:
            return None
        return _decode(data)

    async def list(self) -> list[str]:
        """List all stashed reference keys."""
        return await self._storage.list("")

    async def delete(self, reference: str) -> None:
        """Delete a stashed entry."""
        await self._storage.delete(reference)
        logger.debug("reference=<%s> | deleted stash entry", reference)

    async def take_snapshot(self) -> dict[str, Any]:
        """Serialize all stash entries for snapshot persistence.

        Returns:
            Map of reference keys to their deserialized JSON values.
        """
        keys = await self.list()
        entries: dict[str, Any] = {}
        for key in keys:
            data = await self._storage.read(key)
            if data is not None:
                entries[key] = _decode(data)
        return entries

    async def load_snapshot(self, entries: dict[str, Any]) -> None:
        """Restore stash entries from a previously captured snapshot.

        Args:
            entries: Map of reference keys to their JSON values (from :meth:`take_snapshot`).
        """
        for key, data in entries.items():
            await self._storage.write(key, _encode(data))

    async def clear_session(self) -> None:
        """Delete the stash data attributable to this session, across all agents.

        Raw storage: everything under ``context/<session_id>/``.
        Scoped view: nothing. The view is owned by the caller, and its keys carry no session
        segment, so the caller is responsible for cleaning it up.
        """
        if self._session_storage is None:
            logger.info(
                "storage=<%s> | stash is rooted at a caller-supplied view, leaving it for the caller to clean up",
                self.storage_type_name,
            )
            return
        keys = await self._session_storage.list("")
        for key in keys:
            await self._session_storage.delete(key)

    async def _store_tool_result(self, block: ContentBlock, *, keep_existing: bool = False) -> None:
        """Store each sub-block of a tool result individually."""
        tool_result = block["toolResult"]
        for block_index, item in enumerate(tool_result["content"]):
            try:
                await self.store(tool_result["toolUseId"], block_index, _encode(item), keep_existing=keep_existing)
            except Exception:
                logger.warning(
                    "tool_use_id=<%s>, block_index=<%s> | failed to stash sub-block",
                    tool_result["toolUseId"],
                    block_index,
                    exc_info=True,
                )
