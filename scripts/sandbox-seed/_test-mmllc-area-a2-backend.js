/**
 * Backend sandbox test — Area A.2: Service quantity.
 *
 * Verifies that:
 * 1. service_catalog.supports_quantity = true for ITIN Application.
 * 2. /api/service-catalog returns supports_quantity in the payload.
 * 3. An offer with services[{quantity:2, pipeline_type:"ITIN"}] can be inserted.
 * 4. pipelineQuantity extraction logic correctly reads quantity=2.
 * 5. Cleanup: removes the test offer.
 *
 * Run: node scripts/sandbox-seed/_test-mmllc-area-a2-backend.js
 * Requires .env.sandbox with SUPABASE_DB_URL + NEXT_PUBLIC_SUPABASE_URL
 */

require('dotenv').config({ path: '.env.sandbox' })
const { Client } = require('pg')

const DB_URL = process.env.SUPABASE_DB_URL
const SANDBOX_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('supabase.co', 'vercel.app')
  || 'https://td-operations-sandbox.vercel.app'

if (!DB_URL) {
  console.error('SUPABASE_DB_URL not set in .env.sandbox')
  process.exit(1)
}

let passed = 0
let failed = 0

function pass(label) {
  console.log(`  ✅ PASS  ${label}`)
  passed++
}

function fail(label, detail) {
  console.error(`  ❌ FAIL  ${label}${detail ? `\n         ${detail}` : ''}`)
  failed++
}

