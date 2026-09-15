import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import type { InterventionAction } from '../../interventions/actions.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import {
  DogwoodAuthorizer,
  checkParse,
  validate,
  mcpToCedarSchema,
  type EventInput,
  type EntityInput,
  type EntityRef,
  type DogwoodValue,
} from 'dogwood-wasm'
import { readFileSync, existsSync } from 'node:fs'

/**
 * Minimal tool definition for schema generation. Matches MCP tool format.
 */
export interface ToolDefinition {
  name: string
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] }
  description?: string
}

/**
 * Configuration for the {@link DogwoodAuthorization} intervention handler.
 *
 * @see {@link https://github.com/lizradway/dogwood-wasm | Dogwood WASM bindings}
 */
export interface DogwoodAuthorizationConfig {
  /** Dogwood policy text, or a path to a `.dogwood` file on disk. */
  policies: string

  /**
   * Cedar action schema text, or a path to a `.cedarschema` file on disk.
   * Required unless `tools` is provided for auto-generation.
   */
  actionSchema?: string

  /** Tool definitions (MCP format) for auto action-schema generation via `mcpToCedarSchema`. */
  tools?: ToolDefinition[]

  /** Dogwood event schema text, or a path to a file on disk. */
  eventSchema?: string

  /** Provider declarations JSON string. */
  providers?: string

  /** Macro definitions string. */
  macros?: string

  /** Static principal. Defaults to `User::"anonymous"`. Mutually exclusive with `principalResolver`. */
  principal?: EntityRef

  /**
   * Dynamic principal resolver for multi-tenant agents.
   * Return `undefined` to deny (fail-closed). Mutually exclusive with `principal`.
   */
  principalResolver?: ((invocationState: Record<string, unknown>) => EntityRef | undefined) | undefined

  /** Static entities included in every authorization event (e.g. principal attributes for role-based policies). */
  entities?: EntityInput[]

  /**
   * Dynamic entity resolver. Entities returned are included in the authorization event.
   * Use for multi-tenant agents where entity attributes vary per invocation.
   */
  entityResolver?: ((invocationState: Record<string, unknown>) => EntityInput[]) | undefined

  /**
   * Injects extra fields into the event context. Returns a map of group names to key-value pairs,
   * merged into `context` alongside the `input` group.
   */
  contextEnricher?:
    | ((context: {
        toolName: string
        toolInput: Record<string, unknown>
        invocationState: Record<string, unknown>
      }) => Record<string, Record<string, DogwoodValue>>)
    | undefined

  /**
   * Default event kind for tool-call events. Defaults to `'request'`.
   * Only event kinds declared as `decision event` in the event schema produce authorization verdicts.
   */
  eventKind?: string

  /**
   * Error handling: `'throw'` (default), `'deny'` (fail-closed), `'proceed'` (dangerous: fail-open).
   */
  onError?: OnError | undefined
}

/**
 * Dogwood temporal authorization intervention handler. Evaluates temporal policies before each tool call.
 *
 * Unlike Cedar's stateless evaluation, Dogwood maintains an internal temporal log — each authorization
 * decision is recorded, and temporal operators (`formerly`, `always since`, rate limits, event correlation)
 * reference the full history automatically.
 *
 * @see {@link https://github.com/lizradway/dogwood-wasm | Dogwood WASM bindings}
 *
 * @example
 * ```typescript
 * const dogwood = new DogwoodAuthorization({
 *   policies: 'permit(principal, action == Action::"search", resource);',
 *   actionSchema: 'entity User; entity Resource; action "search" appliesTo { principal: [User], resource: [Resource] };',
 * })
 * ```
 */
export class DogwoodAuthorization extends InterventionHandler {
  readonly name = 'dogwood-authorization'
  override readonly onError: OnError

  private _authorizer: DogwoodAuthorizer
  private readonly _policySource: string
  private readonly _actionSchemaSource: string
  private readonly _eventSchemaSource: string | undefined
  private readonly _providersSource: string | undefined
  private readonly _macrosSource: string | undefined
  private readonly _tools: ToolDefinition[] | undefined
  private readonly _principal: EntityRef | undefined
  private readonly _principalResolver: ((invocationState: Record<string, unknown>) => EntityRef | undefined) | undefined
  private readonly _entities: EntityInput[] | undefined
  private readonly _entityResolver: ((invocationState: Record<string, unknown>) => EntityInput[]) | undefined
  private readonly _contextEnricher: DogwoodAuthorizationConfig['contextEnricher']
  private readonly _eventKind: string
  private _actionPrefix: string

