import { inflateRawSync } from 'node:zlib'

/**
 * A minimal, read-only ZIP reader for the OOXML packages the spreadsheet parser
 * opens. It exists so `.xlsx` parsing needs no third-party dependency
 * (ADR 0012): an `.xlsx` is a zip of XML parts, and Node already ships the one
 * hard piece, raw DEFLATE, in `node:zlib`.
 *
 * Scope is deliberately narrow — stored (method 0) and deflated (method 8)
 * entries from a single-volume, non-ZIP64, unencrypted archive, located through
 * the central directory. Anything else is refused with a clear error rather
 * than guessed at.
 *
 * Every size is untrusted. The reader caps the number of central-directory
 * entries and the total bytes it will inflate across all reads, and it inflates
 * with `maxOutputLength` so a lying header cannot make it allocate more than
 * the remaining budget: a decompression bomb fails with {@link ZipLimitError}
 * after at most the budget, not after exhausting memory.
 */

export const DEFAULT_MAX_ZIP_ENTRIES = 10_000
export const DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

export interface ZipReaderLimits {
  /** Most central-directory entries an archive may declare. */
  maxEntries?: number
  /** Most bytes the reader will produce across every entry it is asked to read. */
  maxTotalUncompressedBytes?: number
}

/** The archive is well-formed but asks for more than the reader's caps allow. */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipLimitError'
  }
}

interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff
const CENTRAL_HEADER_LENGTH = 46
const LOCAL_HEADER_LENGTH = 30

export class ZipReader {
  private readonly buffer: Buffer
  private readonly entries = new Map<string, ZipEntry>()
  private readonly entriesLowerCase = new Map<string, ZipEntry>()
  private readonly maxTotalUncompressedBytes: number
  private inflatedBytes = 0

  constructor(buffer: Buffer, limits: ZipReaderLimits = {}) {
    this.buffer = buffer
    const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES
    this.maxTotalUncompressedBytes =
      limits.maxTotalUncompressedBytes ?? DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES
    this.readCentralDirectory(maxEntries)
  }

  /** Entry names, in central-directory order. */
  names(): string[] {
    return [...this.entries.keys()]
  }

  has(name: string): boolean {
    return this.find(name) !== undefined
  }

  /**
   * Inflate one entry. Returns `undefined` when the archive has no such entry.
   * Name lookup is exact first, then case-insensitive (producers disagree on
   * the case of OOXML part names).
   */
  read(name: string): Buffer | undefined {
    const entry = this.find(name)
    if (!entry) return undefined

    if (entry.flags & 0x1) {
      throw new Error(`Encrypted zip entries are not supported: ${entry.name}`)
    }

    const remaining = this.maxTotalUncompressedBytes - this.inflatedBytes
    if (entry.uncompressedSize > remaining) {
      throw new ZipLimitError(
        `Zip entry ${entry.name} declares ${entry.uncompressedSize} bytes, over the ${this.maxTotalUncompressedBytes}-byte uncompressed limit`
      )
    }

    const buf = this.buffer
    const offset = entry.localHeaderOffset
    if (offset + LOCAL_HEADER_LENGTH > buf.length || buf.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw new Error(`Malformed zip: bad local header for ${entry.name}`)
    }
    const dataStart =
      offset + LOCAL_HEADER_LENGTH + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > buf.length) {
      throw new Error(`Malformed zip: data for ${entry.name} runs past the end of the archive`)
    }
    const data = buf.subarray(dataStart, dataEnd)

    let out: Buffer
    if (entry.method === 0) {
      out = data
    } else if (entry.method === 8) {
      try {
        // Cap the inflate at the remaining budget, not at the declared size:
        // a header that under-declares must not buy a bigger allocation.
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
          throw new ZipLimitError(
            `Zip entry ${entry.name} inflates past the ${this.maxTotalUncompressedBytes}-byte uncompressed limit`
          )
        }
        throw new Error(`Malformed zip: cannot inflate ${entry.name}: ${(error as Error).message}`)
      }
    } else {
      throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`)
    }

    if (out.length !== entry.uncompressedSize) {
      throw new Error(
        `Malformed zip: ${entry.name} inflated to ${out.length} bytes, header declares ${entry.uncompressedSize}`
      )
    }
    if (out.length > remaining) {
      throw new ZipLimitError(
        `Zip entry ${entry.name} inflates past the ${this.maxTotalUncompressedBytes}-byte uncompressed limit`
      )
    }
    this.inflatedBytes += out.length
    return out
  }

  private find(name: string): ZipEntry | undefined {
    return this.entries.get(name) ?? this.entriesLowerCase.get(name.toLowerCase())
  }

  private readCentralDirectory(maxEntries: number): void {
    const buf = this.buffer
    if (buf.length < EOCD_MIN_LENGTH) {
      throw new Error('Not a zip archive: too short')
    }

    let eocd = -1
    const stop = Math.max(0, buf.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH)
    for (let i = buf.length - EOCD_MIN_LENGTH; i >= stop; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) {
      throw new Error('Not a zip archive: end of central directory not found')
    }

    const diskNumber = buf.readUInt16LE(eocd + 4)
    const cdDisk = buf.readUInt16LE(eocd + 6)
    const totalEntries = buf.readUInt16LE(eocd + 10)
    const cdSize = buf.readUInt32LE(eocd + 12)
    const cdOffset = buf.readUInt32LE(eocd + 16)

    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported')
    }
    if (diskNumber !== 0 || cdDisk !== 0) {
      throw new Error('Multi-volume zip archives are not supported')
    }
    if (totalEntries > maxEntries) {
      throw new ZipLimitError(
        `Zip archive declares ${totalEntries} entries, over the ${maxEntries}-entry limit`
      )
    }
    if (cdOffset + cdSize > eocd) {
      throw new Error('Malformed zip: central directory runs past its end record')
    }

    let p = cdOffset
    for (let i = 0; i < totalEntries; i++) {
      if (p + CENTRAL_HEADER_LENGTH > eocd || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
        throw new Error('Malformed zip: bad central directory header')
      }
      const flags = buf.readUInt16LE(p + 8)
      const method = buf.readUInt16LE(p + 10)
      const compressedSize = buf.readUInt32LE(p + 20)
      const uncompressedSize = buf.readUInt32LE(p + 24)
      const nameLength = buf.readUInt16LE(p + 28)
      const extraLength = buf.readUInt16LE(p + 30)
      const commentLength = buf.readUInt16LE(p + 32)
      const localHeaderOffset = buf.readUInt32LE(p + 42)
      const nameEnd = p + CENTRAL_HEADER_LENGTH + nameLength
      if (nameEnd > eocd) {
        throw new Error('Malformed zip: entry name runs past the central directory')
      }
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        throw new Error('ZIP64 archives are not supported')
      }
      // Bit 11 marks a UTF-8 name; OOXML part names are ASCII either way.
      const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + CENTRAL_HEADER_LENGTH, nameEnd)
      const entry: ZipEntry = {
        name,
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      }
      if (!this.entries.has(name)) this.entries.set(name, entry)
      const lower = name.toLowerCase()
      if (!this.entriesLowerCase.has(lower)) this.entriesLowerCase.set(lower, entry)
      p = nameEnd + extraLength + commentLength
    }
  }
}
