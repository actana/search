/**
 * Provider × Template registry for workspace model endpoints.
 *
 * Single source of truth for which providers exist, which templates each
 * provider exposes per kind (inference / embedding), what the wire shape is,
 * and what defaults (baseUrl, models, dimensions, extra fields) to prefill in
 * the UI. Consumers: model-endpoint modal, embedding/inference dispatchers,
 * zod request schemas.
 */

export type Kind = 'inference' | 'embedding'

export type ProviderId =
  | 'openai-compatible'
  | 'anthropic-messages'
  | 'google-genai'
  | 'voyage'
  | 'cohere'

export type AuthStyle = 'bearer' | 'x-api-key' | 'query-key' | 'custom-header' | 'azure-api-key'

export type RequestShape =
  | 'openai-chat'
  | 'openai-embed'
  | 'anthropic-messages'
  | 'google-generate'
  | 'google-embed'
  | 'voyage-embed'
  | 'cohere-chat'
  | 'cohere-embed'
  | 'custom'

export interface TemplateExtraField {
  key: string
  label: string
  required: boolean
  placeholder?: string
  helpText?: string
}

export interface ModelSuggestion {
  id: string
  label?: string
  dimensions?: number
}

export interface Template {
  id: string
  label: string
  baseUrl?: string
  modelSuggestions?: ModelSuggestion[]
  dimSuggest?: number
  extraFields?: TemplateExtraField[]
  requestShape?: RequestShape
  /**
   * Optional override of the provider's default auth style for this template.
   * Used by Azure OpenAI, which sits under `openai-compatible` but ships its
   * key in an `api-key` header with an `api-version` query param.
   */
  authOverride?: AuthStyle
}

export interface ProviderEntry {
  id: ProviderId
  label: string
  auth: AuthStyle
  templates: {
    inference: Template[]
    embedding: Template[]
  }
}

// ---------------------------------------------------------------------------
// Shared template fragments
// ---------------------------------------------------------------------------

const AZURE_EXTRA_FIELDS: TemplateExtraField[] = [
  {
    key: 'apiVersion',
    label: 'API version',
    required: true,
    placeholder: '2024-06-01',
    helpText: 'Azure OpenAI REST API version, e.g. 2024-06-01.',
  },
  {
    key: 'deployment',
    label: 'Deployment name',
    required: true,
    placeholder: 'my-deployment',
    helpText: 'The Azure deployment name (not the underlying model id).',
  },
]

const CUSTOM_INFERENCE_TEMPLATE: Template = {
  id: 'custom',
  label: 'Custom',
  requestShape: 'custom',
}

