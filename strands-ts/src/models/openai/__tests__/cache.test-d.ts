import { describe, it } from 'vitest'
import { applyCacheConfig } from '../cache.js'
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'

declare const chatRequest: ChatCompletionCreateParamsStreaming
declare const responsesRequest: ResponseCreateParamsStreaming

describe('applyCacheConfig request type', () => {
  it('accepts both openai streaming request shapes', () => {
    // `CacheableRequest` has to stay assignable from the vendor types for every `openai` release the
    // dependency range permits, which a pinned lockfile otherwise hides until a consumer installs a newer one.
    applyCacheConfig(chatRequest, undefined)
    applyCacheConfig(responsesRequest, undefined)
  })
})
