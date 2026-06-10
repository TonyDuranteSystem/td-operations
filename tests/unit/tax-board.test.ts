import { describe, it, expect } from 'vitest'
import {
  buildBoardColumns,
  daysInStage,
  stalenessLevel,
  OTHER_COLUMN_KEY,
  isReviewSubstateColumn,
  isDroppableColumn,
  resolveDrop,
  summarizeBulkAdvance,
  type BoardColumnDef,
  type BoardCard,
} from '@/lib/tax/tax-board'

const COLUMNS: BoardColumnDef[] = [
  { stage_name: '1st Installment Paid', stage_order: 10, client_label: '1st Installment Paid', icon: '💰', color: null, stale_days: 14 },
  { stage_name: 'Extension Filed', stage_order: 20, client_label: 'Extension Filed', icon: '📄', color: null, stale_days: null },
  { stage_name: 'Wizard Available', stage_order: 40, client_label: 'Wizard Available', icon: '📨', color: null, stale_days: 30 },
  { stage_name: 'Data Submitted', stage_order: 45, client_label: 'Data Submitted', icon: '📝', color: null, stale_days: 7 },
  { stage_name: 'Under Review', stage_order: 46, client_label: 'Under Review', icon: '🔍', color: null, stale_days: 5 },
  { stage_name: 'Approved', stage_order: 48, client_label: 'Approved', icon: '✅', color: null, stale_days: null },
  { stage_name: 'Preparation', stage_order: 60, client_label: 'With Accountant', icon: '📊', color: null, stale_days: null },
  { stage_name: 'TR Filed', stage_order: 80, client_label: 'Filed', icon: '📬', color: null, stale_days: null },
]

function card(partial: Partial<BoardCard> & { sdId: string }): BoardCard {
  return {
    accountId: 'a1',
    companyName: 'Acme LLC',
    entityType: 'MMLLC',
    sdStage: null,
    stageEnteredAt: null,
    reviewStatus: null,
    taxYear: 2025,
    returnType: 'MMLLC',
    deadline: null,
    paid: true,
    extensionFiled: false,
    assignedTo: null,
    ...partial,
  }
}

describe('daysInStage', () => {
  const now = new Date('2026-06-10T12:00:00Z')
  it('returns whole days since entry', () => {
    expect(daysInStage('2026-06-01T12:00:00Z', now)).toBe(9)
  })
  it('returns 0 for a future timestamp (clock skew)', () => {
    expect(daysInStage('2026-06-20T12:00:00Z', now)).toBe(0)
  })
  it('returns null for missing/invalid timestamps', () => {
    expect(daysInStage(null, now)).toBeNull()
    expect(daysInStage('not-a-date', now)).toBeNull()
  })
})

describe('stalenessLevel', () => {
  it('flags stale at/over threshold', () => {
    expect(stalenessLevel(7, 7)).toBe('stale')
    expect(stalenessLevel(10, 7)).toBe('stale')
  })
  it('warns at half the threshold', () => {
    expect(stalenessLevel(4, 7)).toBe('warn') // ceil(7/2)=4
    expect(stalenessLevel(3, 7)).toBe('fresh')
  })
  it('never alarms without a rule or without a day count', () => {
    expect(stalenessLevel(100, null)).toBe('fresh')
    expect(stalenessLevel(null, 7)).toBe('fresh')
    expect(stalenessLevel(5, 0)).toBe('fresh')
  })
})

describe('buildBoardColumns', () => {
  it('places cards in their SD-stage column and keeps catalog order', () => {
    const cols = buildBoardColumns(COLUMNS, [
      card({ sdId: '1', sdStage: 'Extension Filed' }),
      card({ sdId: '2', sdStage: '1st Installment Paid' }),
    ])
    expect(cols.map(c => c.stage_name).slice(0, 2)).toEqual(['1st Installment Paid', 'Extension Filed'])
    expect(cols.find(c => c.stage_name === 'Extension Filed')!.count).toBe(1)
    expect(cols.find(c => c.stage_name === '1st Installment Paid')!.count).toBe(1)
  })

  it('overlays review_status so an under_review submission leaves Data Submitted', () => {
    const cols = buildBoardColumns(COLUMNS, [
      card({ sdId: '1', sdStage: 'Data Submitted', reviewStatus: 'under_review' }),
      card({ sdId: '2', sdStage: 'Data Submitted', reviewStatus: 'approved' }),
      card({ sdId: '3', sdStage: 'Data Submitted', reviewStatus: 'submitted' }),
    ])
    expect(cols.find(c => c.stage_name === 'Under Review')!.count).toBe(1)
    expect(cols.find(c => c.stage_name === 'Approved')!.count).toBe(1)
    expect(cols.find(c => c.stage_name === 'Data Submitted')!.count).toBe(1) // submitted stays
  })

  it('never drags an advanced SD backwards via stale review_status', () => {
    const cols = buildBoardColumns(COLUMNS, [
      card({ sdId: '1', sdStage: 'Preparation', reviewStatus: 'approved' }),
    ])
    expect(cols.find(c => c.stage_name === 'Preparation')!.count).toBe(1)
    expect(cols.find(c => c.stage_name === 'Approved')!.count).toBe(0)
  })

  it('routes off-catalog stages into the Other column, never dropping them', () => {
    const cols = buildBoardColumns(COLUMNS, [
      card({ sdId: '1', sdStage: 'Filed' }),        // catalog has "TR Filed", not "Filed"
      card({ sdId: '2', sdStage: 'In Progress' }),  // generic non-tax stage
      card({ sdId: '3', sdStage: 'Company Data Pending' }), // intake, not a board col here
    ])
    const other = cols.find(c => c.stage_name === OTHER_COLUMN_KEY)!
    expect(other.isOther).toBe(true)
    expect(other.count).toBe(3)
    expect(cols[cols.length - 1].stage_name).toBe(OTHER_COLUMN_KEY) // appended last
  })

  it('omits the Other column when every card matches a board stage', () => {
    const cols = buildBoardColumns(COLUMNS, [card({ sdId: '1', sdStage: 'Approved', reviewStatus: null })])
    expect(cols.some(c => c.stage_name === OTHER_COLUMN_KEY)).toBe(false)
  })

  it('routes a null-stage card to Other', () => {
    const cols = buildBoardColumns(COLUMNS, [card({ sdId: '1', sdStage: null })])
    expect(cols.find(c => c.stage_name === OTHER_COLUMN_KEY)!.count).toBe(1)
  })

  it('returns empty columns (no Other) for no cards', () => {
    const cols = buildBoardColumns(COLUMNS, [])
    expect(cols.every(c => c.count === 0)).toBe(true)
    expect(cols.some(c => c.stage_name === OTHER_COLUMN_KEY)).toBe(false)
  })
})

