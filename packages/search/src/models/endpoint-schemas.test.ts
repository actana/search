/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createEndpointSchema, parseUpdate } from './endpoint-schemas.ts'
import { PROVIDER_REGISTRY } from './templates.ts'

function basePayload<T extends Record<string, unknown>>(overrides: T) {
  return {
    name: 'My endpoint',
    apiKey: 'sk-test',
    model: 'm',
    ...overrides,
  }
}

describe('createEndpointSchema', () => {
  it('rejects wrong-kind provider (voyage + inference)', () => {
    const result = createEndpointSchema.safeParse(
      basePayload({
        provider: 'voyage',
        template: 'voyage',
        kind: 'inference',
      })
    )
    expect(result.success).toBe(false)
  })

  it('rejects missing required extraField (Azure apiVersion)', () => {
    const result = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'azure-openai',
        kind: 'inference',
        baseUrl: 'https://example.openai.azure.com/openai',
        extras: { deployment: 'my-dep' }, // missing apiVersion
      })
    )
    expect(result.success).toBe(false)
  })

  it('accepts azure-openai with all required extras + baseUrl', () => {
    const result = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'azure-openai',
        kind: 'inference',
        baseUrl: 'https://example.openai.azure.com/openai',
        extras: { apiVersion: '2024-06-01', deployment: 'my-dep' },
      })
    )
    expect(result.success).toBe(true)
  })

  it('requires dimensions when kind=embedding', () => {
    const without = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'openai',
        kind: 'embedding',
        model: 'text-embedding-3-small',
      })
    )
    expect(without.success).toBe(false)

    const withDim = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'openai',
        kind: 'embedding',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      })
    )
    expect(withDim.success).toBe(true)
  })

  it('forbids dimensions when kind=inference', () => {
    const withDim = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'openai',
        kind: 'inference',
        model: 'gpt-4o',
        dimensions: 1536,
      })
    )
    expect(withDim.success).toBe(false)

    const withoutDim = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'openai',
        kind: 'inference',
        model: 'gpt-4o',
      })
    )
    expect(withoutDim.success).toBe(true)
  })

  it('custom embedding template requires dimensions and accepts optional custom fields', () => {
    const noDim = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'custom',
        kind: 'embedding',
        baseUrl: 'https://example.com/v1',
      })
    )
    expect(noDim.success).toBe(false)

    const ok = createEndpointSchema.safeParse(
      basePayload({
        provider: 'openai-compatible',
        template: 'custom',
        kind: 'embedding',
        baseUrl: 'https://example.com/v1',
        dimensions: 768,
        custom: {
          inputField: 'text',
          outputPath: 'embedding',
          requestShape: 'openai-embed',
        },
      })
    )
    expect(ok.success).toBe(true)
  })

  it('requires apiKey unless apiKeyEndpointId is given', () => {
    const neither = createEndpointSchema.safeParse({
      name: 'x',
      provider: 'openai-compatible',
      template: 'openai',
      kind: 'inference',
      model: 'gpt-4o',
    })
    expect(neither.success).toBe(false)

    const linked = createEndpointSchema.safeParse({
      name: 'x',
      provider: 'openai-compatible',
      template: 'openai',
      kind: 'inference',
      model: 'gpt-4o',
      apiKeyEndpointId: 'ep_other',
    })
    expect(linked.success).toBe(true)
  })

  it('accepts apiKeySecretName in place of apiKey and rejects combining it with apiKeyEndpointId', () => {
    const withSecret = createEndpointSchema.safeParse({
      name: 'x',
      provider: 'openai-compatible',
      template: 'openai',
      kind: 'inference',
      model: 'gpt-4o',
      apiKeySecretName: 'OPENAI_KEY',
    })
    expect(withSecret.success).toBe(true)

    const withBothRefs = createEndpointSchema.safeParse({
      name: 'x',
      provider: 'openai-compatible',
      template: 'openai',
      kind: 'inference',
      model: 'gpt-4o',
      apiKeyEndpointId: 'ep_other',
      apiKeySecretName: 'OPENAI_KEY',
    })
    expect(withBothRefs.success).toBe(false)
  })

  it('happy path: every (provider, kind, template) triple parses with a valid payload', () => {
    for (const provider of Object.values(PROVIDER_REGISTRY)) {
      for (const kind of ['inference', 'embedding'] as const) {
        for (const template of provider.templates[kind]) {
          const payload: Record<string, unknown> = {
            name: `${provider.id}-${template.id}`,
            apiKey: 'sk-test',
            provider: provider.id,
            template: template.id,
            kind,
            model: template.modelSuggestions?.[0]?.id ?? 'placeholder-model',
          }
          // baseUrl required when template has no default OR template is custom
          if (!template.baseUrl || template.id === 'custom') {
            payload.baseUrl = 'https://example.com/v1'
          }
          if (kind === 'embedding') {
            payload.dimensions = template.modelSuggestions?.[0]?.dimensions ?? 1024
          }
          if (template.extraFields?.length) {
            const extras: Record<string, string> = {}
            for (const f of template.extraFields) {
              if (f.required) extras[f.key] = 'val'
            }
            payload.extras = extras
          }
          const result = createEndpointSchema.safeParse(payload)
          expect(
            result.success,
            `Failed for ${provider.id}/${template.id}/${kind}: ${
              result.success ? '' : JSON.stringify(result.error.errors)
            }`
          ).toBe(true)
        }
      }
    }
  })
})

describe('parseUpdate', () => {
  it('rejects mismatched provider on PATCH', () => {
    const result = parseUpdate(
      basePayload({
        provider: 'voyage',
        template: 'voyage',
        kind: 'embedding',
        dimensions: 1024,
      }),
      { provider: 'openai-compatible', kind: 'embedding' }
    )
    expect(result.success).toBe(false)
    expect(result.success ? null : result.field).toBe('provider')
  })

  it('rejects mismatched kind on PATCH', () => {
    const result = parseUpdate(
      basePayload({
        provider: 'openai-compatible',
        template: 'openai',
        kind: 'inference',
      }),
      { provider: 'openai-compatible', kind: 'embedding' }
    )
    expect(result.success).toBe(false)
    expect(result.success ? null : result.field).toBe('kind')
  })

  it('injects provider/kind when omitted by client', () => {
    const result = parseUpdate(
      {
        name: 'rename',
        apiKey: 'sk-test',
        template: 'openai',
        model: 'gpt-4o',
      },
      { provider: 'openai-compatible', kind: 'inference' }
    )
    expect(result.success).toBe(true)
  })
})
