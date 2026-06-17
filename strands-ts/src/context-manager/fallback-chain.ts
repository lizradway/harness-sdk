/**
 * A composite method that tries each member in order, falling back on failure.
 *
 * Useful for third-party methods that may be unavailable: if a managed
 * compression API is down, the chain falls through to a local method so the
 * agent keeps running.
 */

import type { Message } from '../types/messages.js'
import { logger } from '../logging/logger.js'
import type { CompressionMethod, MethodLike, TokenBudget } from './types.js'
import { resolveMethod } from './methods.js'

/**
 * Tries each method in order. If one throws, the next is attempted. The last
 * method's error propagates if every method fails.
 */
export class FallbackChain implements CompressionMethod {
  readonly name = 'fallback-chain'

  private readonly _methods: CompressionMethod[]

  constructor(methods: MethodLike[]) {
    if (methods.length === 0) throw new Error('FallbackChain requires at least one method')
    this._methods = methods.map(resolveMethod)
  }

  async compress(messages: Message[], budget: TokenBudget): Promise<Message[]> {
    let lastError: unknown
    for (let i = 0; i < this._methods.length; i++) {
      const method = this._methods[i]!
      try {
        return await method.compress(messages, budget)
      } catch (err) {
        lastError = err
        logger.warn(`method=<${method.name}> | compression method failed, trying next in chain | error=<${err}>`)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All methods in FallbackChain failed')
  }
}
