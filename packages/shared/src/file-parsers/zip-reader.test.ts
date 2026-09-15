/**
 * @vitest-environment node
 */
import { deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { ZipLimitError, ZipReader } from './zip-reader.ts'

async function zipOf(
  files: Record<string, string | Buffer>,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE'
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer', compression })
}

/** Offset of the first central-directory header in `buf`. */
function centralDirectoryOffset(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt32LE(i + 16)
  }
  throw new Error('no end record')
}

describe('ZipReader', () => {
  it('reads deflated and stored entries', async () => {
    for (const compression of ['DEFLATE', 'STORE'] as const) {
      const buf = await zipOf({ 'a.txt': 'hello', 'dir/b.xml': '<x>ünï</x>' }, compression)
      const zip = new ZipReader(buf)
      expect(zip.names()).toEqual(expect.arrayContaining(['a.txt', 'dir/b.xml']))
      expect(zip.read('a.txt')?.toString('utf8')).toBe('hello')
      expect(zip.read('dir/b.xml')?.toString('utf8')).toBe('<x>ünï</x>')
    }
  })

  it('returns undefined for a missing entry and matches names case-insensitively', async () => {
    const zip = new ZipReader(await zipOf({ 'xl/Workbook.xml': 'w' }))
    expect(zip.read('nope.xml')).toBeUndefined()
    expect(zip.read('xl/workbook.xml')?.toString()).toBe('w')
  })

  it('refuses an archive declaring more entries than the limit', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = String(i)
    const buf = await zipOf(files)
    expect(() => new ZipReader(buf, { maxEntries: 10 })).toThrow(ZipLimitError)
    expect(() => new ZipReader(buf, { maxEntries: 20 })).not.toThrow()
  })

  it('refuses a decompression bomb once the total uncompressed budget is spent', async () => {
    const bomb = Buffer.alloc(4 * 1024 * 1024, 0)
    const buf = await zipOf({ 'bomb.bin': bomb })
    expect(buf.length).toBeLessThan(64 * 1024)
    const zip = new ZipReader(buf, { maxTotalUncompressedBytes: 1024 * 1024 })
    expect(() => zip.read('bomb.bin')).toThrow(ZipLimitError)
  })

  it('counts the budget across entries, not per entry', async () => {
    const part = Buffer.alloc(600 * 1024, 1)
    const zip = new ZipReader(await zipOf({ 'a.bin': part, 'b.bin': part }), {
      maxTotalUncompressedBytes: 1024 * 1024,
    })
    expect(zip.read('a.bin')?.length).toBe(part.length)
    expect(() => zip.read('b.bin')).toThrow(ZipLimitError)
  })

  it('does not trust a header that under-declares the uncompressed size', async () => {
    const buf = await zipOf({ 'liar.bin': Buffer.alloc(4 * 1024 * 1024, 0) })
    const cd = centralDirectoryOffset(buf)
    buf.writeUInt32LE(10, cd + 24) // central-directory uncompressed size: "10 bytes"
    const zip = new ZipReader(buf, { maxTotalUncompressedBytes: 1024 * 1024 })
    expect(() => zip.read('liar.bin')).toThrow(ZipLimitError)
  })

  it('refuses an entry whose inflated size does not match its header', async () => {
    const buf = await zipOf({ 'x.txt': 'abcdefghij' })
    const cd = centralDirectoryOffset(buf)
    buf.writeUInt32LE(5, cd + 24)
    expect(() => new ZipReader(buf).read('x.txt')).toThrow(/Malformed zip/)
  })

  it('refuses input that is not a zip', () => {
    expect(() => new ZipReader(Buffer.from('definitely not a zip archive at all'))).toThrow(
      /Not a zip archive/
    )
    expect(() => new ZipReader(Buffer.alloc(4))).toThrow(/Not a zip archive/)
  })

  it('refuses a truncated archive', async () => {
    const buf = await zipOf({ 'a.txt': 'hello world' })
    expect(() => new ZipReader(buf.subarray(0, buf.length - 30))).toThrow()
  })

  it('refuses corrupt deflate data', async () => {
    const content = 'x'.repeat(1000)
    const buf = await zipOf({ 'a.txt': content })
    const good = deflateRawSync(Buffer.from(content))
    const at = buf.indexOf(good.subarray(0, 4))
    expect(at).toBeGreaterThan(0)
    buf.fill(0xff, at, at + good.length)
    expect(() => new ZipReader(buf).read('a.txt')).toThrow()
  })

  it('refuses an encrypted entry', async () => {
    const buf = await zipOf({ 'a.txt': 'secret' })
    const cd = centralDirectoryOffset(buf)
    buf.writeUInt16LE(buf.readUInt16LE(cd + 8) | 0x1, cd + 8)
    expect(() => new ZipReader(buf).read('a.txt')).toThrow(/Encrypted/)
  })
})
