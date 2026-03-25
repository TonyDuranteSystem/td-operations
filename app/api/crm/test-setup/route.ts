/**
 * POST /api/crm/test-setup
 *
 * Admin-only API for creating/cleaning test data from the CRM Dev Tools panel.
 * Delegates to the same functions used by the MCP test_setup/test_cleanup tools.
 *
 * Body: { action: 'setup', scenario: string } | { action: 'cleanup' }
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import {
  runScenario,
  countTestRecords,
  deleteTestRecords,
} from '@/lib/mcp/tools/testing'

export async function POST(request: Request) {
  // Auth check — admin only
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const body = await request.json()
    const { action, scenario } = body

    if (action === 'setup') {
      if (!scenario) {
        return NextResponse.json({ error: 'Scenario is required' }, { status: 400 })
      }

      // Check for existing test data
      const existingCounts = await countTestRecords()
      const totalExisting = Object.values(existingCounts).reduce((a, b) => a + b, 0)
      if (totalExisting > 0) {
        return NextResponse.json({
          error: `Existing test data found (${totalExisting} records). Clean up first.`,
          counts: existingCounts,
        }, { status: 409 })
      }

      const result = await runScenario(scenario)
      const message = [
        `Test scenario "${scenario}" created:`,
        '',
        ...result.summary,
        '',
        result.lead_id ? `Lead: ${result.lead_id}` : null,
        result.contact_id ? `Contact: ${result.contact_id}` : null,
        result.account_id ? `Account: ${result.account_id}` : null,
        result.sd_id ? `SD: ${result.sd_id}` : null,
        result.payment_id ? `Payment: ${result.payment_id}` : null,
      ].filter(Boolean).join('\n')

      return NextResponse.json({ ok: true, message, result })

    } else if (action === 'cleanup') {
      const counts = await countTestRecords()
      const total = Object.values(counts).reduce((a, b) => a + b, 0)

      if (total === 0) {
        return NextResponse.json({ ok: true, message: 'No test data found. Nothing to clean.' })
      }

      const deleted = await deleteTestRecords()
      const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0)
      const message = [
        `Cleaned ${totalDeleted} test records:`,
        '',
        ...Object.entries(deleted)
          .filter(([, c]) => c > 0)
          .map(([table, count]) => `  ${table}: ${count} deleted`),
      ].join('\n')

      return NextResponse.json({ ok: true, message, deleted })

    } else {
      return NextResponse.json({ error: 'Invalid action. Use "setup" or "cleanup".' }, { status: 400 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[test-setup] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
