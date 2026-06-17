/**
 * Content-aware routing of messages to different compression methods.
 *
 * The {@link ContentRouter} inspects each candidate message, classifies it, and
 * dispatches it to the method configured for that category. Unmatched content
 * uses the `default` route (truncate, if unspecified). Because it implements
 * {@link CompressionMethod}, a router is itself a method — it can be the top-level
 * method on a ContextManager or nested inside another composite.
 */

import type { Message } from '../types/messages.js'
import type { CompressionMethod, MethodLike, TokenBudget } from './types.js'
import { categorize, type ContentCategory } from './content.js'
import { resolveMethod } from './methods.js'

/** Route configuration for the {@link ContentRouter}. */
export interface ContentRoutes {
  /** Method for messages carrying tool results. */
  toolResults?: MethodLike
  /** Method for messages carrying failed tool results. */
  toolResultErrors?: MethodLike
  /** Method for assistant messages. */
  assistantMessages?: MethodLike
  /** Method for user messages. */
  userMessages?: MethodLike
  /** Method for messages containing images. */
  images?: MethodLike
  /** Method for messages containing documents. */
  documents?: MethodLike
  /** Method for messages classified as code. */
  code?: MethodLike
  /** Method for messages classified as JSON. */
  json?: MethodLike
  /** Method for content not matched by any other route. Defaults to `truncate`. */
  default?: MethodLike
}

/**
 * Dispatches each message to the method configured for its content category.
 */
export class ContentRouter implements CompressionMethod {
  readonly name = 'content-router'

  private readonly _routes: ContentRoutes
  private readonly _resolved = new Map<MethodLike, CompressionMethod>()

  constructor(routes: ContentRoutes) {
    this._routes = routes
  }

  /** The raw route configuration, exposed for the ContextManager and tests. */
  get routes(): ContentRoutes {
    return this._routes
  }

  /** Every distinct method spec referenced by this router. */
  methodSpecs(): MethodLike[] {
    return Object.values(this._routes).filter((m): m is MethodLike => m !== undefined)
  }

  async compress(messages: Message[], budget: TokenBudget): Promise<Message[]> {
    // Group consecutive messages by route so methods like summarize that fold a
    // run into one message receive the whole run, not message-by-message calls.
    const out: Message[] = []
    let i = 0
    while (i < messages.length) {
      const spec = this._routeFor(messages[i]!)
      const group: Message[] = [messages[i]!]
      let j = i + 1
      while (j < messages.length && this._routeFor(messages[j]!) === spec) {
        group.push(messages[j]!)
        j++
      }
      const method = this._method(spec)
      out.push(...(await method.compress(group, budget)))
      i = j
    }
    return out
  }

  /** Resolve the concrete method that will handle a given message. */
  resolvedMethodFor(message: Message): CompressionMethod {
    return this._method(this._routeFor(message))
  }

  private _routeFor(message: Message): MethodLike {
    const category = categorize(message)
    const fromCategory = this._routes[category as keyof ContentRoutes]
    return fromCategory ?? this._routes.default ?? 'truncate'
  }

  private _method(spec: MethodLike): CompressionMethod {
    let method = this._resolved.get(spec)
    if (!method) {
      method = resolveMethod(spec)
      this._resolved.set(spec, method)
    }
    return method
  }
}

/** Re-export for callers building routes programmatically. */
export type { ContentCategory }
