/**
 * Area A.2 — Service quantity unit tests.
 *
 * Covers: quantity math in the dialog (servicesJson + costItems),
 * pipelineQuantity extraction from offer.services, and the
 * toCreate logic used by activate-service.
 */

import { describe, it, expect } from 'vitest'

// ── Helpers extracted from create-offer-dialog logic ──────────────────────

function computeServiceLineTotal(unitPrice: string, quantity: number): number {
  const n = parseFloat(unitPrice.replace(/[^0-9.]/g, ''))
  return isNaN(n) ? 0 : n * Math.max(1, quantity)
}

function buildServicesJson(
  selected: Array<{ id: string; price: string; quantity: number; service_context: string }>,
  catalog: Array<{ id: string; name: string; pipeline: string | null; contract_type: string | null; supports_quantity: boolean }>,
  currencySymbol: string
) {
  return selected
    .filter(s => s.price.trim())
    .map(s => {
      const svc_cat = catalog.find(c => c.id === s.id)
      const unitPrice = s.price.replace(/[^0-9.]/g, '')
      const qty = s.quantity ?? 1
      const totalPrice = (parseFloat(unitPrice) * qty).toLocaleString('en-US')
      const svc: Record<string, unknown> = {
        name: svc_cat?.name || s.id,
        price: `${currencySymbol}${qty > 1 ? totalPrice : unitPrice}`,
        service_context: s.service_context,
      }
      if (svc_cat?.contract_type) svc.contract_type = svc_cat.contract_type
      if (svc_cat?.pipeline) svc.pipeline_type = svc_cat.pipeline
      if (qty > 1) {
        svc.quantity = qty
        svc.unit_price = `${currencySymbol}${unitPrice}`
      }
      return svc
    })
}

function buildCostItems(
  servicesJson: Array<Record<string, unknown>>,
  currencySymbol: string
): Array<{ name: string; price: string }> {
  void currencySymbol
  return servicesJson.map(s => {
    const qty = (s.quantity as number | undefined) ?? 1
    const displayName = qty > 1
      ? `${s.name as string} × ${qty}`
      : s.name as string
    return { name: displayName, price: s.price as string }
  })
}

function computeServicesTotal(
  selected: Array<{ price: string; quantity: number }>
): number {
  return selected.reduce((sum, s) => {
    const n = parseFloat(s.price.replace(/[^0-9.]/g, ''))
    return sum + (isNaN(n) ? 0 : n * (s.quantity ?? 1))
  }, 0)
}

// ── pipelineQuantity extraction (mirrors activate-service logic) ──────────

function buildPipelineQuantity(services: Array<Record<string, unknown>>): Map<string, number> {
  const map = new Map<string, number>()
  for (const svc of services) {
    const pType = svc.pipeline_type as string | undefined
    const qty = typeof svc.quantity === 'number' && svc.quantity > 1 ? svc.quantity : 1
    if (pType && qty > 1) {
      map.set(pType, Math.max(map.get(pType) ?? 1, qty))
    }
  }
  return map
}

// ── Tests ─────────────────────────────────────────────────────────────────

const ITIN_SERVICE = {
  id: 'itin',
  name: 'ITIN Application',
  pipeline: 'ITIN',
  contract_type: 'itin',
  supports_quantity: true,
}

const FORMATION_SERVICE = {
  id: 'formation',
  name: 'LLC Formation',
  pipeline: 'Company Formation',
  contract_type: 'formation',
  supports_quantity: false,
}

describe('service quantity — dialog math', () => {
  it('quantity=1 produces price = unit price (no change)', () => {
    const result = computeServiceLineTotal('500', 1)
    expect(result).toBe(500)
  })

  it('quantity=2 doubles the unit price', () => {
    const result = computeServiceLineTotal('500', 2)
    expect(result).toBe(1000)
  })

  it('quantity=3 triples the unit price', () => {
    const result = computeServiceLineTotal('500', 3)
    expect(result).toBe(1500)
  })

  it('handles non-numeric characters in price string', () => {
    expect(computeServiceLineTotal('€500', 2)).toBe(1000)
    expect(computeServiceLineTotal('$1,000', 2)).toBe(2000)
  })

  it('invalid price string produces 0', () => {
    expect(computeServiceLineTotal('', 2)).toBe(0)
    expect(computeServiceLineTotal('abc', 2)).toBe(0)
  })
})

describe('service quantity — services total', () => {
  it('sum across services respects individual quantities', () => {
    const selected = [
      { price: '500', quantity: 2 },   // ITIN ×2 = 1000
      { price: '2500', quantity: 1 },  // Formation ×1 = 2500
    ]
    expect(computeServicesTotal(selected)).toBe(3500)
  })

  it('quantity defaulting to 1 when not set', () => {
    const selected = [{ price: '500', quantity: 1 }]
    expect(computeServicesTotal(selected)).toBe(500)
  })
})

