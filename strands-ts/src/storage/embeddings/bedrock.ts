/**
 * Amazon Bedrock embedder for vector search strategies.
 *
 * @packageDocumentation
 */

import { Embedder } from '../search/embedder.js'

import { StorageError } from '../../errors.js'

const DEFAULT_MODEL_ID = 'amazon.titan-embed-text-v2:0'

/** Configuration for {@link BedrockEmbedder}. */
export interface BedrockEmbedderConfig {
  /**
   * Bedrock model ID of an Amazon Titan Text Embeddings model, or the ARN of a provisioned or
   * imported Titan model. Defaults to `'amazon.titan-embed-text-v2:0'`. Other model families use
   * a different request and response shape and are not supported yet; extend {@link Embedder}
   * for those.
   */
  modelId?: 'amazon.titan-embed-text-v2:0' | 'amazon.titan-embed-text-v1' | (string & {})
  /**
   * Output vector length, sent to the model as `dimensions`. Titan Text Embeddings V2 accepts
   * 256, 512 or 1024 (its default). Leave unset for models that do not take the parameter.
   */
  dimensions?: number
  /** AWS region override for the Bedrock Runtime client. */
  region?: string
  /** Pre-configured Bedrock Runtime client. Cannot be combined with `region`. */
  bedrockClient?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient
}

/**
 * An {@link Embedder} backed by Amazon Titan Text Embeddings on Amazon Bedrock.
 *
 * Sends `{ inputText }` via `InvokeModel` and returns the `embedding` field of the response.
 * The Bedrock Runtime SDK and client are loaded on the first call and reused. Titan limits input
 * to 50,000 characters; longer text is rejected by Bedrock.
 *
 * @example
 * ```typescript
 * import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const storage = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({
 *     embedder: new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0', region: 'us-west-2' }),
 *   }),
 * })
 * ```
 */
export class BedrockEmbedder extends Embedder {
  private readonly _modelId: string
  private readonly _config: BedrockEmbedderConfig
  private _client: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined
  private _sdk: Promise<typeof import('@aws-sdk/client-bedrock-runtime')> | undefined

  /**
   * @param config - Optional model, output dimension, region, or pre-configured client
   * @throws {@link StorageError} if both `region` and `bedrockClient` are provided, or if
   *   `modelId` names a model that is not a Titan embeddings model
   */
  constructor(config: BedrockEmbedderConfig = {}) {
    super()
    if (config.bedrockClient && config.region) {
      throw new StorageError(
        'Cannot specify both bedrockClient and region. Configure the region on the BedrockRuntimeClient instead.'
      )
    }
    const modelId = config.modelId ?? DEFAULT_MODEL_ID
    // An ARN does not name its model family, so it is checked by the response shape instead.
    if (!modelId.startsWith('arn:') && !modelId.includes('titan-embed')) {
      throw new StorageError(
        `BedrockEmbedder supports Amazon Titan embeddings models only, got '${modelId}'. Extend Embedder for other models.`
      )
    }
    this._modelId = modelId
    this._config = { ...config }
    this._client = config.bedrockClient
  }

  /**
   * Embeds `text` with the configured Titan model. Titan embeds documents and queries the same
   * way, so `options.purpose` is ignored.
   *
   * @param text - The text to embed
   * @returns The embedding vector
   * @throws {@link StorageError} if the model response has no `embedding` array
   */
  async embed(text: string): Promise<number[]> {
    this._sdk ??= import('@aws-sdk/client-bedrock-runtime')
    const { BedrockRuntimeClient, InvokeModelCommand } = await this._sdk
    this._client ??= new BedrockRuntimeClient(this._config.region ? { region: this._config.region } : {})
    const body: { inputText: string; dimensions?: number } = { inputText: text }
    if (this._config.dimensions !== undefined) body.dimensions = this._config.dimensions
    const response = await this._client.send(
      new InvokeModelCommand({
        modelId: this._modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      })
    )
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown }
    if (!Array.isArray(parsed.embedding)) {
      throw new StorageError(`Model '${this._modelId}' did not return a Titan-shaped { embedding: number[] } response`)
    }
    return parsed.embedding as number[]
  }
}
