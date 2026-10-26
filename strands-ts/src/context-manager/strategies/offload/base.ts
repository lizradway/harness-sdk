/**
 * Base offload strategy and shared infrastructure.
 */

import { logger } from '../../../logging/logger.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import {
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  CachePointBlock,
  ReasoningBlock,
} from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import { AudioBlock, DocumentBlock, ImageBlock, VideoBlock } from '../../../types/media.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import { formatStashRefs, type Stash } from '../../stash.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../../../models/defaults.js'

/**
 * Target for offload operations. This union is intentionally extensible — new
 * string-literal members can be added freely as new content categories emerge.
 *
 * - `"toolResults"` — all successful tool result blocks
 * - `"toolResultErrors"` — all failed tool result blocks
 * - `"assistantText"` — text blocks in assistant messages
 * - `"userText"` — text blocks in user messages (excluding tool results)
 * - `"media"` — image, document, video, and audio blocks outside tool results
 * - `string[]` — tool results from specific tools (e.g. `['bash']` or `['tool::bash']`); prefix with `!` to exclude
 * - `"*"` — whole messages
 *
 * @experimental
 */
export type OffloadTarget = '*' | 'toolResults' | 'toolResultErrors' | 'assistantText' | 'userText' | 'media' | string[]

/**
 * A share of a whole, written as a percent string such as `'70%'` or `'12.5%'`.
 *
 * @experimental
 */
export type Percent = `${number}%`

/**
 * Conditions that determine when and how an offload strategy fires.
 *
 * - `utilization` sets when the strategy fires. `'80%'` or `0.8` fires at 80% of the context window; a whole number
 *   above 1 fires at that many conversation tokens, and throws if it exceeds the model's `contextWindowLimit`.
 * - `threshold` sets how large content must be to act on. A whole number selects content larger than that many
 *   tokens; `'5%'` selects content larger than 5% of the context window (10,000 tokens of a 200,000-token window).
 * - `preserveRecent` sets which matching messages it never touches. A whole number keeps that many of the newest;
 *   `'70%'` or `0.7` keeps the newest 70% of them.
 *
 * With no `utilization`, the strategy runs before every model call, or on each message as it arrives when the target
 * isn't `'*'` and `preserveRecent` is unset.
 *
 * Granularity: target `'*'` acts on whole messages, and `threshold` measures each message. Drop removes them,
 * summarize merges each contiguous run, and truncate elides the middle or, with a `threshold`, shortens each one. Any
 * other target acts on each block, and `threshold` measures each block. `utilization` only gates when the strategy
 * fires, and `preserveRecent` only protects the newest matching messages.
 *
 * Strategies run as an ordered pipeline, so once an earlier strategy shrinks a block, it falls below the next
 * strategy's threshold and gets skipped.
 *
 * @experimental
 */
export interface OffloadConditions {
  /**
   * Context usage at or above which the strategy fires: `'80%'` or `0.8` for a share of the context window, or a whole
   * number above 1 for conversation tokens, at most the model's `contextWindowLimit`. `1` is 100%.
   */
  utilization?: number | Percent

  /**
   * Size above which a message (target `'*'`) or block is offloaded: a whole number of tokens above 0, or `'5%'` of the
   * context window. Unset, content of any size is offloaded.
   */
  threshold?: number | Percent

  /**
   * Newest matching messages never touched: a count, or `'70%'` / `0.7` of the matches, rounded up so a share always
   * keeps at least one.
   */
  preserveRecent?: number | Percent
}

/**
 * Result of `Offload.drop/truncate/summarize`. Call `.when()` to get a strategy; pass `{}` to run on every new
 * message.
 *
 * @experimental
 */
export interface OffloadStrategyBuilder {
  /** Sets the conditions that determine when and how this strategy fires, and returns the strategy. */
  when(conditions: OffloadConditions): ContextStrategy
}

// --- Condition parsing ---

type ConditionName = keyof OffloadConditions

/**
 * A parsed condition: a count in the condition's unit, or a share of the whole.
 *
 * @internal
 */
export interface ParsedCondition {
  /** The count, or the share in `[0, 1]`. */
  value: number

  /** Whether `value` is a share of the whole rather than a count. */
  isShare: boolean
}

interface ConditionRule {
  /** Whether a `'N%'` value's N is in range. */
  percentInRange(percent: number): boolean

  /** Parses a finite non-negative number, or returns undefined to reject it. */
  parseNumber(value: number): ParsedCondition | undefined