  constructor(config: DogwoodAuthorizationConfig) {
    super()
    if (config.principal && config.principalResolver) {
      throw new Error('Provide either `principal` or `principalResolver`, not both')
    }
    if (!config.actionSchema && !config.tools) {
      throw new Error('Provide either `actionSchema` or `tools` for action schema generation')
    }

    this._policySource = config.policies
    this._tools = config.tools
    this._eventSchemaSource = config.eventSchema
    this._providersSource = config.providers
    this._macrosSource = config.macros
    this._eventKind = config.eventKind ?? 'request'

    const policies = loadPolicies(config.policies)
    const actionSchema = config.actionSchema
      ? loadActionSchema(config.actionSchema)
      : mcpToCedarSchema(JSON.stringify(config.tools))
    this._actionSchemaSource = config.actionSchema ?? actionSchema
    const eventSchema = loadOptionalSource(config.eventSchema)
    const providers = config.providers ?? undefined
    const macros = config.macros ?? undefined

    validatePolicies(policies, actionSchema, eventSchema, providers, macros)

    this._authorizer = new DogwoodAuthorizer(policies, actionSchema, eventSchema, providers, macros)
    this._actionPrefix = deriveActionPrefix(this._authorizer.actions)

    if (config.principalResolver) {
      this._principal = undefined
    } else {
      this._principal = config.principal ?? { type: 'User', id: 'anonymous' }
    }
    this._principalResolver = config.principalResolver
    this._entities = config.entities
    this._entityResolver = config.entityResolver
    this._contextEnricher = config.contextEnricher
    this.onError = config.onError ?? 'throw'
  }

  override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
    const invocationState = event.invocationState as Record<string, unknown>
    const principal = this._principal ?? this._principalResolver!(invocationState)
    if (!principal || !principal.type || !principal.id) {
      return deny('No principal identity found in invocation state')
    }

    const toolInput = (event.toolUse.input ?? {}) as Record<string, DogwoodValue>

    const entities = this._entityResolver ? this._entityResolver(invocationState) : this._entities

    const eventInput: EventInput = {
      action: `${this._actionPrefix}${event.toolUse.name}`,
      kind: this._eventKind,
      principal,
      resource: { type: 'Resource', id: 'agent' },
      context: {
        input: toolInput,
        ...(this._contextEnricher
          ? this._contextEnricher({ toolName: event.toolUse.name, toolInput, invocationState })
          : {}),
      },
      ...(entities ? { entities } : {}),
    }

    const decision = this._authorizer.isAuthorized(eventInput)

    if (decision === undefined) {
      return proceed()
    }

    if (!decision.allowed) {
      const details = decision.errors.filter(Boolean)
      return deny(`Access denied by Dogwood policy${details.length ? `: ${details.join(', ')}` : ''}`)
    }

    return proceed()
  }

  /** The fully-qualified action IDs declared in the schema. */
  get actions(): string[] {
    return this._authorizer.actions
  }

  /** The number of authorization decisions rendered so far. */
  get decisionCount(): number {
    return this._authorizer.decisionCount
  }

  /** Event kinds that produce authorization decisions. */
  get decisionKinds(): string[] {
    return this._authorizer.decisionKinds
  }

  /** Clears all temporal state. Rate-limit counters, event history, and correlation state are reset. */
  reset(): void {
    this._authorizer.reset()
  }

  /**
   * Reloads policies and schemas from disk. Validates before committing.
   * Creates a fresh authorizer — temporal state is discarded.
   *
   * @throws Error if the reloaded policies fail validation.
   */
  reload(): void {
    const policies = loadPolicies(this._policySource)
    const actionSchema = loadActionSchema(this._actionSchemaSource)
    const eventSchema = loadOptionalSource(this._eventSchemaSource)
    const providers = this._providersSource ?? undefined
    const macros = this._macrosSource ?? undefined

    validatePolicies(policies, actionSchema, eventSchema, providers, macros)

    this._authorizer.free()
    this._authorizer = new DogwoodAuthorizer(policies, actionSchema, eventSchema, providers, macros)
    this._actionPrefix = deriveActionPrefix(this._authorizer.actions)
  }
}

function deriveActionPrefix(actions: string[]): string {
  const sample = actions[0]
  if (!sample || !sample.includes('::')) return ''
  return sample.substring(0, sample.lastIndexOf('::') + 2)
}

function validatePolicies(
  policies: string,
  actionSchema: string,
  eventSchema?: string,
  providers?: string,
  macros?: string
): void {
  try {
    checkParse(policies, eventSchema, providers, macros)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Dogwood policy: ${message}`, { cause: error })
  }

  const result = validate(policies, actionSchema, eventSchema, providers, macros)
  if (!result.passed) {
    const errors = result.errors.map((diagnostic) => diagnostic.message).join(', ')
    throw new Error(`Dogwood policy validation failed: ${errors}`)
  }
}

function loadPolicies(source: string): string {
  if (source.endsWith('.dogwood')) {
    if (!existsSync(source)) {
      throw new Error(`Dogwood policy file not found: ${source}`)
    }
    return readFileSync(source, 'utf-8')
  }
  return source
}

function loadActionSchema(source: string): string {
  if (source.endsWith('.cedarschema')) {
    if (!existsSync(source)) {
      throw new Error(`Cedar action schema file not found: ${source}`)
    }
    return readFileSync(source, 'utf-8')
  }
  return source
}

function loadOptionalSource(source: string | undefined): string | undefined {
  if (!source) return undefined
  if (source.endsWith('.dogwood') || source.endsWith('.cedarschema')) {
    if (!existsSync(source)) {
      throw new Error(`File not found: ${source}`)
    }
    return readFileSync(source, 'utf-8')
  }
  return source
}
