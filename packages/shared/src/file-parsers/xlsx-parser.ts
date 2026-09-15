import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { createLogger } from '../log.ts'
import type { FileParseResult, FileParser } from './types.ts'
import { sanitizeTextForUTF8 } from './utils.ts'
import { ZipReader, type ZipReaderLimits } from './zip-reader.ts'

const logger = createLogger('XlsxParser')

// Configuration for handling large XLSX files
const CONFIG = {
  MAX_PREVIEW_ROWS: 1000, // Only keep first 1000 rows for preview
  MAX_SAMPLE_ROWS: 100, // Sample for metadata
  ROWS_PER_CHUNK: 50, // Aggregate 50 rows per chunk to reduce chunk count
  MAX_CELL_LENGTH: 1000, // Truncate very long cell values
  MAX_CONTENT_SIZE: 10 * 1024 * 1024, // 10MB max content size
  MAX_SHEETS: 1000, // A workbook declaring more sheets than this is refused
}

/** One sheet as the text renderer needs it: its first rows, and how many rows it has. */
interface SheetRows {
  name: string
  /** Up to MAX_PREVIEW_ROWS non-blank rows, each padded to the sheet's used width. */
  rows: string[][]
  /** Every non-blank row in the sheet, including those not kept in `rows`. */
  rowCount: number
}

/**
 * `.xlsx` (Office Open XML spreadsheet) parser with no third-party dependency.
 *
 * Replaces SheetJS (ADR 0012, superseding ADR 0007). The workbook is opened
 * with {@link ZipReader} — which caps entry count and total inflated bytes —
 * and its parts are read with a small linear tag scanner rather than a general
 * XML parser. DTDs are never processed, so an entity reference stays literal
 * text and nothing is ever fetched.
 *
 * The text it produces keeps the shape the SheetJS-backed parser produced — a
 * `=== Sheet: name ===` header per sheet, a tab-separated header row and rule,
 * tab-separated data rows padded to the sheet's used width, blank rows skipped
 * — because that is what `StructuredDataChunker` steers on. Cell values are the
 * stored values: numbers in their shortest decimal form, dates as the serial
 * number Excel stores, booleans as `true`/`false`, formulas as their cached
 * result. Legacy binary `.xls` is not supported.
 */
export class XlsxParser implements FileParser {
  private readonly limits: ZipReaderLimits

  constructor(limits: ZipReaderLimits = {}) {
    this.limits = limits
  }