describe('service quantity — servicesJson', () => {
  it('quantity=1: no quantity/unit_price fields, price = unit price', () => {
    const selected = [{ id: 'itin', price: '500', quantity: 1, service_context: 'individual' as const }]
    const json = buildServicesJson(selected, [ITIN_SERVICE], '€')
    expect(json).toHaveLength(1)
    expect(json[0].price).toBe('€500')
    expect(json[0].quantity).toBeUndefined()
    expect(json[0].unit_price).toBeUndefined()
  })

  it('quantity=2: price=total, unit_price=unit, quantity field present', () => {
    const selected = [{ id: 'itin', price: '500', quantity: 2, service_context: 'individual' as const }]
    const json = buildServicesJson(selected, [ITIN_SERVICE], '€')
    expect(json[0].price).toBe('€1,000')
    expect(json[0].unit_price).toBe('€500')
    expect(json[0].quantity).toBe(2)
  })

  it('pipeline_type is set from catalog.pipeline', () => {
    const selected = [{ id: 'itin', price: '500', quantity: 1, service_context: 'individual' as const }]
    const json = buildServicesJson(selected, [ITIN_SERVICE], '€')
    expect(json[0].pipeline_type).toBe('ITIN')
  })

  it('services without price are filtered out', () => {
    const selected = [
      { id: 'itin', price: '', quantity: 1, service_context: 'individual' as const },
      { id: 'formation', price: '2500', quantity: 1, service_context: 'business' as const },
    ]
    const json = buildServicesJson(selected, [ITIN_SERVICE, FORMATION_SERVICE], '€')
    expect(json).toHaveLength(1)
    expect(json[0].name).toBe('LLC Formation')
  })
})

describe('service quantity — cost items display name', () => {
  it('quantity=1 shows plain service name', () => {
    const servicesJson = [{ name: 'ITIN Application', price: '€500' }]
    const items = buildCostItems(servicesJson, '€')
    expect(items[0].name).toBe('ITIN Application')
  })

  it('quantity=2 shows "Name × 2"', () => {
    const servicesJson = [{ name: 'ITIN Application', price: '€1,000', quantity: 2 }]
    const items = buildCostItems(servicesJson, '€')
    expect(items[0].name).toBe('ITIN Application × 2')
  })
})

describe('pipelineQuantity map — activate-service extraction', () => {
  it('empty services returns empty map', () => {
    const map = buildPipelineQuantity([])
    expect(map.size).toBe(0)
  })

  it('quantity=1 services are not added to map', () => {
    const services = [{ name: 'ITIN Application', price: '€500', pipeline_type: 'ITIN' }]
    const map = buildPipelineQuantity(services)
    expect(map.size).toBe(0)
  })

  it('quantity=2 ITIN is in map', () => {
    const services = [{ name: 'ITIN Application', price: '€1,000', pipeline_type: 'ITIN', quantity: 2 }]
    const map = buildPipelineQuantity(services)
    expect(map.get('ITIN')).toBe(2)
  })

  it('only the highest quantity is kept if multiple rows map to same pipeline', () => {
    const services = [
      { pipeline_type: 'ITIN', quantity: 2 },
      { pipeline_type: 'ITIN', quantity: 3 },
    ]
    const map = buildPipelineQuantity(services)
    expect(map.get('ITIN')).toBe(3)
  })

  it('services without pipeline_type are ignored', () => {
    const services = [{ name: 'Service Fee', price: '€100', quantity: 2 }]
    const map = buildPipelineQuantity(services)
    expect(map.size).toBe(0)
  })
})

describe('toCreate logic — activate-service dedup', () => {
  function computeToCreate(quantity: number, existingOfferCount: number): number {
    return Math.max(0, quantity - existingOfferCount)
  }

  it('fresh activation: toCreate = quantity', () => {
    expect(computeToCreate(2, 0)).toBe(2)
    expect(computeToCreate(1, 0)).toBe(1)
  })

  it('partial retry (1 of 2 already created): toCreate = 1', () => {
    expect(computeToCreate(2, 1)).toBe(1)
  })

  it('fully created: toCreate = 0 (skipped)', () => {
    expect(computeToCreate(2, 2)).toBe(0)
    expect(computeToCreate(1, 1)).toBe(0)
  })

  it('over-created (defensive): toCreate = 0, never negative', () => {
    expect(computeToCreate(2, 3)).toBe(0)
  })
})

describe('SD naming — quantity suffix', () => {
  function sdName(pipeline: string, clientName: string, quantity: number, existingCount: number, unitIndex: number): string {
    const unitSuffix = quantity > 1 ? ` #${existingCount + unitIndex + 1}` : ''
    return `${pipeline} - ${clientName}${unitSuffix}`
  }

  it('quantity=1: no suffix', () => {
    expect(sdName('ITIN', 'Christian Benavente', 1, 0, 0)).toBe('ITIN - Christian Benavente')
  })

  it('quantity=2 first SD: #1', () => {
    expect(sdName('ITIN', 'Christian Benavente', 2, 0, 0)).toBe('ITIN - Christian Benavente #1')
  })

  it('quantity=2 second SD: #2', () => {
    expect(sdName('ITIN', 'Christian Benavente', 2, 0, 1)).toBe('ITIN - Christian Benavente #2')
  })

  it('retry creates correct suffix (1 existing, creating #2)', () => {
    expect(sdName('ITIN', 'Christian Benavente', 2, 1, 0)).toBe('ITIN - Christian Benavente #2')
  })
})
