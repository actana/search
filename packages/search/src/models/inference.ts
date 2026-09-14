/**
 * Workspace inference dispatcher.
 *
 * Non-streaming v1. Routes chat completions through the Provider × Template
 * registry. Streaming support is a follow-up.
 */

import { createLogger } from '@actana/search-shared/log'

// lifted: `export { executeProviderRequest, MAX_TOOL_ITERATIONS } from
// '@/providers'` — already deprecated in Studio, and retained there only for
// the workflow executor and the `/runtime` routes, neither of which crossed.

import {
  type AuthStyle,
  getTemplate,
  type ProviderId,
  type RequestShape,
  type Template,
} from './templates.ts'

const logger = createLogger('models:inference')

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface InferenceOptions {
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: string | string[]
}

export interface WorkspaceInferenceEndpoint {
  id?: string
  providerId: string
  template: string
  modelName: string | null
  apiKey: string
  baseUrl?: string | null
  config?: Record<string, unknown> | null
}

export interface InferenceUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface WorkspaceInferenceResult {
  content: string
  finishReason?: string
  usage?: InferenceUsage
  raw?: unknown
}

export interface ExecuteWorkspaceInferenceParams {
  endpoint: WorkspaceInferenceEndpoint
  messages: InferenceMessage[]
  options?: InferenceOptions
  user?: string
}

interface ResolvedConfig {
  custom?: { requestShape?: RequestShape }
  extras?: Record<string, unknown>
  [key: string]: unknown
}

function buildAuthHeaders(
  auth: AuthStyle,
  apiKey: string,
  extras: Record<string, unknown> | undefined
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  switch (auth) {
    case 'bearer':
      headers['authorization'] = `Bearer ${apiKey}`
      break
    case 'x-api-key':
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = String(extras?.anthropicVersion ?? '2023-06-01')
      break
    case 'azure-api-key':
      headers['api-key'] = apiKey
      break
    case 'query-key':
    case 'custom-header':
    default:
      break
  }
  return headers
}

