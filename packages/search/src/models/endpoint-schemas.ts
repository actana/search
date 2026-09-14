/**
 * Zod schemas for workspace model-endpoint POST/PATCH payloads.
 *
 * Built dynamically from the PROVIDER_REGISTRY so that the set of valid
 * (provider, template, kind) triples is the registry's single source of truth.
 *
 * Shape:
 *   - Outer discriminator: `kind` ('inference' | 'embedding').
 *   - Inner discriminator (per kind): `template`, where each branch additionally
 *     pins `provider` to a literal. Since each (provider, template) pair within
 *     a kind is unique in the registry, the inner discriminator on `template`
 *     is unambiguous within a kind. The branch's `provider` literal still
 *     prevents cross-provider template id collisions (e.g. both
 *     openai-compatible and google-genai expose a `custom` template).
 *
 *     To keep `template` unique within a kind's union, we encode the literal as
 *     `${provider}:${template}`. Clients send the raw `template` and `provider`
 *     fields; we synthesize the discriminator before parsing.
 */

import { z } from 'zod'
import {
  type Kind,
  PROVIDER_REGISTRY,
  type ProviderId,
  type Template,
} from './templates.ts'

/**
 * Common fields shared by every branch. The discriminator field
 * `__providerTemplate` is internally synthesized — never sent by clients.
 */
const baseFields = {
  name: z.string().min(1).max(200),
  apiKey: z.string().min(1).optional(),
  apiKeyEndpointId: z.string().min(1).optional(),
  /**
   * Name of a WORKSPACE environment variable that holds the API key
   * (secret-backed mode). Stored plaintext in `config.apiKeySecretName` — the
   * name is a reference, not a secret — and resolved at call time via
   * `@/lib/models/endpoint-api-key`.
   */
  apiKeySecretName: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1),
}

/**
 * Build the per-template zod object for a single (provider, kind, template)
 * triple.
 */
function buildBranchSchema(
  provider: ProviderId,
  kind: Kind,
  template: Template
): z.ZodObject<z.ZodRawShape> {
  const isCustom = template.id === 'custom'
  const needsBaseUrl = !template.baseUrl || isCustom

  const shape: z.ZodRawShape = {
    __providerTemplate: z.literal(`${kind}:${provider}:${template.id}`),
    kind: z.literal(kind),
    provider: z.literal(provider),
    template: z.literal(template.id),
    name: baseFields.name,
    apiKey: baseFields.apiKey,
    apiKeyEndpointId: baseFields.apiKeyEndpointId,
    apiKeySecretName: baseFields.apiKeySecretName,
    model: baseFields.model,
    baseUrl: needsBaseUrl ? z.string().url() : z.string().url().optional(),
  }

  if (kind === 'embedding') {
    shape.dimensions = z.number().int().positive()
  } else {
    shape.dimensions = z.undefined().optional()
  }

  // Per-template extra fields → config.extras
  const extras = template.extraFields ?? []
  if (extras.length > 0) {
    const extrasShape: z.ZodRawShape = {}
    for (const f of extras) {
      const fieldSchema = z.string().min(1)
      extrasShape[f.key] = f.required ? fieldSchema : fieldSchema.optional()
    }
    shape.extras = z.object(extrasShape)
  } else {
    shape.extras = z.record(z.string(), z.unknown()).optional()
  }

  // Custom embedding template: optional inputField/outputPath/requestShape under config.custom
  if (isCustom && kind === 'embedding') {
    shape.custom = z
      .object({
        inputField: z.string().min(1).default('input'),
        outputPath: z.string().min(1).default('data[0].embedding'),
        requestShape: z
          .enum(['openai-embed', 'voyage-embed', 'cohere-embed', 'google-embed', 'custom'])
          .default('openai-embed'),
      })
      .partial()
      .optional()
  }

  return z.object(shape)
}

/**
 * Collect every branch schema across the registry, grouped by kind.
 */
