/**
 * L1 stash: durable storage for offloaded context content.
 *
 * When the ContextManager offloads content from the context window, the
 * original is persisted here so the agent can retrieve it on demand via the
 * retrieval tool.
 *
 * @internal
 */

import { namespace as namespaceStorage, resolveNamespace, type Storage } from '../storage/storage.js'
import { Message, ToolResultBlock, ToolUseBlock, CachePointBlock, ReasoningBlock } from '../types/messages.js'
import type { ContentBlock } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'

/** @internal */
export const STASH_PREFIX = 'context'

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Format stash refs for display in placeholders. Returns '' when refs is empty. */
export function formatStashRefs(refs: string[]): string {
  if (refs.length === 0) return ''
  if (refs.length === 1) return ` [ref: ${refs[0]!}]`
  return ` [refs: ${refs.join(', ')}]`
}

/**
 * Wraps a Storage backend with key management and content framing for the
 * ContextManager's L1 stash.
 *
 * @internal
 */
export class Stash {
  private readonly _storage: Storage
  // Undefined for a caller-supplied view: the stash cannot tell which keys under it
  // belong to this session, so it never deletes from it.
  private readonly _sessionStorage: Storage | undefined

  /** Name of the base storage constructor, for diagnostic logging. */
  readonly storageTypeName: string

  /**
   * @param storage - Storage backend or scoped view
   * @param sessionId - Session the stash belongs to
   * @param agentId - Agent the stash belongs to
   * @param viewIsRoot - Use a scoped view as the stash root verbatim. Pass false for
   *   storage inherited from the agent: an agent-level namespace is shared by every
   *   subsystem, so the stash keeps its own `context/<sessionId>/scopes/agent/<agentId>/`
   *   layout under it.
   */
  constructor(storage: Storage, sessionId: string, agentId: string, viewIsRoot = true) {
    const root = viewIsRoot ? resolveNamespace(storage, STASH_PREFIX) : namespaceStorage(storage, STASH_PREFIX)
    // raw storage:  context/<sessionId>/scopes/agent/<agentId>/<ref>
    // scoped view:  <view>/<ref>
    if (root === storage) {
      this._sessionStorage = undefined
      this._storage = root
    } else {
      this._sessionStorage = namespaceStorage(root, sessionId)
      this._storage = namespaceStorage(this._sessionStorage, `scopes/agent/${agentId}`)
    }
    this.storageTypeName = storage.constructor.name || 'unknown'
  }

  /**
   * Store a serialized block and return a deterministic reference key.
   *
   * Keys are deterministic (`<id>_<blockIndex>`) so they can be recomputed
   * via {@link refsFor} after a process restart or snapshot restore.
   *
   * @param id - Identifier component for the key (e.g. toolUseId)
   * @param blockIndex - Index of the block within the tool result
   * @param data - Serialized bytes to persist
   * @returns Reference key for retrieval
   */
  async store(id: string, blockIndex: number, data: Uint8Array): Promise<string> {
    const key = `${id}_${blockIndex}`
    await this._storage.write(key, data)
    return key
  }

  /**
   * Compute the deterministic reference keys for a content block.
   *
   * For a {@link ToolResultBlock}, returns one key per inner content item
   * (`<toolUseId>_<i>`). For any other block, returns a single key
   * (`<trackingId>_<blockIndex>`).
   *
   * @param block - The content block
   * @param message - The message containing the block
   * @param blockIndex - Index of the block within the message
   * @returns Array of reference keys
   */
  refsFor(block: ContentBlock, message: Message, blockIndex: number): string[] {
    if (block instanceof ToolResultBlock) {
      return Array.from({ length: block.content.length }, (_, index) => `${block.toolUseId}_${index}`)
    }
    return [`${message.trackingId}_${blockIndex}`]
  }

  /**
   * Eagerly stash all content from a message on arrival.
   * Called via MessageAddedEvent so content is persisted before any strategy runs.
   *
   * @param message - The message whose content should be persisted
   * @param skipToolUseIds - ToolUseIds to skip (e.g. retrieval tool results)
   */
  async storeMessage(message: Message, skipToolUseIds?: ReadonlySet<string>): Promise<void> {
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (block instanceof ToolResultBlock) {
        if (skipToolUseIds?.has(block.toolUseId)) continue
        await this._storeToolResult(block)
      } else if (block instanceof ToolUseBlock || block instanceof CachePointBlock || block instanceof ReasoningBlock) {
        continue
      } else {
        try {
          await this.store(message.trackingId, blockIndex, encode(block.toJSON()))
        } catch (error) {
          logger.warn(`trackingId=<${message.trackingId}>, error=<${error}> | failed to stash block`)
        }
      }
    }
  }

  /**
   * Retrieve previously stashed content as its serialized JSON form.
   *
   * @param reference - Key returned by a previous store call
   * @returns The deserialized block data (from `toJSON()`), or null if not found
   */
  async retrieve(reference: string): Promise<{ data: unknown } | null> {
    const bytes = await this._storage.read(reference)
    if (bytes === null) return null
    return { data: decode(bytes) }
  }

  /**
   * List all stashed references.
   */
  async list(): Promise<string[]> {
    return this._storage.list('')
  }

  /**
   * Delete a stashed entry.
   */
  async delete(reference: string): Promise<void> {
    await this._storage.delete(reference)
    logger.debug(`reference=<${reference}> | stash entry deleted`)
  }

  /**
   * Delete the stash data attributable to this session, across all agents.
   *
   * Raw storage: everything under `context/<sessionId>/`.
   * Scoped view: nothing. The view is owned by the caller, and its keys carry no
   * session segment, so the caller is responsible for cleaning it up.
   */
  async clearSession(): Promise<void> {
    const sessionStorage = this._sessionStorage
    if (!sessionStorage) {
      logger.info(
        `storage=<${this.storageTypeName}> | stash is rooted at a caller-supplied view, leaving it for the caller to clean up`
      )
      return
    }
    const keys = await sessionStorage.list('')
    await Promise.all(keys.map((key) => sessionStorage.delete(key)))
  }

  /**
   * Serialize all stash entries into a plain object for snapshot persistence.
   *
   * @returns Map of reference keys to their stored JSON values
   */
  async takeSnapshot(): Promise<Record<string, JSONValue>> {
    const keys = await this.list()
    const results = await Promise.all(keys.map((key) => this.retrieve(key).then((result) => [key, result] as const)))
    const entries: Record<string, JSONValue> = {}
    for (const [key, result] of results) {
      if (result) {
        entries[key] = result.data as JSONValue
      }
    }
    return entries
  }

  /**
   * Restore stash entries from a previously captured snapshot.
   *
   * @param entries - Map of reference keys to their JSON values (from {@link takeSnapshot})
   */
  async loadSnapshot(entries: Record<string, JSONValue>): Promise<void> {
    await Promise.all(Object.entries(entries).map(([key, data]) => this._storage.write(key, encode(data))))
  }

  private async _storeToolResult(block: ToolResultBlock): Promise<void> {
    for (let blockIndex = 0; blockIndex < block.content.length; blockIndex++) {
      const item = block.content[blockIndex]!
      try {
        await this.store(block.toolUseId, blockIndex, encode(item.toJSON()))
      } catch (error) {
        logger.warn(
          `toolUseId=<${block.toolUseId}>, blockIndex=<${blockIndex}>, error=<${error}> | failed to stash sub-block`
        )
      }
    }
  }
}