  async parseFile(filePath: string): Promise<FileParseResult> {
    try {
      if (!filePath) {
        throw new Error('No file path provided')
      }

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`)
      }

      logger.info(`Parsing XLSX file: ${filePath}`)

      const buffer = await readFile(filePath)
      return this.processWorkbook(this.readWorkbook(buffer))
    } catch (error) {
      logger.error('XLSX file parsing error:', error)
      throw new Error(`Failed to parse XLSX file: ${(error as Error).message}`)
    }
  }

  async parseBuffer(buffer: Buffer): Promise<FileParseResult> {
    try {
      if (!buffer || buffer.length === 0) {
        throw new Error('Empty buffer provided')
      }

      const bufferSize = buffer.length
      logger.info(
        `Parsing XLSX buffer, size: ${bufferSize} bytes (${(bufferSize / 1024 / 1024).toFixed(2)} MB)`
      )

      return this.processWorkbook(this.readWorkbook(buffer))
    } catch (error) {
      logger.error('XLSX buffer parsing error:', error)
      throw new Error(`Failed to parse XLSX buffer: ${(error as Error).message}`)
    }
  }

  private readWorkbook(buffer: Buffer): SheetRows[] {
    const zip = new ZipReader(buffer, this.limits)

    const workbookPath = resolveWorkbookPath(zip)
    const workbookXml = readPart(zip, workbookPath)
    if (workbookXml === undefined) {
      throw new Error('Not an XLSX workbook: no workbook part found')
    }

    const workbookDir = path.posix.dirname(workbookPath)
    const relsXml = readPart(
      zip,
      path.posix.join(workbookDir, '_rels', `${path.posix.basename(workbookPath)}.rels`)
    )
    const rels = relsXml === undefined ? [] : parseRelationships(relsXml, workbookDir)

    const sharedStringsTarget =
      rels.find((rel) => rel.type.endsWith('/sharedStrings'))?.target ??
      path.posix.join(workbookDir, 'sharedStrings.xml')
    const sharedStringsXml = readPart(zip, sharedStringsTarget)
    const sharedStrings = sharedStringsXml === undefined ? [] : parseSharedStrings(sharedStringsXml)

    const declaredSheets = parseWorkbookSheets(workbookXml)
    if (declaredSheets.length > CONFIG.MAX_SHEETS) {
      throw new Error(
        `Workbook declares ${declaredSheets.length} sheets, over the ${CONFIG.MAX_SHEETS}-sheet limit`
      )
    }

    return declaredSheets.map((sheet, index) => {
      const rel = sheet.relId ? rels.find((r) => r.id === sheet.relId) : undefined
      // A workbook without relationships (seen from minimal producers) names
      // its sheets positionally.
      const target = rel
        ? rel.target
        : path.posix.join(workbookDir, 'worksheets', `sheet${index + 1}.xml`)
      const isWorksheet = !rel || rel.type.endsWith('/worksheet')
      const sheetXml = isWorksheet ? readPart(zip, target) : undefined
      const parsed =
        sheetXml === undefined
          ? { rows: [], rowCount: 0 }
          : parseWorksheet(sheetXml, sharedStrings, CONFIG.MAX_PREVIEW_ROWS)
      return { name: sheet.name, ...parsed }
    })
  }

  private processWorkbook(sheets: SheetRows[]): FileParseResult {
    const sheetNames = sheets.map((sheet) => sheet.name)
    let content = ''
    let totalRows = 0
    let truncated = false
    let contentSize = 0
    const sampledData: string[][] = []

    for (const sheet of sheets) {
      const sheetName = sheet.name
      const sheetData = sheet.rows
      const actualRowCount = sheet.rowCount
      totalRows += actualRowCount

      logger.info(`Processing sheet: ${sheetName} with ${actualRowCount} rows`)

      // Store limited sample for metadata
      if (sampledData.length < CONFIG.MAX_SAMPLE_ROWS) {
        const sampleSize = Math.min(CONFIG.MAX_SAMPLE_ROWS - sampledData.length, sheetData.length)
        sampledData.push(...sheetData.slice(0, sampleSize))
      }

      // Only process limited rows for preview
      const rowsToProcess = Math.min(actualRowCount, CONFIG.MAX_PREVIEW_ROWS)
      const cleanSheetName = sanitizeTextForUTF8(sheetName)

      // Add sheet header
      const sheetHeader = `\n=== Sheet: ${cleanSheetName} ===\n`
      content += sheetHeader
      contentSize += sheetHeader.length

      if (actualRowCount > 0) {
        // Get headers if available
        const headers = sheetData[0]
        if (headers && headers.length > 0) {
          const headerRow = headers.map((h) => this.truncateCell(h)).join('\t')
          content += `${headerRow}\n`
          content += `${'-'.repeat(Math.min(80, headerRow.length))}\n`
          contentSize += headerRow.length + 82
        }

        // Process data rows in chunks
        let chunkContent = ''
        let chunkRowCount = 0

        for (let i = 1; i < rowsToProcess; i++) {
          const row = sheetData[i]
          if (row && row.length > 0) {
            const rowString = row.map((cell) => this.truncateCell(cell)).join('\t')

            chunkContent += `${rowString}\n`
            chunkRowCount++

            // Add chunk separator every N rows for better readability
            if (chunkRowCount >= CONFIG.ROWS_PER_CHUNK) {
              content += chunkContent
              contentSize += chunkContent.length
              chunkContent = ''
              chunkRowCount = 0

              // Check content size limit
              if (contentSize > CONFIG.MAX_CONTENT_SIZE) {
                truncated = true
                break
              }
            }
          }
        }

        // Add remaining chunk content
        if (chunkContent && contentSize < CONFIG.MAX_CONTENT_SIZE) {
          content += chunkContent
          contentSize += chunkContent.length
        }

        // Add truncation notice if needed
        if (actualRowCount > rowsToProcess) {
          const notice = `\n[... ${actualRowCount.toLocaleString()} total rows, showing first ${rowsToProcess.toLocaleString()} ...]\n`
          content += notice
          truncated = true
        }
      } else {
        content += '[Empty sheet]\n'
      }

      // Stop processing if content is too large
      if (contentSize > CONFIG.MAX_CONTENT_SIZE) {
        content += '\n[... Content truncated due to size limits ...]\n'
        truncated = true
        break
      }
    }

    logger.info(
      `XLSX parsing completed: ${sheetNames.length} sheets, ${totalRows} total rows, truncated: ${truncated}`
    )

    const cleanContent = sanitizeTextForUTF8(content).trim()

    return {
      content: cleanContent,
      metadata: {
        sheetCount: sheetNames.length,
        sheetNames: sheetNames,
        totalRows: totalRows,
        truncated: truncated,
        sampledData: sampledData.slice(0, CONFIG.MAX_SAMPLE_ROWS),
        contentSize: contentSize,
      },
    }
  }

  private truncateCell(cell: string | undefined): string {
    if (cell === null || cell === undefined) {
      return ''
    }

    let cellStr = String(cell)

    // Truncate very long cells
    if (cellStr.length > CONFIG.MAX_CELL_LENGTH) {
      cellStr = `${cellStr.substring(0, CONFIG.MAX_CELL_LENGTH)}...`
    }

    return sanitizeTextForUTF8(cellStr)
  }
}

// ---------------------------------------------------------------------------
// Package structure
// ---------------------------------------------------------------------------

interface Relationship {
  id: string
  type: string
  /** Zip entry name the relationship points at. */
  target: string
}

function readPart(zip: ZipReader, name: string): string | undefined {
  return zip.read(name)?.toString('utf8')
}

/** The workbook part: whatever `_rels/.rels` names as the office document, else the conventional path. */
function resolveWorkbookPath(zip: ZipReader): string {
  const rootRels = readPart(zip, '_rels/.rels')
  if (rootRels !== undefined) {
    const main = parseRelationships(rootRels, '').find((rel) =>
      rel.type.endsWith('/officeDocument')
    )
    if (main && zip.has(main.target)) return main.target
  }
  return 'xl/workbook.xml'
}

function parseRelationships(xml: string, baseDir: string): Relationship[] {
  const rels: Relationship[] = []
  scanTags(xml, (tag) => {
    if (tag.closing || tag.name !== 'Relationship') return
    const attrs = parseAttributes(tag.attrs)
    if (!attrs.Id || !attrs.Target || attrs.TargetMode === 'External') return
    const rawTarget = attrs.Target
    const target = rawTarget.startsWith('/')
      ? path.posix.normalize(rawTarget.slice(1))
      : path.posix.normalize(path.posix.join(baseDir, rawTarget))
    rels.push({ id: attrs.Id, type: attrs.Type ?? '', target })
  })
  return rels
}

function parseWorkbookSheets(xml: string): Array<{ name: string; relId?: string }> {
  const sheets: Array<{ name: string; relId?: string }> = []
  scanTags(xml, (tag) => {
    if (tag.closing || tag.name !== 'sheet') return
    const attrs = parseAttributes(tag.attrs)
    const relIdKey = Object.keys(attrs).find((key) => key === 'id' || key.endsWith(':id'))
    sheets.push({
      name: attrs.name ?? `Sheet${sheets.length + 1}`,
      relId: relIdKey ? attrs[relIdKey] : undefined,
    })
  })
  return sheets
}

/** `<si>` items, each the concatenation of its `<t>` runs, phonetic (`<rPh>`) runs excluded. */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = []
  let current: string | undefined
  let phoneticDepth = 0
  let textStart = -1

  scanTags(xml, (tag) => {
    switch (tag.name) {
      case 'si':
        if (tag.selfClosing) {
          strings.push('')
        } else if (!tag.closing) {
          current = ''
          phoneticDepth = 0
        } else if (current !== undefined) {
          strings.push(current)
          current = undefined
        }
        break
      case 'rPh':
        if (tag.selfClosing) break
        phoneticDepth += tag.closing ? -1 : 1
        break
      case 't':
        if (tag.selfClosing) break
        if (!tag.closing) {
          textStart = tag.end
        } else if (textStart >= 0) {
          if (current !== undefined && phoneticDepth <= 0) {
            current += decodeText(xml.slice(textStart, tag.start))
          }
          textStart = -1
        }
        break
    }
  })
  return strings
}

/**
 * Read a worksheet's `<sheetData>` into rows. Keeps at most `maxRows` non-blank
 * rows but counts all of them, and pads kept rows to the sheet's column span:
 * the declared `<dimension>` widened to every valued cell. SheetJS padded to
 * the declared dimension alone and dropped cells outside it; widening keeps its
 * output for a truthful dimension and loses nothing to a wrong one.
 */
function parseWorksheet(
  xml: string,
  sharedStrings: string[],
  maxRows: number
): { rows: string[][]; rowCount: number } {
  const kept: Array<Map<number, string>> = []
  let rowCount = 0
  let minCol = Number.POSITIVE_INFINITY
  let maxCol = -1

  let row: Map<number, string> | undefined
  let lastCol = -1
  let cellCol = -1
  let cellType = ''
  let cellValue: string | undefined
  let inCell = false
  let inInline = false
  let inlineText: string | undefined
  let phoneticDepth = 0
  let valueStart = -1
  let textStart = -1

  let rowHasText = false

  // A row counts only when some cell holds non-empty text. SheetJS also kept
  // rows whose every value was an empty string (typically formulas evaluating
  // to ""), which rendered as a line of bare tabs.
  const finishRow = () => {
    if (row && rowHasText) {
      rowCount++
      if (kept.length < maxRows) kept.push(row)
    }
    row = undefined
  }

  const finishCell = () => {
    let value: string | undefined
    switch (cellType) {
      case 's': {
        const index = cellValue === undefined ? Number.NaN : Number.parseInt(cellValue, 10)
        value = Number.isInteger(index) ? sharedStrings[index] : undefined
        break
      }
      case 'inlineStr':
        value = inlineText
        break
      case 'b':
        value = cellValue === undefined ? undefined : cellValue.trim() === '1' ? 'true' : 'false'
        break
      case 'str':
        value = cellValue
        break
      case 'e':
        // Error results (#N/A, #DIV/0!) are not content; SheetJS dropped them too.
        value = undefined
        break
      default: {
        if (cellValue !== undefined) {
          const trimmed = cellValue.trim()
          const n = Number(trimmed)
          value = trimmed !== '' && Number.isFinite(n) ? String(n) : cellValue
        }
      }
    }
    if (value !== undefined && row && cellCol >= 0) {
      row.set(cellCol, value)
      if (value !== '') rowHasText = true
      if (cellCol < minCol) minCol = cellCol
      if (cellCol > maxCol) maxCol = cellCol
    }
    inCell = false
    inInline = false
  }

  scanTags(xml, (tag) => {
    switch (tag.name) {
      case 'dimension': {
        if (tag.closing) break
        const span = parseDimensionColumns(parseAttributes(tag.attrs).ref)
        if (span) {
          minCol = Math.min(minCol, span[0])
          maxCol = Math.max(maxCol, span[1])
        }
        break
      }
      case 'row':
        finishRow()
        if (!tag.closing && !tag.selfClosing) {
          row = new Map()
          rowHasText = false
          lastCol = -1
        }
        break
      case 'c': {
        if (tag.closing) {
          if (inCell) finishCell()
          break
        }
        if (!row) break
        const attrs = parseAttributes(tag.attrs)
        const refCol = attrs.r ? columnIndex(attrs.r) : -1
        cellCol = refCol >= 0 ? refCol : lastCol + 1
        lastCol = cellCol
        cellType = attrs.t ?? 'n'
        cellValue = undefined
        inlineText = undefined
        phoneticDepth = 0
        inCell = true
        if (tag.selfClosing) finishCell()
        break
      }
      case 'v':
        if (!inCell) break
        if (tag.selfClosing) {
          cellValue = ''
        } else if (!tag.closing) {
          valueStart = tag.end
        } else if (valueStart >= 0) {
          cellValue = decodeText(xml.slice(valueStart, tag.start))
          valueStart = -1
        }
        break
      case 'is':
        if (!inCell) break
        if (tag.selfClosing) {
          inlineText = ''
        } else {
          inInline = !tag.closing
          if (inInline) inlineText = ''
        }
        break
      case 'rPh':
        if (!inInline || tag.selfClosing) break
        phoneticDepth += tag.closing ? -1 : 1
        break
      case 't':
        if (!inInline || tag.selfClosing) break
        if (!tag.closing) {
          textStart = tag.end
        } else if (textStart >= 0) {
          if (phoneticDepth <= 0) {
            inlineText = (inlineText ?? '') + decodeText(xml.slice(textStart, tag.start))
          }
          textStart = -1
        }
        break
    }
  })
  finishRow()

  const rows =
    maxCol < 0
      ? []
      : kept.map((cells) => {
          const out: string[] = []
          for (let c = minCol; c <= maxCol; c++) out.push(cells.get(c) ?? '')
          return out
        })
  return { rows, rowCount }
}

/** `"B2:D9"` → `[1, 3]`; a single-cell ref spans one column. `undefined` when unreadable. */
function parseDimensionColumns(ref: string | undefined): [number, number] | undefined {
  if (!ref) return undefined
  const [first, last = first] = ref.split(':')
  const start = columnIndex(first)
  const end = columnIndex(last)
  return start >= 0 && end >= start ? [start, end] : undefined
}

/** `"AB12"` → 27 (zero-based column). -1 when the reference has no column letters. */
function columnIndex(ref: string): number {
  let col = 0
  let i = 0
  for (; i < ref.length; i++) {
    const code = ref.charCodeAt(i)
    const upper = code >= 97 && code <= 122 ? code - 32 : code
    if (upper < 65 || upper > 90) break
    col = col * 26 + (upper - 64)
    // Excel's last column is XFD (16384); anything wider is not a reference.
    if (col > 16384) return -1
  }
  return i === 0 ? -1 : col - 1
}

// ---------------------------------------------------------------------------
// XML scanning
// ---------------------------------------------------------------------------

interface ScannedTag {
  /** Local name, namespace prefix removed. */
  name: string
  closing: boolean
  selfClosing: boolean
  /** Raw attribute text. */
  attrs: string
  /** Index of the tag's `<`. */
  start: number
  /** Index just past the tag's `>`. */
  end: number
}

/**
 * Walk every element tag in `xml`, in document order. Linear in the input:
 * the attribute class excludes `<`, so a failed match never scans past the
 * next `<`. Comments, CDATA, processing instructions and the DOCTYPE
 * (including any internal subset) are skipped, never interpreted.
 */
function scanTags(xml: string, visit: (tag: ScannedTag) => void): void {
  const tagPattern = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^<>]*)>/y
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) return
    const next = xml.charCodeAt(lt + 1)
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      i = skipMarkupDeclaration(xml, lt)
      continue
    }
    tagPattern.lastIndex = lt
    const match = tagPattern.exec(xml)
    if (!match) {
      i = lt + 1
      continue
    }
    let attrs = match[3]
    const selfClosing = attrs.endsWith('/')
    if (selfClosing) attrs = attrs.slice(0, -1)
    visit({
      name: match[2],
      closing: match[1] === '/',
      selfClosing,
      attrs,
      start: lt,
      end: tagPattern.lastIndex,
    })
    i = tagPattern.lastIndex
  }
}

/** Index just past a `<!-- -->`, `<![CDATA[ ]]>`, `<? ?>` or `<!DOCTYPE …>` starting at `lt`. */
function skipMarkupDeclaration(xml: string, lt: number): number {
  const skipTo = (terminator: string, from: number) => {
    const end = xml.indexOf(terminator, from)
    return end < 0 ? xml.length : end + terminator.length
  }
  if (xml.startsWith('<!--', lt)) return skipTo('-->', lt + 4)
  if (xml.startsWith('<![CDATA[', lt)) return skipTo(']]>', lt + 9)
  if (xml.startsWith('<?', lt)) return skipTo('?>', lt + 2)
  const close = xml.indexOf('>', lt)
  if (close < 0) return xml.length
  const bracket = xml.indexOf('[', lt)
  // A DOCTYPE internal subset nests `<!ENTITY …>` declarations inside `[…]`.
  if (bracket >= 0 && bracket < close) return skipTo(']>', bracket)
  return close + 1
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrPattern = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = attrPattern.exec(raw)) !== null) {
    attrs[match[1]] = decodeText(match[2] ?? match[3] ?? '')
  }
  return attrs
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

/**
 * Decode the five predefined XML entities, numeric character references, and
 * OOXML's `_xHHHH_` escapes. Any other entity reference — including one a
 * DOCTYPE declares — is left as literal text: nothing is ever resolved.
 */
function decodeText(text: string): string {
  if (!text.includes('&') && !text.includes('_x')) return text
  return text
    .replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g, (whole, ref: string) => {
      if (ref[0] === '#') {
        const code =
          ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole
      }
      return NAMED_ENTITIES[ref] ?? whole
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
}
