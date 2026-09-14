/**
 * @vitest-environment node
 *
 * Round-trip test for the PROVIDER_REGISTRY: every (providerId, kind, template)
 * triple must `resolveTemplateDefaults` without throwing. Embedding templates
 * with `dimSuggest` or a first model suggestion carrying `dimensions` must
 * surface a `dimensions` value. Custom templates are allowed to lack a baseUrl.
 */
import { describe, expect, it } from 'vitest'
import {
  type Kind,
  PROVIDER_REGISTRY,
  type ProviderId,
  resolveTemplateDefaults,
} from './templates.ts'

describe('PROVIDER_REGISTRY round-trip', () => {
  for (const providerId of Object.keys(PROVIDER_REGISTRY) as ProviderId[]) {
    const provider = PROVIDER_REGISTRY[providerId]
    for (const kind of ['inference', 'embedding'] as Kind[]) {
      for (const template of provider.templates[kind]) {
        it(`resolves ${providerId}/${kind}/${template.id} without throwing`, () => {
          const resolved = resolveTemplateDefaults({
            providerId,
            templateId: template.id,
            kind,
            userInput: {},
          })

          expect(resolved.auth).toBeDefined()
          expect(resolved.extras).toEqual({})

          if (template.id === 'custom') {
            // Custom templates don't carry a baseUrl — user supplies it.
            expect(resolved.baseUrl).toBeUndefined()
          }

          if (
            kind === 'embedding' &&
            template.id !== 'custom' &&
            (template.dimSuggest !== undefined ||
              template.modelSuggestions?.[0]?.dimensions !== undefined)
          ) {
            expect(typeof resolved.dimensions).toBe('number')
          }

          if (kind === 'inference') {
            expect(resolved.dimensions).toBeUndefined()
          }
        })
      }
    }
  }
})