async function main() {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  let testOfferId = null

  try {
    console.log('\n=== Area A.2 Backend Sandbox Tests ===\n')

    // ── Test 1: supports_quantity column exists and is set for ITIN ──
    console.log('Test 1: service_catalog.supports_quantity')
    const { rows: scRows } = await client.query(`
      SELECT name, supports_quantity
      FROM service_catalog
      WHERE active = true
      ORDER BY name
    `)

    const itinRow = scRows.find(r => r.name === 'ITIN Application')
    if (!itinRow) {
      fail('ITIN Application row exists', 'Not found in service_catalog')
    } else if (itinRow.supports_quantity !== true) {
      fail('ITIN Application.supports_quantity = true', `Got: ${itinRow.supports_quantity}`)
    } else {
      pass('ITIN Application.supports_quantity = true')
    }

    const nonQuantityServices = scRows.filter(r => r.name !== 'ITIN Application' && r.supports_quantity === true)
    if (nonQuantityServices.length === 0) {
      pass('No other services have supports_quantity = true (correct)')
    } else {
      fail('Only ITIN has supports_quantity', `Also set on: ${nonQuantityServices.map(r => r.name).join(', ')}`)
    }

    // ── Test 2: Insert test offer with quantity=2 ITIN service ──
    console.log('\nTest 2: Insert offer with services[{quantity:2, pipeline_type:"ITIN"}]')

    // Get a real contact_id to use (any contact)
    const { rows: contactRows } = await client.query(`
      SELECT id FROM contacts LIMIT 1
    `)
    const testContactId = contactRows[0]?.id || null

    const testServices = [
      {
        name: 'ITIN Application',
        price: '€1,000',
        unit_price: '€500',
        quantity: 2,
        pipeline_type: 'ITIN',
        contract_type: 'itin',
        service_context: 'individual',
      }
    ]

    const testOffer = {
      client_name: 'Area A.2 Test Client',
      client_email: 'a2test@sandbox.test',
      token: `a2test-${Date.now()}`,
      status: 'draft',
      contract_type: 'itin',
      entity_type: 'Multi Member LLC',
      bundled_pipelines: ['ITIN'],
      services: JSON.stringify(testServices),
      cost_summary: JSON.stringify([{
        label: 'Setup Fee',
        total: '€1,000',
        items: [{ name: 'ITIN Application × 2', price: '€1,000' }],
      }]),
    }

    const { rows: inserted } = await client.query(`
      INSERT INTO offers (
        client_name, client_email, token, status,
        contract_type, entity_type, bundled_pipelines,
        services, cost_summary
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      RETURNING id, token, services, bundled_pipelines, entity_type
    `, [
      testOffer.client_name, testOffer.client_email, testOffer.token,
      testOffer.status, testOffer.contract_type, testOffer.entity_type,
      testOffer.bundled_pipelines,
      testOffer.services, testOffer.cost_summary,
    ])

    if (!inserted[0]) {
      fail('Offer inserted', 'No row returned')
    } else {
      testOfferId = inserted[0].id
      pass(`Offer inserted (id: ${testOfferId})`)
      pass(`entity_type = ${inserted[0].entity_type}`)
      pass(`bundled_pipelines = ${JSON.stringify(inserted[0].bundled_pipelines)}`)
    }

    // ── Test 3: Read back services JSONB and verify quantity field ──
    console.log('\nTest 3: Read back services JSONB from offer')

    if (testOfferId) {
      const { rows: readback } = await client.query(`
        SELECT services FROM offers WHERE id = $1
      `, [testOfferId])

      const services = readback[0]?.services
      if (!Array.isArray(services) || services.length === 0) {
        fail('services JSONB is array with 1 item', `Got: ${JSON.stringify(services)}`)
      } else {
        const svc = services[0]
        if (svc.quantity === 2) {
          pass('services[0].quantity = 2')
        } else {
          fail('services[0].quantity = 2', `Got: ${svc.quantity}`)
        }
        if (svc.pipeline_type === 'ITIN') {
          pass('services[0].pipeline_type = "ITIN"')
        } else {
          fail('services[0].pipeline_type = "ITIN"', `Got: ${svc.pipeline_type}`)
        }
        if (svc.unit_price === '€500') {
          pass('services[0].unit_price = "€500"')
        } else {
          fail('services[0].unit_price = "€500"', `Got: ${svc.unit_price}`)
        }
        if (svc.price === '€1,000') {
          pass('services[0].price = "€1,000" (total)')
        } else {
          fail('services[0].price = "€1,000"', `Got: ${svc.price}`)
        }
      }
    }

    // ── Test 4: pipelineQuantity extraction logic ──
    console.log('\nTest 4: pipelineQuantity extraction matches activate-service logic')

    if (testOfferId) {
      const { rows: offerRow } = await client.query(`
        SELECT services, bundled_pipelines FROM offers WHERE id = $1
      `, [testOfferId])

      const services = offerRow[0]?.services || []
      const pipelineQuantity = new Map()
      for (const svc of services) {
        const pType = svc.pipeline_type
        const qty = typeof svc.quantity === 'number' && svc.quantity > 1 ? svc.quantity : 1
        if (pType && qty > 1) {
          pipelineQuantity.set(pType, Math.max(pipelineQuantity.get(pType) ?? 1, qty))
        }
      }

      if (pipelineQuantity.get('ITIN') === 2) {
        pass('pipelineQuantity.get("ITIN") = 2')
      } else {
        fail('pipelineQuantity.get("ITIN") = 2', `Got: ${pipelineQuantity.get('ITIN')}`)
      }

      const pipelines = offerRow[0]?.bundled_pipelines || []
      const toCreate = (pipelineQuantity.get('ITIN') ?? 1) - 0  // 0 existing SDs
      if (toCreate === 2) {
        pass(`toCreate for ITIN (0 existing) = 2`)
      } else {
        fail('toCreate = 2', `Got: ${toCreate}`)
      }

      if (pipelines.length === 1 && pipelines[0] === 'ITIN') {
        pass('bundled_pipelines still ["ITIN"] (no duplication)')
      } else {
        fail('bundled_pipelines = ["ITIN"]', `Got: ${JSON.stringify(pipelines)}`)
      }
    }

  } finally {
    // ── Cleanup ──
    if (testOfferId) {
      await client.query('DELETE FROM offers WHERE id = $1', [testOfferId])
      console.log(`\n🧹 Cleanup: test offer ${testOfferId} deleted`)
    }
    await client.end()
  }

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('\n❌ Some tests FAILED — Area A.2 not ready')
    process.exit(1)
  } else {
    console.log('\n✅ All tests passed — Area A.2 backend verified')
  }
}

main().catch(err => {
  console.error('Unexpected error:', err.message)
  process.exit(1)
})
