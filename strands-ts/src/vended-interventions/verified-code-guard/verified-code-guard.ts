import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny, guide } from '../../interventions/actions.js'
import type { Proceed, Deny, Guide } from '../../interventions/actions.js'
import type { AfterToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import type { JSONValue } from '../../types/json.js'

const DEFAULT_TOOL_NAMES = ['write_file', 'apply_patch', 'edit_file']

/**
 * Result of running formal verification on generated code.
 */
export interface VerifyResult {
  /** Whether the code passed verification. */
  verified: boolean
  /** Verification errors with optional line numbers. */
  errors?: Array<{ line?: number; message: string }>
  /** Inferred fix suggestions to guide the model toward a correct solution. */
  suggestions?: string[]
}

/**
 * Pluggable verification backend contract.
 * Implementations may wrap Dafny, Lean, Z3, a linter, a type-checker, or any other tool.
 */
export interface Verifier {
  /**
   * Verify the given code.
   *
   * @param code - The source code to verify.
   * @param metadata - Optional context about the code's origin.
   * @returns Verification result indicating pass/fail with optional diagnostics.
   */
  verify(code: string, metadata?: { filePath?: string; language?: string }): Promise<VerifyResult>
}

/**
 * Configuration for the {@link VerifiedCodeGuard} intervention handler.
 */
export interface VerifiedCodeGuardConfig {
  /** The verification backend to run against generated code. */
  verifier: Verifier

  /** Tool names to intercept. Defaults to `['write_file', 'apply_patch', 'edit_file']`. */
  toolNames?: string[]

  /** Maximum verification attempts before escalating to deny. When unset, retries indefinitely. */
  maxRetries?: number

  /** Custom code extractor. Return undefined to skip verification for a given event. */
  extractCode?: (event: AfterToolCallEvent) => { code: string; filePath?: string } | undefined

  /** Error handling strategy. Defaults to `'throw'`. */
  onError?: OnError
}

/**
 * Extracts code and file path from a tool call event using common tool input conventions.
 */
function defaultExtractCode(event: AfterToolCallEvent): { code: string; filePath?: string } | undefined {
  const input = event.toolUse.input as Record<string, JSONValue> | undefined
  if (!input || typeof input !== 'object') return undefined

  const filePath = (input.file_path ?? input.path) as string | undefined
  const code = (input.content ?? input.new_str ?? input.patch) as string | undefined

  if (typeof code !== 'string' || code.length === 0) return undefined

  return { code, ...(typeof filePath === 'string' ? { filePath } : {}) }
}

/**
 * Formats verification errors and suggestions into feedback text for the model.
 */
function formatFeedback(result: VerifyResult): string {
  const parts: string[] = ['Verification failed.']

  if (result.errors && result.errors.length > 0) {
    parts.push('Errors:')
    for (const error of result.errors) {
      const prefix = error.line !== undefined ? `  Line ${error.line}: ` : '  '
      parts.push(`${prefix}${error.message}`)
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    parts.push('Suggestions:')
    for (const suggestion of result.suggestions) {
      parts.push(`  - ${suggestion}`)
    }
  }

  return parts.join('\n')
}

/**
 * Intervention handler that formally verifies agent-generated code before accepting it.
 *
 * Intercepts `afterToolCall` events for code-writing tools and passes the generated code
 * through a user-provided {@link Verifier}. On failure, feeds verification errors and
 * fix suggestions back to the model as guide feedback, creating an autonomous
 * generate-verify-fix loop. A configurable `maxRetries` cap prevents infinite loops
 * by escalating to deny.
 *
 * @example
 * ```typescript
 * import { VerifiedCodeGuard } from '@strands-agents/sdk/vended-interventions/verified-code-guard'
 *
 * const guard = new VerifiedCodeGuard({
 *   verifier: myDafnyVerifier,
 *   maxRetries: 3,
 * })
 *
 * const agent = new Agent({ model, tools, interventions: [guard] })
 * ```
 */
export class VerifiedCodeGuard extends InterventionHandler {
  readonly name = 'strands:verified-code-guard'
  override readonly onError: OnError

  private _config: VerifiedCodeGuardConfig
  private _retryCounts: Map<string, number> = new Map()

  constructor(config: VerifiedCodeGuardConfig) {
    super()
    this._config = config
    this.onError = config.onError ?? 'throw'
  }

  override async afterToolCall(event: AfterToolCallEvent): Promise<Proceed | Deny | Guide> {
    const toolNames = this._config.toolNames ?? DEFAULT_TOOL_NAMES
    if (!toolNames.includes(event.toolUse.name)) {
      return proceed()
    }

    const extractor = this._config.extractCode ?? defaultExtractCode
    const extracted = extractor(event)
    if (!extracted) {
      return proceed()
    }

    const metadata = {
      ...(extracted.filePath ? { filePath: extracted.filePath } : {}),
    }

    const result = await this._config.verifier.verify(extracted.code, metadata)

    const retryKey = extracted.filePath ?? event.toolUse.toolUseId
    if (result.verified) {
      this._retryCounts.delete(retryKey)
      return proceed()
    }

    const count = (this._retryCounts.get(retryKey) ?? 0) + 1
    this._retryCounts.set(retryKey, count)

    const feedback = formatFeedback(result)

    if (this._config.maxRetries !== undefined && count >= this._config.maxRetries) {
      this._retryCounts.delete(retryKey)
      return deny(`Verification failed after ${count} attempt(s):\n${feedback}`)
    }

    return guide(feedback)
  }
}