  /** Accepted values, for error messages. */
  expected: string
}

const PERCENT_PATTERN = /^\d+(\.\d+)?%$/

const CONDITION_RULES: Record<ConditionName, ConditionRule> = {
  utilization: {
    percentInRange: (percent) => percent > 0 && percent <= 100,
    parseNumber: (value) => {
      if (value > 0 && value <= 1) return { value, isShare: true }
      if (value > 1 && Number.isInteger(value)) return { value, isShare: false }
      return undefined
    },
    expected: 'a "N%" string up to "100%", a fraction in (0, 1], or a whole token count',
  },
  threshold: {
    percentInRange: (percent) => percent > 0 && percent <= 100,
    parseNumber: (value) => (Number.isInteger(value) && value >= 1 ? { value, isShare: false } : undefined),
    expected: 'a whole token count above 0 or a "N%" string up to "100%"',
  },
  preserveRecent: {
    percentInRange: (percent) => percent >= 0 && percent < 100,
    parseNumber: (value) => {
      if (Number.isInteger(value)) return { value, isShare: false }
      if (value < 1) return { value, isShare: true }
      return undefined
    },
    expected: 'a whole message count, a "N%" string below "100%", or a fraction in [0, 1)',
  },
}

/**
 * Parses one offload condition value.
 *
 * @param name - The condition name
 * @param raw - The value as supplied, or undefined when unset
 * @returns The parsed condition, or undefined when unset
 * @throws Error when the value is not accepted for the condition
 * @internal
 */
export function parseCondition(name: ConditionName, raw: unknown): ParsedCondition | undefined {
  if (raw === undefined) return undefined
  const rule = CONDITION_RULES[name]
  const parsed = typeof raw === 'string' ? parsePercent(raw, rule) : parseNumber(raw, rule)
  if (!parsed) {
    throw new Error(`${name}=${formatConditionValue(raw)} is invalid: expected ${rule.expected}`)
  }
  return parsed
}

function parsePercent(raw: string, rule: ConditionRule): ParsedCondition | undefined {
  if (!PERCENT_PATTERN.test(raw)) return undefined
  const percent = Number(raw.slice(0, -1))
  return rule.percentInRange(percent) ? { value: percent / 100, isShare: true } : undefined
}

function parseNumber(raw: unknown, rule: ConditionRule): ParsedCondition | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined
  return rule.parseNumber(raw)
}

function validateConditionNames(conditions: OffloadConditions | undefined): void {
  for (const name of Object.keys(conditions ?? {})) {
    if (!(name in CONDITION_RULES)) {
      throw new Error(`unknown condition "${name}": expected utilization, threshold, or preserveRecent`)
    }
  }
}

function formatConditionValue(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : String(raw)
}

/** The model's context window limit, falling back to the default `estimateUtilization` uses. */
function effectiveWindowLimit(agent: LocalAgent): number {
  return agent.model.getConfig().contextWindowLimit || DEFAULT_CONTEXT_WINDOW_LIMIT
}

/**
 * Throws if an offload target matches nothing.
 *
 * @param target - The offload target
 * @throws Error when the target is an empty array
 * @internal
 */
export function validateTarget(target: OffloadTarget | undefined): void {
  if (Array.isArray(target) && target.length === 0) {
    throw new Error('Empty array target matches nothing — provide at least one target')
  }
}

// --- Shared helpers ---

/**
 * Format an `[Offloaded]` marker naming the media kind, leaving out a size the token count could not measure.
 *
 * @internal
 */
export function formatOffloaded(block: ContentBlock, tokens: number, stashRefs: string[]): string {
  const refs = formatStashRefs(stashRefs)
  if (isMediaBlock(block)) {
    const size = tokens ? `, ~${tokens} tokens` : ''
    return `[Offloaded: ${mediaKind(block)}${size}, removed from context after it was viewed]${refs}`
  }
  const size = tokens ? `: ~${tokens} tokens` : ''
  return `[Offloaded${size}]${refs}`
}

/**
 * Builds a toolUseId → toolName map from all assistant messages in the conversation.
 * Called once per apply() to avoid O(messages × toolResults) scanning.
 */
export function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) {
        map.set(block.toolUseId, block.name)
      }
    }
  }
  return map
}

export function toolMatchesTarget(
  block: ToolResultBlock,
  target: OffloadTarget,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): boolean {
  if (target === '*') return true
  if (target === 'toolResults') return block.status === 'success'
  if (target === 'toolResultErrors') return block.status === 'error'

  const toolName = toolNameMap.get(block.toolUseId)
  if (!toolName) return false

  if (toolExcludeFilter) return !toolExcludeFilter.has(toolName)
  if (toolIncludeFilter) return toolIncludeFilter.has(toolName)

  return false
}

