/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { resolveParserExtension } from './parser-extension.ts'

describe('resolveParserExtension', () => {
  it('uses a supported filename extension when present', () => {
    expect(resolveParserExtension('report.pdf', 'application/pdf')).toBe('pdf')
  })

  it('falls back to mime type when filename has no extension', () => {
    expect(
      resolveParserExtension('[Business] Your Thursday morning trip with Uber', 'text/plain')
    ).toBe('txt')
  })

  it('falls back to mime type when filename extension is unsupported', () => {
    expect(resolveParserExtension('uber-message.business', 'text/plain')).toBe('txt')
  })

  it('refuses a legacy .xls by name, even when a fallback is offered', () => {
    expect(() => resolveParserExtension('budget.xls', 'application/vnd.ms-excel', 'txt')).toThrow(
      'Unsupported file type: xls (legacy binary Excel (.xls) is not supported; save the workbook as .xlsx)'
    )
    expect(() => resolveParserExtension('budget.XLS')).toThrow('Unsupported file type: xls')
  })

  it('refuses a legacy Excel mime type on an extensionless name', () => {
    expect(() => resolveParserExtension('budget', 'application/vnd.ms-excel', 'txt')).toThrow(
      'Unsupported file type: xls'
    )
  })

  it('still resolves .xlsx', () => {
    expect(
      resolveParserExtension(
        'budget.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe('xlsx')
  })

  it('throws when neither filename nor mime type resolves to a supported parser', () => {
    expect(() =>
      resolveParserExtension('uber-message.unknown', 'application/octet-stream')
    ).toThrow('Unsupported file type')
  })
})
