import { describe, it, expect } from 'vitest'
import {
  SUSPENDED_CASCADES,
  CANCELLED_CASCADES,
  CLOSED_CASCADES,
  getCascadesForStatus,
  getDefaultSelections,
  type StatusCascadeKey,
} from '@/lib/account-status-cascades'
import { ACCOUNT_STATUS } from '@/lib/constants'

describe('ACCOUNT_STATUS enum (regression guard)', () => {
  it('contains the 6 canonical values', () => {
    expect(ACCOUNT_STATUS).toEqual([
      'Active',
      'Pending Formation',
      'Delinquent',
      'Suspended',
      'Cancelled',
      'Closed',
    ])
  })
})

describe('getCascadesForStatus', () => {
  it('returns suspended cascades for Suspended', () => {
    const result = getCascadesForStatus('Suspended')
    expect(result).toBe(SUSPENDED_CASCADES)
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns cancelled cascades for Cancelled', () => {
    expect(getCascadesForStatus('Cancelled')).toBe(CANCELLED_CASCADES)
  })

  it('returns closed cascades for Closed', () => {
    expect(getCascadesForStatus('Closed')).toBe(CLOSED_CASCADES)
  })

  it('returns empty array for Active', () => {
    expect(getCascadesForStatus('Active')).toEqual([])
  })

  it('returns empty array for Pending Formation', () => {
    expect(getCascadesForStatus('Pending Formation')).toEqual([])
  })

  it('returns empty array for Delinquent', () => {
    expect(getCascadesForStatus('Delinquent')).toEqual([])
  })

  it('returns empty array for unknown status', () => {
    expect(getCascadesForStatus('Bogus')).toEqual([])
  })
})

describe('CLOSED_CASCADES', () => {
  it('is a superset of CANCELLED_CASCADES', () => {
    const cancelledKeys = CANCELLED_CASCADES.map((a) => a.key)
    const closedKeys = CLOSED_CASCADES.map((a) => a.key)
    for (const key of cancelledKeys) {
      expect(closedKeys).toContain(key)
    }
  })

  it('has runClosureDocs defaulting to UNCHECKED (safety)', () => {
    const action = CLOSED_CASCADES.find((a) => a.key === 'runClosureDocs')
    expect(action).toBeDefined()
    expect(action!.defaultChecked).toBe(false)
  })

  it('has all other cascades defaulting to CHECKED', () => {
    for (const a of CLOSED_CASCADES) {
      if (a.key === 'runClosureDocs') continue
      expect(a.defaultChecked).toBe(true)
    }
  })
})

describe('SUSPENDED_CASCADES', () => {
  it('includes suspendPortal and blockNewServices', () => {
    const keys = SUSPENDED_CASCADES.map((a) => a.key)
    expect(keys).toContain('suspendPortal')
    expect(keys).toContain('blockNewServices')
  })

  it('does NOT include destructive cascades (no delivery/deadline cancellation)', () => {
    const keys = SUSPENDED_CASCADES.map((a) => a.key)
    expect(keys).not.toContain('cancelDeliveries')
    expect(keys).not.toContain('cancelDeadlines')
    expect(keys).not.toContain('closeOpenTasks')
    expect(keys).not.toContain('voidPendingPayments')
    expect(keys).not.toContain('revokePortalAccess')
  })
})

describe('getDefaultSelections', () => {
  it('returns empty object for non-cascading status', () => {
    expect(getDefaultSelections('Active')).toEqual({})
  })

  it('returns Suspended defaults with both keys true', () => {
    const selections = getDefaultSelections('Suspended')
    expect(selections.blockNewServices).toBe(true)
    expect(selections.suspendPortal).toBe(true)
  })

  it('returns Closed defaults with runClosureDocs explicitly false', () => {
    const selections = getDefaultSelections('Closed')
    expect(selections.runClosureDocs).toBe(false)
    expect(selections.cancelDeliveries).toBe(true)
    expect(selections.revokePortalAccess).toBe(true)
  })

  it('keys are a subset of StatusCascadeKey', () => {
    const validKeys: StatusCascadeKey[] = [
      'blockNewServices',
      'suspendPortal',
      'cancelDeliveries',
      'cancelDeadlines',
      'createRACancelTask',
      'closeOpenTasks',
      'voidPendingPayments',
      'revokePortalAccess',
      'runClosureDocs',
    ]
    for (const status of ['Suspended', 'Cancelled', 'Closed']) {
      const selections = getDefaultSelections(status)
      for (const key of Object.keys(selections)) {
        expect(validKeys).toContain(key as StatusCascadeKey)
      }
    }
  })
})