/**
 * Whether a block is an image, document, video, or audio block.
 *
 * @internal
 */
export function isMediaBlock(block: ContentBlock): block is ImageBlock | DocumentBlock | VideoBlock | AudioBlock {
  return (
    block instanceof ImageBlock ||
    block instanceof DocumentBlock ||
    block instanceof VideoBlock ||
    block instanceof AudioBlock
  )
}

/**
 * The media kind of a block, such as `'image'`, for markers.
 *
 * @internal
 */
export function mediaKind(block: ImageBlock | DocumentBlock | VideoBlock | AudioBlock): string {
  return block.type.replace(/Block$/, '')
}

export function targetMatchesMessage(target: OffloadTarget | undefined, message: Message): boolean {
  if (target === undefined || target === '*') return true
  if (target === 'assistantText')
    return message.role === 'assistant' && message.content.some((b) => b instanceof TextBlock)
  if (target === 'userText') return message.role === 'user' && message.content.some((b) => b instanceof TextBlock)
  return false
}

export function messageMatchesTarget(
  message: Message,
  target: OffloadTarget | undefined,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): boolean {
  if (targetMatchesMessage(target, message)) return true
  if (!target) return false
  if (target === 'media') return message.content.some(isMediaBlock)

  // Tool result targets — must be a user message with a matching tool result
  if (message.role !== 'user') return false
  for (const block of message.content) {
    if (block instanceof ToolResultBlock) {
      if (toolMatchesTarget(block, target, toolNameMap, toolIncludeFilter, toolExcludeFilter)) return true
    }
  }
  return false
}

/**
 * Returns target-matching messages excluding the most recent matches.
 * First filters to only messages that match the target, then removes the tail.
 *
 * @param preserveRecent - Integer (1 or above): absolute count. Decimal (between 0 and 1 exclusive): ratio of matches to keep.
 */
export function getOldestMatches(
  messages: Message[],
  target: OffloadTarget | undefined,
  preserveRecent: number,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): Message[] {
  const matching = messages.filter((message) =>
    messageMatchesTarget(message, target, toolNameMap, toolIncludeFilter, toolExcludeFilter)
  )
  const count =
    preserveRecent > 0 && preserveRecent < 1 ? Math.ceil(matching.length * preserveRecent) : Math.floor(preserveRecent)
  if (count >= matching.length) return []
  return matching.slice(0, -count)
}

/**
 * Collects a message and its paired partner (if any) for safe removal.
 * If removing a message would orphan a tool-use/tool-result pair, includes the partner
 * so the pair is removed together. Never collects message 0 or the last message, which the
 * next model call responds to.
 */
export function collectRemovableWithPair(messages: Message[], index: number): Message[] {
  const message = messages[index]
  if (!message) return []
  if (index === 0 || index === messages.length - 1) return []

  const result: Message[] = [message]

  const hasToolResult = message.content.some((block) => block instanceof ToolResultBlock)
  if (hasToolResult) {
    const prev = messages[index - 1]
    if (prev && prev.content.some((block) => block instanceof ToolUseBlock)) {
      if (index - 1 > 0) result.push(prev)
      else return []
    }
  }

  const hasToolUse = message.content.some((block) => block instanceof ToolUseBlock)
  if (hasToolUse) {
    const next = messages[index + 1]
    if (next && next.content.some((block) => block instanceof ToolResultBlock)) {
      if (index + 1 < messages.length - 1) result.push(next)
      else return []
    }
  }

  return result
}

/**
 * Collects removable messages (with their tool pairs), then splices them from the array.
 * Returns the number of messages removed and the lowest index that was removed.
 */
export function spliceWithPairs(messages: Message[], toRemove: Message[]): { removed: number; lowestIndex: number } {
  const toSplice = new Set<Message>()
  for (const message of toRemove) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    for (const removable of collectRemovableWithPair(messages, index)) {
      toSplice.add(removable)
    }
  }

  let removed = 0
  let lowestIndex = messages.length
  for (const message of toSplice) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    if (index < lowestIndex) lowestIndex = index
    messages.splice(index, 1)
    removed++
  }
  return { removed, lowestIndex }
}

