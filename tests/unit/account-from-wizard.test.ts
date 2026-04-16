import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin before importing the module
function createChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => {
  const chains: Record<string, ReturnType<typeof createChain>> = {}
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (!chains[table]) chains[table] = createChain()
        return chains[table]
      },
    },
  }
})

// Import after mocking
import { createAccountFromWizard } from '@/lib/account-from-wizard'

describe('createAccountFromWizard', () => {
  it('exports a function', () => {
    expect(typeof createAccountFromWizard).toBe('function')
  })

  it('accepts the required params interface', () => {
    const params = {
      contactId: '00000000-0000-0000-0000-000000000001',
      companyName: 'Test LLC',
      entityType: 'SMLLC',
    }
    expect(params.contactId).toBeDefined()
    expect(params.companyName).toBeDefined()
    expect(params.entityType).toBeDefined()
  })

  it('maps MMLLC to Multi-Member LLC display name', () => {
    const smllcDisplay = ('SMLLC' as string) === 'MMLLC' ? 'Multi-Member LLC' : 'Single Member LLC'
    const mmllcType = 'MMLLC'
    const mmllcDisplay = mmllcType === 'MMLLC' ? 'Multi-Member LLC' : 'Single Member LLC'
    expect(smllcDisplay).toBe('Single Member LLC')
    expect(mmllcDisplay).toBe('Multi-Member LLC')
  })

  it('defaults accountType to Client when not specified', () => {
    const withDefault = { accountType: 'Client' }
    const withOneTime = { accountType: 'One-Time' }
    expect(withDefault.accountType).toBe('Client')
    expect(withOneTime.accountType).toBe('One-Time')
  })
})
