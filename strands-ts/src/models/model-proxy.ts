import { unwrapInvocationContext, type InvocationContext } from '../agent/invocation-context.js'
import { Message, OffloadedBlock, TextBlock, ToolResultBlock } from '../types/messages.js'
import type { ContentBlock, ToolResultContent } from '../types/messages.js'
import type { Model, StreamAggregatedResult, StreamOptions } from './model.js'
import type { ModelStreamEvent } from './streaming.js'

/**
 * SDK-internal wrapper between the agent and its model. The agent loop and every
 * auxiliary call route their model calls through it. It renders SDK-owned blocks
 * into the form providers accept (see {@link renderForModel}) and adds a model
 * call's token usage to its request. The {@link InvocationContext} is passed per
 * call rather than on {@link StreamOptions}, so providers never see request state.
 * Usage is added only when the call returns normally and the provider reported
 * it; a thrown error passes through and adds nothing.
 *
 * @internal
 */
export class ModelProxy {
  private readonly _model: Model

  constructor(model: Model) {
    this._model = model
  }

  /**
   * Delegates to the wrapped model's `streamAggregated` with the rendered
   * messages, passing every event through unchanged, then adds the call's
   * usage to the request.
   *
   * @param messages - The conversation history to send to the model
   * @param options - Optional streaming configuration
   * @param invocationContext - The request to add the usage to, or `undefined` to add it nowhere
   * @returns Async generator mirroring {@link Model.streamAggregated}
   */
  async *streamAggregated(
    messages: Message[],
    options?: StreamOptions,
    invocationContext?: InvocationContext
  ): AsyncGenerator<ModelStreamEvent | ContentBlock, StreamAggregatedResult, undefined> {
    const result = yield* this._model.streamAggregated(renderForModel(messages), options)
    this._record(result, invocationContext)
    return result
  }

  /** Adds a completed call's reported usage to the request. */
  private _record(result: StreamAggregatedResult, invocationContext?: InvocationContext): void {
    const usage = result?.metadata?.usage
    const context = unwrapInvocationContext(invocationContext)
    if (usage !== undefined && context !== undefined) {
      context.recordUsage(usage)
    }
  }
}

/**
 * Replaces each {@link OffloadedBlock} with the text block the model receives, in place,
 * descending into tool-result content. A message with nothing to render is returned as
 * the same instance; `agent.messages` is never modified.
 *
 * @param messages - The conversation history as stored on the agent
 * @returns The history as providers accept it
 *
 * @internal
 */
export function renderForModel(messages: Message[]): Message[] {
  return messages.map(renderMessage)
}

function renderMessage(message: Message): Message {
  const content = message.content.map(renderBlock)
  if (content.every((block, index) => block === message.content[index])) return message
  return new Message({
    role: message.role,
    content,
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}

function renderBlock(block: ContentBlock): ContentBlock {
  if (block instanceof OffloadedBlock) return new TextBlock(block.toText())
  if (!(block instanceof ToolResultBlock) || !block.content.some((item) => item instanceof OffloadedBlock)) {
    return block
  }
  const content = block.content.map((item): ToolResultContent =>
    item instanceof OffloadedBlock ? new TextBlock(item.toText()) : item
  )
  return new ToolResultBlock({
    toolUseId: block.toolUseId,
    status: block.status,
    content,
    ...(block.error !== undefined && { error: block.error }),
  })
}