/**
 * Adds a removal marker as assistant content at the gap left by removed messages.
 *
 * The marker is appended to an assistant message beside the gap, which keeps that message's
 * tracking id and block indices for stash refs, or becomes its own assistant message. It never
 * joins message 0, and the last message is never removed, so a new marker never ends the history.
 */
export function insertMarker(messages: Message[], index: number, text: string): void {
  index = Math.max(1, Math.min(index, messages.length))
  const block = new TextBlock(text)
  for (const neighbor of [index - 1, index]) {
    const carrier = messages[neighbor]
    if (neighbor > 0 && carrier?.role === 'assistant') {
      messages[neighbor] = new Message({
        role: 'assistant',
        content: [...carrier.content, block],
        trackingId: carrier.trackingId,
        ...(carrier.metadata ? { metadata: carrier.metadata } : {}),
      })
      return
    }
  }
  messages.splice(index, 0, new Message({ role: 'assistant', content: [block] }))
}

/**
 * Merges consecutive same-role messages to restore the user/assistant alternation
 * that Anthropic/Bedrock APIs require. Called after message-level operations that
 * may leave gaps. Constructs new Message objects for merges to avoid mutating
 * objects that may be referenced elsewhere (session storage, event payloads).
 */
export function repairAlternation(messages: Message[]): void {
  let writeIndex = 0
  for (let readIndex = 0; readIndex < messages.length; readIndex++) {
    const current = messages[readIndex]!
    if (writeIndex > 0 && messages[writeIndex - 1]!.role === current.role) {
      const prev = messages[writeIndex - 1]!
      const pinned = prev.metadata?.custom?.pinned === true || current.metadata?.custom?.pinned === true
      messages[writeIndex - 1] = new Message({
        role: prev.role,
        content: [...prev.content, ...current.content],
        trackingId: prev.trackingId,
        ...(pinned ? { metadata: { custom: { pinned: true } } } : {}),
      })
    } else {
      messages[writeIndex] = current
      writeIndex++
    }
  }
  messages.length = writeIndex
}

/**
 * Parses a string[] target into include/exclude filter sets.
 * Entries must be prefixed with `tool::` (e.g. `'tool::bash'`).
 * An additional `!` prefix excludes (e.g. `'!tool::bash'`).
 */
export function resolveToolFilter(target: OffloadTarget | undefined): { include?: Set<string>; exclude?: Set<string> } {
  if (!Array.isArray(target)) return {}

  const TOOL_PREFIX = 'tool::'
  const includes: string[] = []
  const excludes: string[] = []

  for (const entry of target) {
    if (entry.startsWith('!')) {
      const name = entry.slice(1)
      excludes.push(name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name)
    } else {
      includes.push(entry.startsWith(TOOL_PREFIX) ? entry.slice(TOOL_PREFIX.length) : entry)
    }
  }

  if (excludes.length > 0 && includes.length > 0) {
    logger.warn('tool filter contains both includes and excludes, excludes will be ignored')
    return { include: new Set(includes) }
  }
  if (excludes.length > 0) {
    return { exclude: new Set(excludes) }
  }
  if (includes.length > 0) {
    return { include: new Set(includes) }
  }

  return {}
}

// --- Base strategy class ---

const NO_PRESERVE: ParsedCondition = { value: 0, isShare: false }

/** Shared offload logic: condition parsing, firing, granularity, eager hooks, preserveRecent. */
export abstract class BaseOffloadStrategy implements ContextStrategy {
  readonly name: string

  protected readonly _target: OffloadTarget | undefined
  protected readonly _threshold: ParsedCondition | undefined
  protected readonly _utilization: ParsedCondition | undefined
  protected readonly _preserveRecent: ParsedCondition
  protected readonly _includeFilter: Set<string> | undefined
  protected readonly _excludeFilter: Set<string> | undefined
  protected _stash: Stash | undefined

  /**
   * @param name - Strategy name, `offload:<method>`
   * @param target - Content the strategy acts on
   * @param conditions - When and how the strategy fires; omitted only by internal strategies
   * @throws Error when the target is empty, a condition value is invalid, or a whole-message strategy has none of
   *   `utilization`, `threshold`, or `preserveRecent`
   */
  constructor(name: string, target?: OffloadTarget, conditions?: OffloadConditions) {
    validateTarget(target)
    validateConditionNames(conditions)

    this.name = name
    this._target = target
    this._utilization = parseCondition('utilization', conditions?.utilization)
    this._threshold = parseCondition('threshold', conditions?.threshold)
    this._preserveRecent = parseCondition('preserveRecent', conditions?.preserveRecent) ?? NO_PRESERVE

    const resolved = resolveToolFilter(target)
    this._includeFilter = resolved.include
    this._excludeFilter = resolved.exclude

    if (conditions && this._actsOnMessages && this._isUnconditional) {
      const method = name.slice(name.indexOf(':') + 1)
      throw new Error(
        `Offload.${method}("*") would act on every message; set utilization, threshold, or preserveRecent`
      )
    }
  }

