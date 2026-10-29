import { describe, expect, it } from 'vitest'
import {
  formatDropped,
  formatDroppedMessages,
  formatElided,
  formatOffloaded,
  formatSummarized,
  formatTruncated,
  offloadPlaceholder,
} from '../placeholder.js'
import { TextBlock } from '../../types/messages.js'

describe('offloadPlaceholder', () => {
  it('appends the stash ref and records what the placeholder stands for', () => {
    expect(offloadPlaceholder('drop', '[Dropped: 2 messages]', 'removed-abc', 2)).toStrictEqual(
      new TextBlock('[Dropped: 2 messages] [ref: removed-abc]', {
        metadata: {
          offloaded: { method: 'drop', preview: '[Dropped: 2 messages]', ref: 'removed-abc', removedMessages: 2 },
        },
      })
    )
  })

  it('leaves out the ref when the original was not stashed', () => {
    expect(offloadPlaceholder('drop', '[Dropped]', undefined)).toStrictEqual(
      new TextBlock('[Dropped]', { metadata: { offloaded: { method: 'drop', preview: '[Dropped]' } } })
    )
  })
})

describe('markers', () => {
  it.each([
    ['a dropped block', formatDropped(), '[Dropped]'],
    ['dropped media', formatDropped('image'), '[Dropped: image, removed from context after it was viewed]'],
    ['one dropped message', formatDroppedMessages(1), '[Dropped: 1 message]'],
    ['dropped messages', formatDroppedMessages(3), '[Dropped: 3 messages]'],
    ['an offloaded block', formatOffloaded(2525), '[Offloaded: ~2,525 tokens]'],
    ['an unmeasured block', formatOffloaded(0), '[Offloaded]'],
    [
      'offloaded media',
      formatOffloaded(2525, 'document'),
      '[Offloaded: document, ~2,525 tokens, removed from context after it was viewed]',
    ],
    ['unmeasured media', formatOffloaded(0, 'image'), '[Offloaded: image, removed from context after it was viewed]'],
    ['a summary', formatSummarized('tool result', 2525, 'short'), '[Summarized: tool result, ~2,525 tokens]\n\nshort'],
    [
      'an unmeasured summary',
      formatSummarized('media block', 0, 'a red square'),
      '[Summarized: media block]\n\na red square',
    ],
    ['a truncated block', formatTruncated(1, 7500, 'head'), '[Truncated: 1 block, ~7,500 tokens]\n\nhead'],
    ['truncated blocks', formatTruncated(2, 7500, 'head'), '[Truncated: 2 blocks, ~7,500 tokens]\n\nhead'],
    ['one elided message', formatElided(1), '[... 1 message elided ...]'],
    ['elided messages', formatElided(7), '[... 7 messages elided ...]'],
  ])('formats %s', (_case, text, expected) => {
    expect(text).toBe(expected)
  })
})
