/**
 * @vitest-environment node
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StructuredDataChunker } from '../chunkers/structured-data-chunker.ts'
import { isSupportedFileType, parseBuffer } from './index.ts'
import { XlsxParser } from './xlsx-parser.ts'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

interface SheetSpec {
  name: string
  /** `<sheetData>` inner XML. */
  data: string
  dimension?: string
}

/** Build an `.xlsx` the way Excel lays one out: root rels, workbook rels, shared strings. */
async function buildWorkbook(
  sheets: SheetSpec[],
  sharedStrings?: string[] | string,
  extra: Record<string, string | Buffer> = {}
): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  )
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`
  )
  const rels = sheets.map(
    (_s, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  if (sharedStrings !== undefined) {
    rels.push(
      `<Relationship Id="rIdSst" Type="${REL_TYPE}/sharedStrings" Target="sharedStrings.xml"/>`
    )
    const items =
      typeof sharedStrings === 'string'
        ? sharedStrings
        : sharedStrings.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="${MAIN_NS}">${items}</sst>`)
  }
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
  )
  sheets.forEach((s, i) => {
    const dim = s.dimension ? `<dimension ref="${s.dimension}"/>` : ''
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0"?><worksheet xmlns="${MAIN_NS}">${dim}<sheetData>${s.data}</sheetData></worksheet>`
    )
  })
  for (const [name, content] of Object.entries(extra)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const sst = (ref: string, index: number) => `<c r="${ref}" t="s"><v>${index}</v></c>`
const num = (ref: string, value: string) => `<c r="${ref}"><v>${value}</v></c>`
const row = (r: number, ...cells: string[]) => `<row r="${r}">${cells.join('')}</row>`

describe('XlsxParser', () => {
  it('renders a normal workbook as a header row, a rule and tab-separated rows', async () => {
    const buffer = await buildWorkbook(
      [
        {
          name: 'People',
          dimension: 'A1:C3',
          data:
            row(1, sst('A1', 0), sst('B1', 1), sst('C1', 2)) +
            row(2, sst('A2', 3), num('B2', '30'), '<c r="C2" t="b"><v>1</v></c>') +
            row(3, sst('A3', 4), num('B3', '41.50'), '<c r="C3" t="b"><v>0</v></c>'),
        },
      ],
      ['Name', 'Age', 'Active', 'Alice', 'Bob']
    )

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.content).toBe(
      [
        '=== Sheet: People ===',
        'Name\tAge\tActive',
        '-'.repeat('Name\tAge\tActive'.length),
        'Alice\t30\ttrue',
        'Bob\t41.5\tfalse',
      ].join('\n')
    )
    expect(result.metadata).toMatchObject({
      sheetCount: 1,
      sheetNames: ['People'],
      totalRows: 3,
      truncated: false,
    })
    expect(result.metadata?.sampledData).toEqual([
      ['Name', 'Age', 'Active'],
      ['Alice', '30', 'true'],
      ['Bob', '41.5', 'false'],
    ])
  })

  it('reads every sheet in workbook order, resolving each through the relationships', async () => {
    const buffer = await buildWorkbook(
      [
        { name: 'First', data: row(1, sst('A1', 0)) + row(2, num('A2', '1')) },
        { name: 'Second &amp; Last', data: row(1, sst('A1', 1)) + row(2, num('A2', '2')) },
        { name: 'Blank', data: '' },
      ],
      ['one', 'two']
    )

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.metadata?.sheetNames).toEqual(['First', 'Second & Last', 'Blank'])
    expect(result.content).toBe(
      [
        '=== Sheet: First ===',
        'one',
        '---',
        '1',
        '',
        '=== Sheet: Second & Last ===',
        'two',
        '---',
        '2',
        '',
        '=== Sheet: Blank ===',
        '[Empty sheet]',
      ].join('\n')
    )
    expect(result.metadata?.totalRows).toBe(4)
  })

  it('resolves shared strings: rich-text runs join, phonetic runs are dropped, escapes decode', async () => {
    const items = [
      '<si><r><rPr><b/></rPr><t>Rich </t></r><r><t>text</t></r></si>',
      '<si><t>漢字</t><rPh sb="0" eb="2"><t>カンジ</t></rPh></si>',
      '<si><t>a &amp; b &lt;c&gt; &#x41;&#66;</t></si>',
      '<si><t>tab_x0009_here</t></si>',
      '<si/>',
    ].join('')
    const buffer = await buildWorkbook(
      [
        {
          name: 'S',
          data: row(1, sst('A1', 0), sst('B1', 1), sst('C1', 2), sst('D1', 3), sst('E1', 4)),
        },
      ],
      items
    )

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.metadata?.sampledData).toEqual([
      ['Rich text', '漢字', 'a & b <c> AB', 'tab\there', ''],
    ])
  })

  it('reads inline strings, cached formula results, and namespace-prefixed markup', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      `<x:workbook xmlns:x="${MAIN_NS}" xmlns:r="${REL_NS}"><x:sheets><x:sheet name="P" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_TYPE}/worksheet" Target="/xl/worksheets/data.xml"/></Relationships>`
    )
    zip.file(
      'xl/worksheets/data.xml',
      `<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c><x:c><x:f>1+1</x:f><x:v>2</x:v></x:c><x:c t="str"><x:f>"a"&amp;"b"</x:f><x:v>ab</x:v></x:c><x:c t="e"><x:f>1/0</x:f><x:v>#DIV/0!</x:v></x:c></x:row></x:sheetData></x:worksheet>`
    )
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const result = await new XlsxParser().parseBuffer(buffer)

    // The error cell holds no content, so the row stops at the last valued cell.
    expect(result.metadata?.sampledData).toEqual([['inline', '2', 'ab']])
  })

  it('keeps empty cells as empty columns and pads rows to the sheet width', async () => {
    const buffer = await buildWorkbook(
      [
        {
          name: 'Gaps',
          dimension: 'A1:D4',
          data:
            row(1, sst('A1', 0), sst('C1', 1)) +
            row(2, num('B2', '5')) +
            '<row r="3"><c r="A3" s="1"/><c r="B3" t="str"><f>""</f><v/></c></row>' +
            row(4, sst('A4', 2), num('D4', '7')),
        },
      ],
      ['h1', 'h3', 'last']
    )

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.content).toBe(
      ['=== Sheet: Gaps ===', 'h1\t\th3\t', '-'.repeat(7), '\t5\t\t', 'last\t\t\t7'].join('\n')
    )
    // Row 3 holds only a style-only cell and an empty formula result: not a row.
    expect(result.metadata?.totalRows).toBe(3)
  })

  it('starts rows at the first used column, and never drops a cell outside a wrong dimension', async () => {
    const buffer = await buildWorkbook([
      {
        name: 'Offset',
        dimension: 'C3',
        data: row(3, num('C3', '1'), num('D3', '2')) + row(4, num('E4', '3')),
      },
    ])

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.metadata?.sampledData).toEqual([
      ['1', '2', ''],
      ['', '', '3'],
    ])
  })

  it('falls back to positional sheet parts when the workbook has no relationships', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Only" sheetId="1" r:id="rId1"/></sheets></workbook>`
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>solo</t></is></c></row></sheetData></worksheet>`
    )
    const result = await new XlsxParser().parseBuffer(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.content).toBe('=== Sheet: Only ===\nsolo\n----')
  })

  it('caps the preview at 1000 rows per sheet but counts every row', async () => {
    const rows: string[] = []
    for (let r = 1; r <= 1200; r++) rows.push(row(r, num(`A${r}`, String(r))))
    const buffer = await buildWorkbook([{ name: 'Big', data: rows.join('') }])

    const result = await new XlsxParser().parseBuffer(buffer)

    expect(result.metadata?.totalRows).toBe(1200)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.content).toContain('[... 1,200 total rows, showing first 1,000 ...]')
    expect(result.content).toContain('\n1000\n')
    expect(result.content).not.toContain('\n1001\n')
  })

  it('does not resolve DTD-declared entities', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0"?><!DOCTYPE worksheet [ <!ENTITY e SYSTEM "file:///etc/passwd"> <!ENTITY <row> "x"> ]><worksheet xmlns="${MAIN_NS}"><sheetData><!-- <row r="9"><c r="A9"><v>9</v></c></row> --><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>`
    )
    const result = await new XlsxParser().parseBuffer(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.metadata?.sampledData).toEqual([['&e;']])
    expect(result.metadata?.totalRows).toBe(1)
  })

  it('produces text the structured-data chunker takes as rows', async () => {
    const data = [row(1, sst('A1', 0), sst('B1', 1), sst('C1', 2), sst('D1', 3))]
    for (let r = 2; r <= 40; r++) {
      data.push(row(r, num(`A${r}`, String(r)), num(`B${r}`, '1'), num(`C${r}`, '2'), num(`D${r}`, '3')))
    }
    const buffer = await buildWorkbook([{ name: 'T', data: data.join('') }], ['a', 'b', 'c', 'd'])
    const { content } = await new XlsxParser().parseBuffer(buffer)

    expect(
      StructuredDataChunker.isStructuredData(
        content,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe(true)
    const chunks = await StructuredDataChunker.chunkStructuredData(content, { chunkSize: 30 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[1].text).toContain('\t1\t2\t3')
  })

  describe('refusals', () => {
    it('refuses a decompression bomb under the zip limits', async () => {
      const buffer = await buildWorkbook(
        [{ name: 'S', data: row(1, num('A1', '1')) }],
        undefined,
        { 'xl/media/padding.bin': Buffer.alloc(8 * 1024 * 1024, 0) }
      )
      // A bomb disguised as the worksheet itself.
      const zip = await JSZip.loadAsync(buffer)
      zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${' '.repeat(4 * 1024 * 1024)}</sheetData></worksheet>`)
      const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      expect(bomb.length).toBeLessThan(128 * 1024)

      await expect(
        new XlsxParser({ maxTotalUncompressedBytes: 1024 * 1024 }).parseBuffer(bomb)
      ).rejects.toThrow(/Failed to parse XLSX buffer: .*uncompressed limit/)
    })

    it('refuses an archive with too many entries', async () => {
      const extra: Record<string, string> = {}
      for (let i = 0; i < 50; i++) extra[`xl/junk/${i}.xml`] = '<x/>'
      const buffer = await buildWorkbook([{ name: 'S', data: '' }], undefined, extra)
      await expect(new XlsxParser({ maxEntries: 20 }).parseBuffer(buffer)).rejects.toThrow(
        /entry limit/
      )
    })

    it('refuses bytes that are not a zip, such as a legacy binary .xls', async () => {
      // The OLE2 compound-file signature an .xls starts with.
      const xls = Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(512),
      ])
      await expect(new XlsxParser().parseBuffer(xls)).rejects.toThrow(
        'Failed to parse XLSX buffer: Not a zip archive: end of central directory not found'
      )
    })

    it('refuses a zip that holds no workbook', async () => {
      const zip = new JSZip()
      zip.file('word/document.xml', '<document/>')
      await expect(
        new XlsxParser().parseBuffer(await zip.generateAsync({ type: 'nodebuffer' }))
      ).rejects.toThrow('Not an XLSX workbook: no workbook part found')
    })

    it('refuses a truncated workbook', async () => {
      const buffer = await buildWorkbook([{ name: 'S', data: row(1, num('A1', '1')) }])
      await expect(
        new XlsxParser().parseBuffer(buffer.subarray(0, Math.floor(buffer.length / 2)))
      ).rejects.toThrow(/Failed to parse XLSX buffer/)
    })

    it('refuses an empty buffer', async () => {
      await expect(new XlsxParser().parseBuffer(Buffer.alloc(0))).rejects.toThrow(
        'Empty buffer provided'
      )
    })
  })

  describe('parseFile', () => {
    let dir: string
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'xlsx-parser-'))
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('reads a workbook from disk', async () => {
      const file = path.join(dir, 'book.xlsx')
      await writeFile(file, await buildWorkbook([{ name: 'D', data: row(1, num('A1', '3')) }]))
      const result = await new XlsxParser().parseFile(file)
      expect(result.content).toBe('=== Sheet: D ===\n3\n-')
    })

    it('reports a missing file', async () => {
      await expect(new XlsxParser().parseFile(path.join(dir, 'nope.xlsx'))).rejects.toThrow(
        'File not found'
      )
    })
  })
})

describe('parser registry', () => {
  it('parses .xlsx and no longer claims legacy .xls', async () => {
    expect(isSupportedFileType('xlsx')).toBe(true)
    expect(isSupportedFileType('xls')).toBe(false)
    expect(isSupportedFileType('XLS')).toBe(false)

    const buffer = await buildWorkbook([{ name: 'S', data: row(1, num('A1', '1')) }])
    await expect(parseBuffer(buffer, 'xls')).rejects.toThrow('Unsupported file type: xls')
    await expect(parseBuffer(buffer, 'xlsx')).resolves.toMatchObject({
      content: '=== Sheet: S ===\n1\n-',
    })
  })
})