  /** Whether this strategy acts on whole messages rather than individual blocks. */
  protected get _actsOnMessages(): boolean {
    return this._target === '*'
  }

  /** Whether no condition narrows when or what the strategy acts on. */
  private get _isUnconditional(): boolean {
    return this._utilization === undefined && this._threshold === undefined && this._preserveRecent.value === 0
  }

  /** Whether the eager hook processes each message as it arrives. */
  private get _runsEagerly(): boolean {
    return this._utilization === undefined && this._preserveRecent.value === 0 && !this._actsOnMessages
  }

  /**
   * Checks utilization against the model's context window, then registers the eager hook if this runs eagerly.
   *
   * @param agent - The agent this strategy is attached to
   * @param stash - The stash offloaded content is stored in
   * @throws Error when `utilization` is a token count larger than the model's `contextWindowLimit`
   */
  init(agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
    this._checkUtilizationFits(agent)
    if (!this._runsEagerly) return
    agent.addHook(MessageAddedEvent, async (event) => {
      const messages = event.agent.messages
      const index = messages.indexOf(event.message)
      if (index >= 0 && isPinned(messages, index)) return
      const toolNameMap = buildToolNameMap(messages)
      const threshold = this._resolveThreshold(event.agent)
      await this._transformBlocks(event.message, messages, toolNameMap, threshold, event.agent)
    })
  }

  async apply(context: ContextState): Promise<boolean> {
    if (context.stash) this._stash = context.stash
    if (!this._utilizationReached(context)) return false
    return this._actsOnMessages ? this._applyPerMessage(context) : this._applyPerBlock(context)
  }

  private _checkUtilizationFits(agent: LocalAgent): void {
    const utilization = this._utilization
    if (!utilization || utilization.isShare) return
    const limit = agent.model.getConfig().contextWindowLimit
    if (!limit) {
      logger.warn(
        `utilization=<${utilization.value}> | contextWindowLimit is not set on the model, skipping the context window check | set contextWindowLimit in your model config`
      )
      return
    }
    if (utilization.value <= limit) return
    throw new Error(
      `utilization (${utilization.value}) is larger than the model's context window (${limit} tokens); use a smaller token count or a "N%" share`
    )
  }

  /** Whether the utilization gate (if any) is open: on overflow, or at or above the configured share. */
  private _utilizationReached(context: ContextState): boolean {
    const utilization = this._utilization
    if (!utilization || context.overflow) return true
    const share = utilization.isShare ? utilization.value : utilization.value / effectiveWindowLimit(context.agent)
    return context.utilization >= share
  }

  /** Tokens above which content is offloaded, or undefined when `threshold` is unset so no size check applies. */
  private _resolveThreshold(agent: LocalAgent): number | undefined {
    const threshold = this._threshold
    if (!threshold) return undefined
    return threshold.isShare ? Math.ceil(threshold.value * effectiveWindowLimit(agent)) : threshold.value
  }

  /** Per-block execution: walk each message, transform individual blocks above threshold. */
  private async _applyPerBlock(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    const invocationContext = context.invocationContext
    const toolNameMap = buildToolNameMap(messages)
    const threshold = this._resolveThreshold(agent)
    const eligible = this._preserveRecent.value > 0 ? this._oldestMatches(messages, toolNameMap) : [...messages]
    let acted = false

    for (const message of eligible) {
      // Without the eager hook, message 0 is the task and the last message is one the model has not yet responded to.
      if (!this._runsEagerly && (message === messages[0] || message === messages.at(-1))) continue
      const index = messages.indexOf(message)
      if (isPinned(messages, index)) continue
      if (await this._transformBlocks(message, messages, toolNameMap, threshold, agent, invocationContext)) {
        acted = true
      }
    }

    return acted
  }

  /** Message-level execution: remove eligible messages with pair safety. */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    const { removed, lowestIndex } = spliceWithPairs(messages, eligible)
    if (removed === 0) return false

    const marker = this._makeRemovalMarker(removed)
    if (marker) {
      insertMarker(messages, lowestIndex, marker)
    }

