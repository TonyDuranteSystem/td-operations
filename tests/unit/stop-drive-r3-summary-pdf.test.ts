/**
 * Stop Drive S1d, form lanes round 3 — item 1: the summary PDF is byte-identical for identical answers, so a replay stores no new version.
 */
import { describe, it, expect, vi } from 'vitest'

describe('1. the summary PDF is deterministic', () => {
  it('identical answers made at two different moments give identical bytes (and the old way did not)', async () => {
    const { generateFormSummaryPDF, FORM_CONFIGS } = await import('@/lib/form-to-drive')
    const config = FORM_CONFIGS['banking_relay']
    const meta = { token: 't', submittedAt: '2026-10-18T00:00:00.000Z', companyName: 'Acme', uploadCount: 1 }
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
      const a = await generateFormSummaryPDF(config, { business_name: 'Acme' }, { ...meta, deterministic: true })
      const oldA = await generateFormSummaryPDF(config, { business_name: 'Acme' }, meta)
      vi.setSystemTime(new Date('2026-10-18T10:00:07Z'))
      const b = await generateFormSummaryPDF(config, { business_name: 'Acme' }, { ...meta, deterministic: true })
      const oldB = await generateFormSummaryPDF(config, { business_name: 'Acme' }, meta)
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
      expect(Buffer.from(oldA).equals(Buffer.from(oldB))).toBe(false) // proves the check is not vacuous
    } finally { vi.useRealTimers() }
  })
  it('saveFormToDrive (the storage branch every banking lane uses) hands the store the SAME bytes on a replay', async () => {
    vi.resetModules()
    const seen: Buffer[] = []
    vi.doMock('@/lib/crm-store/save-form', async () => ({
      parseStorageMarker: (m: string) => { const x = /^(account|person)-storage:(.+)$/.exec(m); return x ? { kind: x[1] === 'account' ? 'account' : 'contact', id: x[2] } : null },
      switchedTargetForFolder: async () => null,
      saveFormToStore: async (spec: { summary: { bytes: Buffer } | null }) => { if (spec.summary) seen.push(spec.summary.bytes); return { summaryFileId: 'x', copied: [], failed: [], skipped: [], errors: [] } },
    }))
    vi.doMock('@/lib/crm-store/switched-drive-guard', () => ({ personFilesInStorage: async () => false, liveOwnerOfContact: async () => null, liveOwnerOfAccount: async () => 'o1', companyDocState: async () => 'store' }))
    const { saveFormToDrive } = await import('@/lib/form-to-drive')
    vi.useFakeTimers()
    try {
      for (const t of ['2026-10-18T10:00:00Z', '2026-10-18T10:05:31Z']) {
        vi.setSystemTime(new Date(t))
        await saveFormToDrive('banking_relay', { business_name: 'Acme' }, [], 'account-storage:a1', { token: 'tok', submittedAt: '2026-10-18T00:00:00.000Z', companyName: 'Acme' })
      }
    } finally { vi.useRealTimers(); vi.doUnmock('@/lib/crm-store/save-form'); vi.doUnmock('@/lib/crm-store/switched-drive-guard') }
    expect(seen).toHaveLength(2)
    expect(seen[0].equals(seen[1])).toBe(true)
  })
})

