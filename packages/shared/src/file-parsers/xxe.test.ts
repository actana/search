/**
 * XXE regression suite (fair-code ticket 19, context D8).
 *
 * Feeds malicious OOXML documents — external network and local-file entity
 * declarations plus references in text content — through the real parsers
 * (mammoth, officeparser, the in-repo xlsx parser; no parser mocks) and asserts that no
 * outbound entity fetch is attempted at the TCP layer and that no
 * local-file entity content leaks into the parsed output. A parse is
 * allowed to succeed with the entities unresolved or to fail outright;
 * what it must never do is fetch. Guards future dependency bumps of the
 * document-parsing libraries.
 *
 * @vitest-environment node
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocxParser } from './docx-parser.ts'
import { PptxParser } from './pptx-parser.ts'
import { XlsxParser } from './xlsx-parser.ts'

const NET_ENTITY_URL = 'http://127.0.0.1:9/xxe-canary'
const LOCAL_CANARY_CONTENT = 'XXE-LOCAL-FILE-CANARY-CONTENT'

let canaryDir: string
let canaryPath: string

const connectAttempts: string[] = []

/**
 * A doctype that declares both a network external entity and a local-file
 * external entity. A vulnerable parser expanding either would fetch the URL
 * (tripping the socket guard) or splice the canary file into its output.
 */
function entityDoctype(rootName: string): string {
  return [
    `<!DOCTYPE ${rootName} [`,
    `  <!ENTITY xxe SYSTEM "${NET_ENTITY_URL}">`,
    `  <!ENTITY lfile SYSTEM "file://${canaryPath}">`,
    ']>',
  ].join('\n')
}

/** Text carrying both entity references, framed by unique per-format markers. */
function entityPayload(marker: string): string {
  return `BEFORE-${marker}-&xxe;-&lfile;-AFTER-${marker}`
}

/**
 * Build an OOXML package (a zip) from its parts, always including the shared
 * `[Content_Types].xml` + `_rels/.rels` envelope pointing at the main part.
 */
async function buildOoxml(
  contentTypeOverride: string,
  mainPartTarget: string,
  parts: Record<string, string>
): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypeOverride}</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPartTarget}"/></Relationships>`
  )
  for (const [name, content] of Object.entries(parts)) {
    zip.file(name, content)
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

function buildMaliciousDocx(): Promise<Buffer> {
  return buildOoxml(
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    'word/document.xml',
    {
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>\n${entityDoctype('w:document')}\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${entityPayload('DOCX')}</w:t></w:r></w:p></w:body></w:document>`,
    }
  )
}

function buildMaliciousXlsx(): Promise<Buffer> {
  return buildOoxml(
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    'xl/workbook.xml',
    {
      'xl/workbook.xml':
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      // Entity references live in an inline worksheet string — the cell text
      // xlsx surfaces — so a reached-but-unexpanded parse is provable.
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?>\n${entityDoctype('worksheet')}\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${entityPayload('XLSX')}</t></is></c></row></sheetData></worksheet>`,
    }
  )
}

function buildMaliciousPptx(): Promise<Buffer> {
  return buildOoxml(
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    'ppt/presentation.xml',
    {
      'ppt/presentation.xml':
        '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': `<?xml version="1.0"?>\n${entityDoctype('p:sld')}\n<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${entityPayload('PPTX')}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    }
  )
}

/**
 * Runs a parse that may legitimately succeed (entities unresolved) or fail
 * outright — either is acceptable; fetching is not.
 */
async function parseTolerantly(parse: () => Promise<{ content: string }>): Promise<string> {
  try {
    const result = await parse()
    return result.content
  } catch {
    return ''
  }
}

/**
 * The core XXE assertion: the parser attempted no outbound connection and no
 * local-file entity content leaked into the output.
 */
function expectNoEntityResolution(content: string): void {
  expect(connectAttempts).toEqual([])
  expect(content).not.toContain(LOCAL_CANARY_CONTENT)
}

/**
 * Proves the parser actually consumed the entity-bearing text (defeating a
 * false pass where a parser bails before reaching the payload): the framing
 * markers must surface, and the entity references between them must remain
 * literal — unexpanded — rather than resolved to fetched or file content.
 */
function expectPayloadReachedUnexpanded(content: string, marker: string): void {
  expect(content).toContain(`BEFORE-${marker}`)
  expect(content).toContain(`AFTER-${marker}`)
  expect(content).toContain('&xxe;')
  expect(content).toContain('&lfile;')
}

describe('XXE hardening — no external entity fetch during document parsing', () => {
  beforeAll(async () => {
    canaryDir = await mkdtemp(path.join(os.tmpdir(), 'xxe-test-'))
    canaryPath = path.join(canaryDir, 'canary.txt')
    await writeFile(canaryPath, LOCAL_CANARY_CONTENT, 'utf8')
  })

  afterAll(async () => {
    await rm(canaryDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    connectAttempts.length = 0
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      connectAttempts.push(JSON.stringify(args[0]))
      throw new Error('outbound connection blocked by XXE regression test')
    } as never)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        connectAttempts.push(JSON.stringify(args[0]))
        throw new Error('fetch blocked by XXE regression test')
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('trips the socket guard on a genuine connection attempt (guard is not vacuous)', () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(
      'outbound connection blocked by XXE regression test'
    )
    expect(connectAttempts).toHaveLength(1)
    connectAttempts.length = 0
  })

  it('trips the fetch guard on a genuine fetch attempt (guard is not vacuous)', async () => {
    await expect(fetch(NET_ENTITY_URL)).rejects.toThrow('fetch blocked by XXE regression test')
    expect(connectAttempts).toHaveLength(1)
    connectAttempts.length = 0
  })

  it('docx with network and file entities parses without any outbound fetch', async () => {
    const buffer = await buildMaliciousDocx()
    const content = await parseTolerantly(() => new DocxParser().parseBuffer(buffer))

    expectNoEntityResolution(content)
    expectPayloadReachedUnexpanded(content, 'DOCX')
  })

  it('xlsx with an entity-laden inline cell parses without any outbound fetch', async () => {
    const buffer = await buildMaliciousXlsx()
    const content = await parseTolerantly(() => new XlsxParser().parseBuffer(buffer))

    expectNoEntityResolution(content)
    expectPayloadReachedUnexpanded(content, 'XLSX')
  })

  it('pptx with entity-laden slide XML parses without any outbound fetch', async () => {
    const buffer = await buildMaliciousPptx()
    const content = await parseTolerantly(() => new PptxParser().parseBuffer(buffer))

    expectNoEntityResolution(content)
    expectPayloadReachedUnexpanded(content, 'PPTX')
  })

  it('docx with an external DTD reference parses without fetching the DTD', async () => {
    const buffer = await buildOoxml(
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      'word/document.xml',
      {
        'word/document.xml': `<?xml version="1.0"?>\n<!DOCTYPE w:document SYSTEM "${NET_ENTITY_URL}.dtd">\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DTD-TEST</w:t></w:r></w:p></w:body></w:document>`,
      }
    )

    const content = await parseTolerantly(() => new DocxParser().parseBuffer(buffer))

    expectNoEntityResolution(content)
  })
})