    repairAlternation(messages)
    return true
  }

  /** Override to insert a marker when messages are removed. Return null for no marker. */
  protected _makeRemovalMarker(_count: number): string | null {
    return null
  }

  /** Whether a block is eligible for offload given the current target and filters. */
  protected _blockMatchesTarget(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (block instanceof ToolUseBlock) return false
    if (block instanceof CachePointBlock) return false
    if (block instanceof ReasoningBlock) return false
    if (block instanceof TextBlock) return block.text.trim() !== '' && targetMatchesMessage(this._target, message)
    if (block instanceof ToolResultBlock) {
      if (this._stash && toolNameMap.get(block.toolUseId) === RETRIEVAL_TOOL_NAME) return false
      return (
        this._target === undefined ||
        toolMatchesTarget(block, this._target, toolNameMap, this._includeFilter, this._excludeFilter)
      )
    }
    if (this._target === '*' || this._target === undefined) return true
    return this._target === 'media' && isMediaBlock(block)
  }

  /** Process eligible blocks in a message, replacing each one larger than `threshold` tokens, or every one if unset. */
  protected async _transformBlocks(
    message: Message,
    messages: Message[],
    toolNameMap: Map<string, string>,
    threshold: number | undefined,
    agent: LocalAgent,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    let acted = false
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (!this._blockMatchesTarget(block, message, toolNameMap)) continue

      const tokens = await agent.model.countTokens([new Message({ role: message.role, content: [block] })])
      if (threshold !== undefined && tokens <= threshold) continue

      const stashRefs = this._stash?.refsFor(block, message, blockIndex) ?? []
      const replacement = await this._replaceBlock(block, tokens, message, agent, stashRefs, invocationContext)
      if (replacement && replacement !== block) {
        ;(message.content as unknown[])[blockIndex] = replacement
        acted = true
      }
    }
    return acted
  }

  /**
   * Messages outside `preserveRecent` and larger than `threshold`, excluding message 0 and pinned messages, in
   * history order.
   */
  protected async _getEligibleMessages(context: ContextState): Promise<Message[]> {
    const { messages, agent } = context
    const candidates =
      this._preserveRecent.value > 0 ? this._oldestMatches(messages, buildToolNameMap(messages)) : messages
    const eligible = candidates.filter((message) => {
      const index = messages.indexOf(message)
      return index > 0 && !isPinned(messages, index)
    })
    const threshold = this._resolveThreshold(agent)
    if (threshold === undefined) return eligible

    const larger: Message[] = []
    for (const message of eligible) {
      if ((await agent.model.countTokens([message])) > threshold) larger.push(message)
    }
    return larger
  }

  private _oldestMatches(messages: Message[], toolNameMap: Map<string, string>): Message[] {
    return getOldestMatches(
      messages,
      this._target,
      this._preserveRecent.value,
      toolNameMap,
      this._includeFilter,
      this._excludeFilter
    )
  }

  /** Transform a block. Return the replacement, or null to skip. */
  protected abstract _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRefs: string[],
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null>
}

// --- Emergency truncation strategy ---

const EMERGENCY_REMOVAL_RATIO = 0.2

/**
 * Last-resort strategy that recomputes utilization and drops the oldest 20% of messages
 * when the context window is still overflowing after all user-configured strategies have run.
 * Appended internally by ContextManager — not part of the public builder API.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy extends BaseOffloadStrategy {
  constructor() {
    super('offload:emergency-truncate', '*')
  }

  override init(_agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (context.messages.length <= 3) return false
    if (!context.overflow) {
      const tokens = await context.agent.model.countTokens(context.messages)
      const utilization = context.agent.model.estimateUtilization(tokens)
      if (utilization < 1.0) return false
    }
    return this._applyPerMessage(context)
  }

  /** Drop the oldest 20% of non-head messages each pass. */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 3) return false

    const removable = messages.filter((_, index) => index > 0)
    let removeCount = Math.max(1, Math.floor(removable.length * EMERGENCY_REMOVAL_RATIO))
    // Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
    if (removable[removeCount]?.role !== 'assistant') removeCount += 1
    const toRemove = removable.slice(0, removeCount)

    const { removed, lowestIndex } = spliceWithPairs(messages, toRemove)
    if (removed === 0) return false

    insertMarker(messages, lowestIndex, this._makeRemovalMarker(removed))
    repairAlternation(messages)
    return true
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
  }

  protected async _replaceBlock(): Promise<ContentBlock | null> {
    return null
  }
}
