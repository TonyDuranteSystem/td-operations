/**
 * Calendly webhook REPLAY (booking engine, Stage 1a — the proof that moving the lead-creation tail changed nothing).
 *
 * Reads the stored real Calendly bookings from a folder OUTSIDE the repo (BOOKING_REPLAY_DIR, file payloads.json —
 * they hold real emails and are never committed), runs the webhook handler on every one of them against a recording
 * fake database in ~19 different situations, and either
 *   BOOKING_REPLAY_MODE=record  → saves golden.json (run ONLY on unmodified code; refuses to overwrite), or
 *   BOOKING_REPLAY_MODE=compare → runs the same replay and requires the result to equal golden.json.
 * BOOKING_REPLAY_LEVEL=strict (default: every query, write, module call, log line and the answer must be identical)
 * or =behaviour (writes, module calls and the answer only — used once new, switched-off code reads one more setting).
 *
 * With BOOKING_REPLAY_DIR unset the whole file is skipped, so `npm run test:unit` and CI never touch real data.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'
import { SCENARIOS, beginRun, endRun, recordLog, makeReq, behaviourView, type Trace } from './helpers/calendly-replay-harness'

vi.mock('@supabase/supabase-js', async () => {
  const h = await import('./helpers/calendly-replay-harness')
  return { createClient: () => h.fakeClient() }
})
vi.mock('@/lib/operations/paid-call-credit', async () => {
  const h = await import('./helpers/calendly-replay-harness')
  return {
    recordPaidCall: async (args: unknown) => {
      h.recordModuleCall('recordPaidCall', args)
      if (h.currentScenario().paidCallThrows) throw new Error('paid call failed')
      return { invoiceNumber: 'INV-000001', creditNumber: 'CR-000001', contactCreated: false, paymentIntentStamped: true }
    },
  }
})
vi.mock('@/lib/operations/referral', async () => {
  const h = await import('./helpers/calendly-replay-harness')
  return {
    createPendingReferral: async (args: unknown) => {
      h.recordModuleCall('createPendingReferral', args)
      const sc = h.currentScenario()
      if (sc.referralThrows) throw new Error('referral failed')
      return sc.referralCreated === false ? { created: false } : { created: true, id: 'referral-1' }
    },
  }
})
vi.mock('@/lib/operations/referral-notify', async () => {
  const h = await import('./helpers/calendly-replay-harness')
  return {
    notifyReferrerLinked: async (args: unknown) => {
      h.recordModuleCall('notifyReferrerLinked', args)
    },
  }
})
vi.mock('@/lib/system-errors', async () => {
  const h = await import('./helpers/calendly-replay-harness')
  return {
    reportSystemError: async (args: unknown) => {
      h.recordModuleCall('reportSystemError', args)
    },
  }
})

import { POST } from '@/app/api/webhooks/calendly/route'

const DIR = process.env.BOOKING_REPLAY_DIR
const MODE = process.env.BOOKING_REPLAY_MODE === 'record' ? 'record' : 'compare'
const LEVEL = process.env.BOOKING_REPLAY_LEVEL === 'behaviour' ? 'behaviour' : 'strict'

interface StoredPayload { id: string; created_at: string; review_status: string; payload: unknown }
interface Golden {
  recordedAt: string
  routeSha256: string
  payloadCount: number
  scenarios: string[]
  results: Record<string, Record<string, Trace>>
}

async function runOne(payload: unknown, scenarioIndex: number): Promise<Trace> {
  const scenario = SCENARIOS[scenarioIndex]
  const trace = beginRun(scenario)
  process.env.CALENDLY_INTAKE_MODE = scenario.mode ?? 'auto_create'
  try {
    const res = await POST(makeReq(payload) as unknown as NextRequest)
    trace.response = { status: res.status, body: await res.json() }
  } catch (e) {
    trace.response = { thrown: e instanceof Error ? e.message : String(e) }
  }
  endRun()
  return JSON.parse(JSON.stringify(trace))
}

const view = (t: Trace) => (LEVEL === 'strict' ? t : behaviourView(t))

describe.skipIf(!DIR)('calendly webhook replay (real stored bookings, private folder)', () => {
  let payloads: StoredPayload[] = []
  const restore: Array<() => void> = []

  beforeAll(() => {
    payloads = JSON.parse(fs.readFileSync(path.join(DIR!, 'payloads.json'), 'utf8'))
    delete process.env.CALENDLY_WEBHOOK_SECRET
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'))
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => recordLog('warn: ' + a.map(String).join(' ')))
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => recordLog('error: ' + a.map(String).join(' ')))
    restore.push(() => warn.mockRestore(), () => err.mockRestore(), () => vi.useRealTimers())
  })
  afterAll(() => restore.forEach((f) => f()))

  it(MODE === 'record' ? 'records the golden baseline from the current code' : `replays every booking and matches the golden baseline (${LEVEL})`, async () => {
    expect(payloads.length).toBeGreaterThan(0)
    const results: Record<string, Record<string, Trace>> = {}
    for (const p of payloads) {
      results[p.id] = {}
      for (let i = 0; i < SCENARIOS.length; i++) results[p.id][SCENARIOS[i].name] = await runOne(p.payload, i)
    }

    // coverage numbers only (no emails): how the 19 situations ended across all bookings
    const outcomes: Record<string, Record<string, number>> = {}
    for (const s of SCENARIOS) {
      outcomes[s.name] = {}
      for (const p of payloads) {
        const r = results[p.id][s.name].response
        const key = 'thrown' in r ? 'thrown' : `${r.status}:${(r.body as { action?: string; error?: string })?.action ?? (r.body as { error?: string })?.error ?? 'other'}`
        outcomes[s.name][key] = (outcomes[s.name][key] ?? 0) + 1
      }
    }
    const routeSha = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../../app/api/webhooks/calendly/route.ts'))).digest('hex')
    const goldenPath = path.join(DIR!, 'golden.json')

    if (MODE === 'record') {
      if (fs.existsSync(goldenPath) && process.env.BOOKING_REPLAY_FORCE !== '1') throw new Error('golden.json already exists — refusing to overwrite the baseline')
      const golden: Golden = { recordedAt: new Date().toISOString(), routeSha256: routeSha, payloadCount: payloads.length, scenarios: SCENARIOS.map((s) => s.name), results }
      fs.writeFileSync(goldenPath, JSON.stringify(golden), { mode: 0o600 })
      fs.writeFileSync(path.join(DIR!, 'golden-summary.json'), JSON.stringify({ recordedAt: golden.recordedAt, routeSha256: routeSha, payloadCount: payloads.length, runs: payloads.length * SCENARIOS.length, outcomes }, null, 2), { mode: 0o600 })
      return
    }

    const golden: Golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))
    expect(golden.payloadCount).toBe(payloads.length)
    let identical = 0
    const diffs: Array<{ payload: string; scenario: string }> = []
    for (const p of payloads) {
      for (const s of SCENARIOS) {
        const same = JSON.stringify(view(results[p.id][s.name])) === JSON.stringify(view(golden.results[p.id][s.name]))
        if (same) identical++
        else diffs.push({ payload: p.id, scenario: s.name })
      }
    }
    const summary = { level: LEVEL, goldenRouteSha256: golden.routeSha256, currentRouteSha256: routeSha, runs: payloads.length * SCENARIOS.length, identical, different: diffs.length, firstDifferences: diffs.slice(0, 10), outcomes }
    fs.writeFileSync(path.join(DIR!, `last-compare-${LEVEL}.json`), JSON.stringify(summary, null, 2), { mode: 0o600 })
    expect(diffs).toEqual([])
    expect(identical).toBe(payloads.length * SCENARIOS.length)
  }, 180_000)
})
