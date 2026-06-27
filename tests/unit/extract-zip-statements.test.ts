import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { extractZipStatements } from '@/lib/bank-statement-parser'

function makeZip(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content)
  return Buffer.from(zipSync(entries))
}

describe('extractZipStatements', () => {
  it('returns only PDF/CSV statements with basenames, skipping junk and folders', async () => {
    const zip = makeZip({
      'statements/jan.pdf': 'pdf-bytes',
      'statements/feb.csv': 'date,amount\n2025-02-01,10',
      'statements/readme.txt': 'ignore me',
      '__MACOSX/._jan.pdf': 'mac junk',
    })
    const out = await extractZipStatements(zip)
    const names = out.map(e => e.name).sort()
    expect(names).toEqual(['feb.csv', 'jan.pdf'])
    expect(out.find(e => e.name === 'jan.pdf')!.mime).toBe('application/pdf')
    expect(out.find(e => e.name === 'feb.csv')!.mime).toBe('text/csv')
    // bytes preserved
    expect(Buffer.from(out.find(e => e.name === 'feb.csv')!.bytes).toString()).toContain('2025-02-01')
  })

  it('returns empty for an archive with no statements', async () => {
    const out = await extractZipStatements(makeZip({ 'notes.txt': 'x', 'pic.png': 'y' }))
    expect(out).toEqual([])
  })

  it('throws on a corrupt archive', async () => {
    await expect(extractZipStatements(Buffer.from('not a zip at all'))).rejects.toThrow()
  })
})