function buildAzureChatUrl(baseUrl: string, extras: Record<string, unknown> | undefined): string {
  const deployment = extras?.deployment
  const apiVersion = extras?.apiVersion
  if (!deployment || !apiVersion) {
    throw new Error('Azure OpenAI inference requires extras.deployment and extras.apiVersion')
  }
  return `${baseUrl.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
}

interface DispatchPlan {
  url: string
  body: unknown
  parse: (json: unknown) => { content: string; finishReason?: string; usage?: InferenceUsage }
}

function planInference(args: {
  shape: RequestShape
  baseUrl: string
  model: string
  messages: InferenceMessage[]
  options: InferenceOptions
  apiKey: string
  authStyle: AuthStyle
  extras: Record<string, unknown> | undefined
}): DispatchPlan {
  const { shape, baseUrl, model, messages, options, apiKey, authStyle, extras } = args
  const trimBase = baseUrl.replace(/\/$/, '')
  const { temperature, topP, maxTokens, stop } = options

  switch (shape) {
    case 'openai-chat': {
      const url =
        authStyle === 'azure-api-key'
          ? buildAzureChatUrl(baseUrl, extras)
          : `${trimBase}/chat/completions`
      return {
        url,
        body: {
          model,
          messages,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          stop,
        },
        parse: (json) => {
          const j = json as {
            choices?: Array<{
              message?: { content?: string }
              finish_reason?: string
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              total_tokens?: number
            }
          }
          const content = j.choices?.[0]?.message?.content ?? ''
          return {
            content,
            finishReason: j.choices?.[0]?.finish_reason,
            usage: j.usage
              ? {
                  promptTokens: j.usage.prompt_tokens,
                  completionTokens: j.usage.completion_tokens,
                  totalTokens: j.usage.total_tokens,
                }
              : undefined,
          }
        },
      }
    }
    case 'anthropic-messages': {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const nonSystem = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
      return {
        url: `${trimBase}/messages`,
        body: {
          model,
          messages: nonSystem,
          system: system.length > 0 ? system : undefined,
          max_tokens: maxTokens ?? 1024,
          temperature,
          top_p: topP,
        },
        parse: (json) => {
          const j = json as {
            content?: Array<{ text?: string }>
            stop_reason?: string
            usage?: { input_tokens?: number; output_tokens?: number }
          }
          const content = j.content?.[0]?.text ?? ''
          return {
            content,
            finishReason: j.stop_reason,
            usage: j.usage
              ? {
                  promptTokens: j.usage.input_tokens,
                  completionTokens: j.usage.output_tokens,
                  totalTokens: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0),
                }
              : undefined,
          }
        },
      }
    }
    case 'google-generate': {
      const systemInstruction = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : m.role,
          parts: [{ text: m.content }],
        }))
      return {
        url: `${trimBase}/models/${model}:generateContent?key=${apiKey}`,
        body: {
          contents,
          systemInstruction: systemInstruction
            ? { parts: [{ text: systemInstruction }] }
            : undefined,
          generationConfig: {
            temperature,
            topP,
            maxOutputTokens: maxTokens,
          },
        },
        parse: (json) => {
          const j = json as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> }
              finishReason?: string
            }>
            usageMetadata?: {
              promptTokenCount?: number
              candidatesTokenCount?: number
              totalTokenCount?: number
            }
          }
          const content = j.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          return {
            content,
            finishReason: j.candidates?.[0]?.finishReason,
            usage: j.usageMetadata
              ? {
                  promptTokens: j.usageMetadata.promptTokenCount,
                  completionTokens: j.usageMetadata.candidatesTokenCount,
                  totalTokens: j.usageMetadata.totalTokenCount,
                }
              : undefined,
          }
        },
      }
    }
    case 'cohere-chat': {
      return {
        url: `${trimBase}/v2/chat`,
        body: {
          model,
          messages,
          temperature,
          p: topP,
          max_tokens: maxTokens,
          stop_sequences: stop,
        },
        parse: (json) => {
          const j = json as {
            message?: { content?: Array<{ text?: string }> }
            finish_reason?: string
            usage?: {
              tokens?: { input_tokens?: number; output_tokens?: number }
            }
          }
          const content = j.message?.content?.[0]?.text ?? ''
          return {
            content,
            finishReason: j.finish_reason,
            usage: j.usage?.tokens
              ? {
                  promptTokens: j.usage.tokens.input_tokens,
                  completionTokens: j.usage.tokens.output_tokens,
                  totalTokens:
                    (j.usage.tokens.input_tokens ?? 0) + (j.usage.tokens.output_tokens ?? 0),
                }
              : undefined,
          }
        },
      }
    }
    case 'custom':
      // Custom inference falls back to OpenAI-compatible only in v1.
      return planInference({
        shape: 'openai-chat',
        baseUrl,
        model,
        messages,
        options,
        apiKey,
        authStyle,
        extras,
      })
    default:
      throw new Error(`unsupported inference requestShape: ${shape}`)
  }
}

/**
 * Run a non-streaming chat completion against a workspace endpoint.
 */
export async function executeWorkspaceInference(
  params: ExecuteWorkspaceInferenceParams
): Promise<WorkspaceInferenceResult> {
  const { endpoint, messages, options = {} } = params
  if (!endpoint.modelName) {
    throw new Error('workspace inference endpoint missing modelName')
  }
  if (!endpoint.apiKey) {
    throw new Error('workspace inference endpoint missing apiKey')
  }

  const config = (endpoint.config ?? {}) as ResolvedConfig
  const providerId = endpoint.providerId as ProviderId
  const template: Template | undefined = getTemplate(providerId, endpoint.template, 'inference')

  let shape: RequestShape | undefined = template?.requestShape
  let authStyle: AuthStyle | undefined = template?.authOverride
  let baseUrl = endpoint.baseUrl ?? template?.baseUrl ?? undefined

  if (!template || endpoint.template === 'custom') {
    const custom = config.custom
    const customShape = (custom?.requestShape as RequestShape | undefined) ?? 'openai-chat'
    if (customShape !== 'openai-chat' && customShape !== 'custom') {
      throw new Error(`unsupported custom inference shape: ${customShape}`)
    }
    shape = customShape === 'custom' ? 'openai-chat' : customShape
    baseUrl = endpoint.baseUrl ?? baseUrl
  }
  if (!shape) {
    throw new Error(
      `no inference requestShape for provider=${endpoint.providerId} template=${endpoint.template}`
    )
  }
  if (!baseUrl) {
    throw new Error(
      `no baseUrl for inference endpoint provider=${endpoint.providerId} template=${endpoint.template}`
    )
  }
  if (!authStyle) {
    switch (endpoint.providerId) {
      case 'anthropic-messages':
        authStyle = 'x-api-key'
        break
      case 'google-genai':
        authStyle = 'query-key'
        break
      case 'openai-compatible':
      case 'voyage':
      case 'cohere':
      default:
        authStyle = 'bearer'
        break
    }
  }

  const extras = (config.extras ?? {}) as Record<string, unknown>
  const plan = planInference({
    shape,
    baseUrl,
    model: endpoint.modelName,
    messages,
    options,
    apiKey: endpoint.apiKey,
    authStyle,
    extras,
  })

  const headers = buildAuthHeaders(authStyle, endpoint.apiKey, extras)

  let response: Response
  try {
    response = await fetch(plan.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(plan.body),
    })
  } catch (error) {
    logger.error('inference fetch failed', {
      providerId: endpoint.providerId,
      template: endpoint.template,
      error,
    })
    throw error
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.error('inference non-2xx', {
      status: response.status,
      providerId: endpoint.providerId,
      template: endpoint.template,
      body: text.slice(0, 500),
    })
    throw new Error(
      `inference request failed: ${response.status} ${response.statusText} ${text.slice(0, 200)}`
    )
  }

  const json = (await response.json()) as unknown
  const parsed = plan.parse(json)
  return { ...parsed, raw: json }
}