function buildBranchesForKind(kind: Kind): z.ZodObject<z.ZodRawShape>[] {
  const branches: z.ZodObject<z.ZodRawShape>[] = []
  for (const providerEntry of Object.values(PROVIDER_REGISTRY)) {
    for (const template of providerEntry.templates[kind]) {
      branches.push(buildBranchSchema(providerEntry.id, kind, template))
    }
  }
  return branches
}

const allBranches = [...buildBranchesForKind('inference'), ...buildBranchesForKind('embedding')]

/**
 * Single flat discriminated union on the synthetic `__providerTemplate` key.
 * Each branch's `kind`, `provider`, and `template` are pinned to literals so
 * wrong-kind combos (e.g. voyage+inference) simply do not exist in the union.
 */
// lifted: an `eslint-disable-next-line @typescript-eslint/no-explicit-any`
// stood here. This repo's config has that rule off, so the directive is
// itself reported as unused.
const RawCreateSchema = z.discriminatedUnion('__providerTemplate', allBranches as any)

/**
 * Public entry point: parses an incoming POST body.
 *
 * Pre-processes by synthesizing the `__providerTemplate` discriminator from
 * the client-supplied `provider` + `template` fields.
 */
export const createEndpointSchema = z
  .preprocess((input) => {
    if (typeof input !== 'object' || input === null) return input
    const obj = input as Record<string, unknown>
    if (typeof obj.provider === 'string' && typeof obj.template === 'string') {
      return {
        ...obj,
        __providerTemplate: `${obj.kind}:${obj.provider}:${obj.template}`,
      }
    }
    return obj
  }, RawCreateSchema)
  .superRefine((value, ctx) => {
    const v = value as { apiKey?: string; apiKeyEndpointId?: string; apiKeySecretName?: string }
    if (!v.apiKey && !v.apiKeyEndpointId && !v.apiKeySecretName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: 'apiKey is required unless apiKeyEndpointId or apiKeySecretName is provided',
      })
    }
    if (v.apiKeyEndpointId && v.apiKeySecretName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKeySecretName'],
        message: 'Provide either apiKeyEndpointId or apiKeySecretName, not both',
      })
    }
  })

export type CreateEndpointInput = z.infer<typeof createEndpointSchema>

/**
 * PATCH schema. `provider` and `kind` are immutable — the route handler
 * reads them from the DB row and injects them before parsing. The new
 * `template` (if changed) must come with all required fields for that branch.
 *
 * Strategy: just reuse the same union — the caller passes the full payload
 * including the resolved provider/kind. Caller is responsible for mismatch
 * detection (rejecting bodies that contradict the DB row's provider/kind).
 */
export const updateEndpointSchema = createEndpointSchema

/**
 * Helper: given a DB row's (provider, kind), validates a PATCH body by
 * injecting the immutable fields if the client omitted them and rejecting
 * mismatches.
 */
export function parseUpdate(
  body: unknown,
  fixed: { provider: ProviderId; kind: Kind }
):
  | { success: true; data: CreateEndpointInput }
  | { success: false; error: string; field?: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, error: 'Body must be an object' }
  }
  const obj = body as Record<string, unknown>

  if (obj.provider !== undefined && obj.provider !== fixed.provider) {
    return {
      success: false,
      error: 'provider is immutable',
      field: 'provider',
    }
  }
  if (obj.kind !== undefined && obj.kind !== fixed.kind) {
    return { success: false, error: 'kind is immutable', field: 'kind' }
  }

  const injected = { ...obj, provider: fixed.provider, kind: fixed.kind }
  const parsed = createEndpointSchema.safeParse(injected)
  if (!parsed.success) {
    const issue = parsed.error.errors[0]
    return {
      success: false,
      error: issue?.message ?? 'Invalid request',
      field: issue?.path?.[0] as string | undefined,
    }
  }
  return { success: true, data: parsed.data }
}
