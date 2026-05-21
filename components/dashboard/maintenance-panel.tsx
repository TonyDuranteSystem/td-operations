'use client'

import { useEffect, useState } from 'react'
import { Wrench, Loader2, AlertTriangle, Banknote, EyeOff, Mail } from 'lucide-react'

type Result =
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

export function MaintenancePanel() {
  const [airwallexLoading, setAirwallexLoading] = useState(false)
  const [airwallexResult, setAirwallexResult] = useState<Result | null>(null)

  // Renewal-banner gate (app_settings.renewal_banner_min_year)
  const [bannerYear, setBannerYear] = useState<string>('')
  const [bannerLoaded, setBannerLoaded] = useState(false)
  const [bannerSaving, setBannerSaving] = useState(false)
  const [bannerResult, setBannerResult] = useState<Result | null>(null)

  // Portal-message admin email toggle (app_settings.portal_admin_email_on_client_message)
  const EMAIL_KEY = 'portal_admin_email_on_client_message'
  const [emailOn, setEmailOn] = useState(true)
  const [emailLoaded, setEmailLoaded] = useState(false)
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailResult, setEmailResult] = useState<Result | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/renewal-banner-year')
      .then(r => r.json())
      .then(d => { if (!cancelled && typeof d.value === 'number') setBannerYear(String(d.value)) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setBannerLoaded(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/app-settings?key=${EMAIL_KEY}`)
      .then(r => r.json())
      // default ON: only false when explicitly stored false
      .then(d => { if (!cancelled) setEmailOn(d.value !== false) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setEmailLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const handleToggleEmail = async () => {
    const next = !emailOn
    setEmailSaving(true)
    setEmailResult(null)
    try {
      const res = await fetch('/api/app-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: EMAIL_KEY, value: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEmailResult({ kind: 'error', message: data.error || 'Save failed' })
      } else {
        setEmailOn(next)
        setEmailResult({ kind: 'ok', message: next ? 'On — emails will be sent for new portal messages' : 'Off — no more emails for portal messages (push still active)' })
      }
    } catch (err) {
      setEmailResult({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setEmailSaving(false)
    }
  }

  const handleSaveBannerYear = async () => {
    setBannerSaving(true)
    setBannerResult(null)
    try {
      const res = await fetch('/api/admin/renewal-banner-year', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Number(bannerYear) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setBannerResult({ kind: 'error', message: data.error || 'Save failed' })
      } else {
        setBannerResult({ kind: 'ok', message: `Saved — banner shows only for agreement_year ≥ ${data.value}` })
      }
    } catch (err) {
      setBannerResult({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setBannerSaving(false)
    }
  }

  const handleAirwallexBackfill = async () => {
    setAirwallexLoading(true)
    setAirwallexResult(null)
    try {
      const res = await fetch('/api/admin/airwallex-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '2026-01-01' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAirwallexResult({ kind: 'error', message: data.error || 'Backfill failed' })
      } else {
        setAirwallexResult({
          kind: 'ok',
          message: `Backfilled ${data.from} → ${data.to}: added ${data.added}, skipped ${data.skipped}, errors ${data.errors}`,
        })
      }
    } catch (err) {
      setAirwallexResult({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setAirwallexLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-blue-200 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Wrench className="h-4 w-4 text-blue-600" />
        <h3 className="text-xs font-medium text-blue-700 uppercase tracking-wide">
          Maintenance
        </h3>
        <span className="ml-auto text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
          ADMIN
        </span>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground mb-2">
            One-off operational triggers. These run against the live system —
            re-using them later is safe (idempotent on `external_id`).
          </p>

          <button
            onClick={handleAirwallexBackfill}
            disabled={airwallexLoading}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {airwallexLoading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Banknote className="h-3.5 w-3.5" />}
            Backfill Airwallex deposits (since Jan 1)
          </button>

          {airwallexResult && (
            <div className={`mt-2 text-xs p-2.5 rounded-md whitespace-pre-wrap max-h-40 overflow-y-auto ${
              airwallexResult.kind === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}>
              {airwallexResult.message}
            </div>
          )}
        </div>

        <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span>Backfill writes to td_bank_feeds via upsert on external_id — re-running won&apos;t duplicate rows.</span>
        </div>

        <div className="border-t border-blue-100 pt-3 mt-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <EyeOff className="h-3.5 w-3.5 text-blue-600" />
            <span className="text-xs font-medium text-blue-900">Renewal banner gate</span>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Portal renewal-MSA banner only renders when the current year is ≥ this value.
            Default 2027 (hides 2026 during legacy-payment purgatory). Bump higher to extend the hide.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={2025}
              max={2100}
              value={bannerYear}
              onChange={(e) => setBannerYear(e.target.value)}
              disabled={!bannerLoaded || bannerSaving}
              className="flex-1 px-2.5 py-1.5 text-xs border border-blue-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              placeholder="2027"
            />
            <button
              onClick={handleSaveBannerYear}
              disabled={!bannerLoaded || bannerSaving || !bannerYear}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {bannerSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </button>
          </div>
          {bannerResult && (
            <div className={`mt-2 text-xs p-2.5 rounded-md ${
              bannerResult.kind === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}>
              {bannerResult.message}
            </div>
          )}
        </div>

        <div className="border-t border-blue-100 pt-3 mt-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Mail className="h-3.5 w-3.5 text-blue-600" />
            <span className="text-xs font-medium text-blue-900">Email on new portal messages</span>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            When on, a client&apos;s portal chat message emails support@tonydurante.us. Turn off to stop
            those emails — push notifications still arrive either way.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleEmail}
              disabled={!emailLoaded || emailSaving}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
                emailOn
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-zinc-100 text-zinc-600 border-zinc-300 hover:bg-zinc-200'
              }`}
            >
              {emailSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {emailOn ? 'On' : 'Off'}
            </button>
            <span className="text-xs text-muted-foreground">
              {emailLoaded ? (emailOn ? 'Emails are being sent' : 'Emails are silenced') : 'Loading…'}
            </span>
          </div>
          {emailResult && (
            <div className={`mt-2 text-xs p-2.5 rounded-md ${
              emailResult.kind === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}>
              {emailResult.message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
