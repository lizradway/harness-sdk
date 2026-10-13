import type { Embedder } from '../search/types.js'

import { StorageError } from '../../errors.js'

/** Configuration for {@link bedrockEmbedder}. */
export interface BedrockEmbedderConfig {
  /** Bedrock model ID. Defaults to `'amazon.titan-embed-text-v2:0'`. */
  modelId?: string
  /** AWS region override for the Bedrock Runtime client. */
  region?: string
  /** Pre-configured Bedrock Runtime client. Cannot be combined with `region`. */
  bedrockClient?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient
}

/**
 * Creates an {@link Embedder} backed by Amazon Bedrock.
 *
 * The Bedrock Runtime SDK is loaded lazily on first call and declared as an
 * optional peer dependency, so consumers that never call this function are not
 * required to install `@aws-sdk/client-bedrock-runtime`.
 *
 * @example
 * ```typescript
 * import { bedrockEmbedder } from '@strands-agents/sdk/storage/embeddings'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const storage = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({
 *     embedder: bedrockEmbedder({ modelId: 'cohere.embed-english-v3' }),
 *   }),
 * })
 * ```
 *
 * @param config - Optional configuration for model, region, or a pre-configured client
 * @returns An {@link Embedder} function that produces embedding vectors from text
 * @throws {@link StorageError} if both `region` and `bedrockClient` are provided
 */
export function bedrockEmbedder(config?: BedrockEmbedderConfig): Embedder {
  if (config?.bedrockClient && config.region) {
    throw new StorageError(
      'Cannot specify both bedrockClient and region. Configure the region on the BedrockRuntimeClient instead.'
    )
  }
  const modelId = config?.modelId ?? 'amazon.titan-embed-text-v2:0'
  let client: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined = config?.bedrockClient

  return async (text: string): Promise<number[]> => {
    if (!client) {
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
      client = new BedrockRuntimeClient(config?.region ? { region: config.region } : {})
    }
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      })
    )
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] }
    return parsed.embedding
  }
}