const CUSTOM_EMBEDDING_TEMPLATE: Template = {
  id: 'custom',
  label: 'Custom',
  requestShape: 'custom',
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderEntry> = {
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    auth: 'bearer',
    templates: {
      inference: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          requestShape: 'openai-chat',
          modelSuggestions: [
            { id: 'gpt-4o' },
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4.1' },
            { id: 'o3-mini' },
          ],
        },
        {
          id: 'azure-openai',
          label: 'Azure OpenAI',
          baseUrl: undefined,
          requestShape: 'openai-chat',
          authOverride: 'azure-api-key',
          extraFields: AZURE_EXTRA_FIELDS.map((f) =>
            f.key === 'apiVersion' || f.key === 'deployment' ? { ...f } : f
          ).concat(),
        },
        {
          id: 'together',
          label: 'Together',
          baseUrl: 'https://api.together.xyz/v1',
          requestShape: 'openai-chat',
        },
        {
          id: 'groq',
          label: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          requestShape: 'openai-chat',
        },
        {
          id: 'fireworks',
          label: 'Fireworks',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          requestShape: 'openai-chat',
        },
        {
          id: 'mistral',
          label: 'Mistral',
          baseUrl: 'https://api.mistral.ai/v1',
          requestShape: 'openai-chat',
        },
        {
          id: 'ollama',
          label: 'Ollama',
          baseUrl: 'http://localhost:11434/v1',
          requestShape: 'openai-chat',
        },
        CUSTOM_INFERENCE_TEMPLATE,
      ],
      embedding: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          requestShape: 'openai-embed',
          modelSuggestions: [
            { id: 'text-embedding-3-small', dimensions: 1536 },
            { id: 'text-embedding-3-large', dimensions: 3072 },
            { id: 'text-embedding-ada-002', dimensions: 1536 },
          ],
        },
        {
          id: 'azure-openai',
          label: 'Azure OpenAI',
          baseUrl: undefined,
          requestShape: 'openai-embed',
          authOverride: 'azure-api-key',
          extraFields: AZURE_EXTRA_FIELDS,
        },
        {
          id: 'together',
          label: 'Together',
          baseUrl: 'https://api.together.xyz/v1',
          requestShape: 'openai-embed',
          modelSuggestions: [
            { id: 'togethercomputer/m2-bert-80M-8k-retrieval', dimensions: 768 },
            { id: 'WhereIsAI/UAE-Large-V1', dimensions: 1024 },
          ],
        },
        {
          id: 'mistral',
          label: 'Mistral',
          baseUrl: 'https://api.mistral.ai/v1',
          requestShape: 'openai-embed',
          modelSuggestions: [{ id: 'mistral-embed', dimensions: 1024 }],
        },
        CUSTOM_EMBEDDING_TEMPLATE,
      ],
    },
  },

  'anthropic-messages': {
    id: 'anthropic-messages',
    label: 'Anthropic',
    auth: 'x-api-key',
    templates: {
      inference: [
        {
          id: 'anthropic-direct',
          label: 'Anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          requestShape: 'anthropic-messages',
          modelSuggestions: [
            { id: 'claude-opus-4-8' },
            { id: 'claude-sonnet-4-6' },
            { id: 'claude-haiku-4-5-20251001' },
          ],
          extraFields: [
            {
              key: 'anthropicVersion',
              label: 'anthropic-version',
              required: true,
              placeholder: '2023-06-01',
              helpText: 'Value of the anthropic-version header.',
            },
          ],
        },
        CUSTOM_INFERENCE_TEMPLATE,
      ],
      embedding: [],
    },
  },

  'google-genai': {
    id: 'google-genai',
    label: 'Google GenAI',
    auth: 'query-key',
    templates: {
      inference: [
        {
          id: 'gemini-api',
          label: 'Gemini API',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          requestShape: 'google-generate',
          modelSuggestions: [
            { id: 'gemini-2.0-flash' },
            { id: 'gemini-1.5-pro' },
            { id: 'gemini-1.5-flash' },
          ],
        },
        CUSTOM_INFERENCE_TEMPLATE,
      ],
      embedding: [
        {
          id: 'gemini-api',
          label: 'Gemini API',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          requestShape: 'google-embed',
          modelSuggestions: [
            { id: 'gemini-embedding-001', dimensions: 3072 },
            { id: 'text-embedding-004', dimensions: 768 },
          ],
        },
        CUSTOM_EMBEDDING_TEMPLATE,
      ],
    },
  },

  voyage: {
    id: 'voyage',
    label: 'Voyage',
    auth: 'bearer',
    templates: {
      inference: [],
      embedding: [
        {
          id: 'voyage',
          label: 'Voyage',
          baseUrl: 'https://api.voyageai.com/v1',
          requestShape: 'voyage-embed',
          modelSuggestions: [
            { id: 'voyage-3-large', dimensions: 1024 },
            { id: 'voyage-3', dimensions: 1024 },
            { id: 'voyage-3-lite', dimensions: 512 },
            { id: 'voyage-code-3', dimensions: 1024 },
            { id: 'voyage-multilingual-2', dimensions: 1024 },
          ],
        },
        CUSTOM_EMBEDDING_TEMPLATE,
      ],
    },
  },

  cohere: {
    id: 'cohere',
    label: 'Cohere',
    auth: 'bearer',
    templates: {
      inference: [
        {
          id: 'cohere-direct',
          label: 'Cohere',
          baseUrl: 'https://api.cohere.com',
          requestShape: 'cohere-chat',
          modelSuggestions: [{ id: 'command-r-plus' }, { id: 'command-r' }],
        },
        CUSTOM_INFERENCE_TEMPLATE,
      ],
      embedding: [
        {
          id: 'cohere-direct',
          label: 'Cohere',
          baseUrl: 'https://api.cohere.com',
          requestShape: 'cohere-embed',
          modelSuggestions: [
            { id: 'embed-english-v3.0', dimensions: 1024 },
            { id: 'embed-multilingual-v3.0', dimensions: 1024 },
            { id: 'embed-english-light-v3.0', dimensions: 384 },
            { id: 'embed-multilingual-light-v3.0', dimensions: 384 },
          ],
        },
        CUSTOM_EMBEDDING_TEMPLATE,
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function listProvidersForKind(kind: Kind): ProviderEntry[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => p.templates[kind].length > 0)
}

export function getProvider(providerId: ProviderId): ProviderEntry | undefined {
  return PROVIDER_REGISTRY[providerId]
}

export function getTemplate(
  providerId: ProviderId,
  templateId: string,
  kind: Kind
): Template | undefined {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) return undefined
  return provider.templates[kind].find((t) => t.id === templateId)
}

export interface ResolveTemplateDefaultsArgs {
  providerId: ProviderId
  templateId: string
  kind: Kind
  userInput?: {
    baseUrl?: string
    model?: string
    dimensions?: number
    extras?: Record<string, unknown>
  }
}

export interface ResolvedTemplateDefaults {
  baseUrl?: string
  auth: AuthStyle
  model?: string
  dimensions?: number
  requestShape?: RequestShape
  extras: Record<string, unknown>
}

/**
 * Merges template defaults with the user's overrides. `userInput` always wins.
 * `extras` carries the raw `extraFields` values from `userInput.extras`.
 */
export function resolveTemplateDefaults(
  args: ResolveTemplateDefaultsArgs
): ResolvedTemplateDefaults {
  const { providerId, templateId, kind, userInput } = args
  const provider = PROVIDER_REGISTRY[providerId]
  const template = provider?.templates[kind].find((t) => t.id === templateId)

  const auth: AuthStyle = template?.authOverride ?? provider?.auth ?? 'bearer'

  const firstSuggestion = template?.modelSuggestions?.[0]
  const defaultModel = firstSuggestion?.id
  const defaultDimensions = template?.dimSuggest ?? firstSuggestion?.dimensions

  return {
    baseUrl: userInput?.baseUrl ?? template?.baseUrl,
    auth,
    model: userInput?.model ?? defaultModel,
    dimensions: kind === 'embedding' ? (userInput?.dimensions ?? defaultDimensions) : undefined,
    requestShape: template?.requestShape,
    extras: userInput?.extras ?? {},
  }
}
