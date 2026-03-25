'use client'

import { useState } from 'react'
import { Wrench, Trash2, Loader2, AlertTriangle } from 'lucide-react'

const SCENARIOS = [
  { value: 'lead_new', label: 'Lead - New', desc: 'Lead only (test offer creation)' },
  { value: 'lead_offer_sent', label: 'Lead - Offer Sent', desc: 'Lead with signed offer (test payment confirmation)' },
  { value: 'formation_stage_1', label: 'Formation Stage 1', desc: 'Lead+Contact+SD (test wizard data collection)' },
  { value: 'formation_stage_2', label: 'Formation Stage 2', desc: '+Account (test state filing)' },
  { value: 'formation_stage_3', label: 'Formation Stage 3 (SS-4)', desc: '+formation_date (test SS-4 generation)' },
  { value: 'formation_stage_4', label: 'Formation Stage 4 (Welcome)', desc: '+EIN (test welcome package, OA, Lease)' },
  { value: 'formation_completed', label: 'Formation Completed', desc: 'Everything done (test portal as active client)' },
  { value: 'onboarding_paid', label: 'Onboarding - Paid', desc: 'Lead+Contact, no account (test onboarding wizard)' },
  { value: 'onboarding_completed', label: 'Onboarding - Completed', desc: 'Contact+Account+services done' },
  { value: 'tax_annual', label: 'Tax Return', desc: 'Contact+Account+tax_return (test tax wizard)' },
  { value: 'itin_individual', label: 'ITIN (Individual)', desc: 'Contact only, no account (test ITIN wizard)' },
] as const

interface TestResult {
  type: 'setup' | 'cleanup' | 'error'
  message: string
}

export function DevToolsPanel() {
  const [scenario, setScenario] = useState<string>(SCENARIOS[4].value) // Default: formation_stage_3
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const handleSetup = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/crm/test-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setup', scenario }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult({ type: 'error', message: data.error || 'Setup failed' })
      } else {
        setResult({ type: 'setup', message: data.message })
      }
    } catch (err) {
      setResult({ type: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setLoading(false)
    }
  }

  const handleCleanup = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/crm/test-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult({ type: 'error', message: data.error || 'Cleanup failed' })
      } else {
        setResult({ type: 'cleanup', message: data.message })
      }
    } catch (err) {
      setResult({ type: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setLoading(false)
    }
  }

  const selectedDesc = SCENARIOS.find(s => s.value === scenario)?.desc || ''

  return (
    <div className="bg-white rounded-lg border border-amber-200 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Wrench className="h-4 w-4 text-amber-600" />
        <h3 className="text-xs font-medium text-amber-700 uppercase tracking-wide">
          Dev Tools
        </h3>
        <span className="ml-auto text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">
          ADMIN
        </span>
      </div>

      <div className="space-y-3">
        {/* Scenario selector */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Test Scenario</label>
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            disabled={loading}
            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-white focus:ring-1 focus:ring-amber-400 focus:border-amber-400"
          >
            {SCENARIOS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">{selectedDesc}</p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleSetup}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
            Create Test Data
          </button>
          <button
            onClick={handleCleanup}
            disabled={loading}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 text-xs font-medium rounded-md border border-red-200 hover:bg-red-100 disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Clean
          </button>
        </div>

        {/* Result display */}
        {result && (
          <div className={`text-xs p-2.5 rounded-md whitespace-pre-wrap max-h-40 overflow-y-auto ${
            result.type === 'error'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : result.type === 'cleanup'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-amber-50 text-amber-800 border border-amber-200'
          }`}>
            {result.message}
          </div>
        )}

        {/* Warning */}
        <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span>Test data gets &quot;TEST -&quot; prefix and is_test=true. Excluded from stats, syncs, and crons.</span>
        </div>
      </div>
    </div>
  )
}