describe('drag-to-advance legality (Slice 7b)', () => {
  const realA = { stage_name: 'Extension Filed', isOther: false }
  const realB = { stage_name: '1st Installment Paid', isOther: false }
  const dataReceived = { stage_name: 'Data Received', isOther: false }
  const reviewCol = { stage_name: 'Under Review', isOther: false }
  const otherCol = { stage_name: OTHER_COLUMN_KEY, isOther: true }

  it('identifies the five review sub-state columns', () => {
    for (const n of ['Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed']) {
      expect(isReviewSubstateColumn(n)).toBe(true)
    }
    expect(isReviewSubstateColumn('Extension Filed')).toBe(false)
    expect(isReviewSubstateColumn('Data Received')).toBe(false)
  })

  it('only real SD-stage columns are droppable/draggable', () => {
    expect(isDroppableColumn(realA)).toBe(true)
    expect(isDroppableColumn(dataReceived)).toBe(true) // post-review real stage stays draggable
    expect(isDroppableColumn(reviewCol)).toBe(false)
    expect(isDroppableColumn(otherCol)).toBe(false)
  })

  it('allows a drag between two real different stages', () => {
    expect(resolveDrop(realB, realA)).toEqual({ ok: true })
  })

  it('allows dragging a post-review (Data Received) card forward', () => {
    expect(resolveDrop(dataReceived, { stage_name: 'Preparation', isOther: false })).toEqual({ ok: true })
  })

  it('rejects dropping onto a review sub-state column', () => {
    const d = resolveDrop(realA, reviewCol)
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/review actions/i)
  })

  it('rejects dropping onto the Other column', () => {
    const d = resolveDrop(realA, otherCol)
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/not a stage/i)
  })

  it('rejects dragging FROM a review sub-state column', () => {
    const d = resolveDrop(reviewCol, realA)
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/review loop/i)
  })

  it('rejects a no-op drop onto the same stage', () => {
    const d = resolveDrop(realB, { stage_name: '1st Installment Paid', isOther: false })
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/already/i)
  })
})

describe('summarizeBulkAdvance (Slice 7c)', () => {
  const target = { stage_name: 'Extension Filed', isOther: false }

  it('partitions a mixed selection into eligible vs skipped', () => {
    const items = [
      { sdId: 'a', source: { stage_name: '1st Installment Paid', isOther: false } }, // eligible
      { sdId: 'b', source: { stage_name: 'Wizard Available', isOther: false } },     // eligible
      { sdId: 'c', source: { stage_name: 'Under Review', isOther: false } },         // review → skip
      { sdId: 'd', source: { stage_name: 'Extension Filed', isOther: false } },      // same stage → skip
      { sdId: 'e', source: { stage_name: OTHER_COLUMN_KEY, isOther: true } },        // off-pipeline → skip
    ]
    const s = summarizeBulkAdvance(items, target)
    expect(s.eligible).toEqual(['a', 'b'])
    expect(s.skipped.map(x => x.sdId)).toEqual(['c', 'd', 'e'])
    expect(s.skipped.find(x => x.sdId === 'd')!.reason).toMatch(/already/i)
    expect(s.skipped.find(x => x.sdId === 'c')!.reason).toMatch(/review/i)
  })

  it('returns all eligible when every card is a different real stage', () => {
    const items = [
      { sdId: 'a', source: { stage_name: '1st Installment Paid', isOther: false } },
      { sdId: 'b', source: { stage_name: 'Data Received', isOther: false } },
    ]
    const s = summarizeBulkAdvance(items, target)
    expect(s.eligible).toEqual(['a', 'b'])
    expect(s.skipped).toEqual([])
  })

  it('skips everything when target is a review column', () => {
    const items = [{ sdId: 'a', source: { stage_name: '1st Installment Paid', isOther: false } }]
    const s = summarizeBulkAdvance(items, { stage_name: 'Approved', isOther: false })
    expect(s.eligible).toEqual([])
    expect(s.skipped).toHaveLength(1)
  })

  it('handles an empty selection', () => {
    const s = summarizeBulkAdvance([], target)
    expect(s).toEqual({ eligible: [], skipped: [] })
  })
})
