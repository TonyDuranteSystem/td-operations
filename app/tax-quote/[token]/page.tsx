'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic, LOGO_URL } from '@/lib/supabase/public-client'
import {
  LABELS,
  LLC_TYPE_OPTIONS,
  US_STATES,
  PRICING,
  type TaxQuoteSubmission,
  type LLCType,
} from '@/lib/types/tax-quote-form'

export default function TaxQuotePage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' }}>Loading...</div>}>
      <TaxQuoteContent />
    </Suspense>
  )
}

function TaxQuoteContent() {
  const { token } = useParams<{ token: string }>()
  const searchParams = useSearchParams()

  const [submission, setSubmission] = useState<TaxQuoteSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState<'en' | 'it'>('en')
  const [isAdmin, setIsAdmin] = useState(false)

  // Form fields
  const [llcName, setLlcName] = useState('')
  const [llcState, setLlcState] = useState('')
  const [llcType, setLlcType] = useState<LLCType | ''>('')
  const [taxYear, setTaxYear] = useState<number>(new Date().getFullYear() - 1)
  const [clientName, setClientName] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const L = LABELS[lang]
  const currentYear = new Date().getFullYear()
  const taxYears = [currentYear - 1, currentYear - 2, currentYear - 3]

  // --- Load Submission -------------------------------------------------------

  const loadSubmission = useCallback(async () => {
    try {
      const adminMode = searchParams.get('preview') === 'td'

      const { data, error: err } = await supabasePublic
        .from('tax_quote_submissions')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      const sub = data as TaxQuoteSubmission

      // Already completed
      if (sub.status === 'completed' || sub.status === 'processed') {
        setSubmission(sub)
        setLang(sub.language || 'en')
        setSubmitted(true)
        if (adminMode) setIsAdmin(true)
        setLoading(false)
        return
      }

      setSubmission(sub)
      setLang(sub.language || 'en')

      // Pre-fill if we have data from MCP tool
      if (sub.client_name) setClientName(sub.client_name)
      if (sub.client_email) setClientEmail(sub.client_email)

      if (adminMode) setIsAdmin(true)

      // Track open (non-admin only)
      if (!adminMode && (sub.status === 'pending' || sub.status === 'sent')) {
        supabasePublic
          .from('tax_quote_submissions')
          .update({ opened_at: new Date().toISOString(), status: 'opened' })
          .eq('id', sub.id)
          .then(() => {})
      }

      setLoading(false)
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, searchParams])

  useEffect(() => {
    if (!token) { setError('invalid_link'); setLoading(false); return }
    loadSubmission()
  }, [token, loadSubmission])

  useEffect(() => {
    if (submission) {
      document.title = `${L.title} — ${token}`
      document.documentElement.lang = lang
    }
  }, [submission, lang, token, L.title])

  // --- Validation ------------------------------------------------------------

  const isFormValid = llcName.trim() !== '' &&
    llcState !== '' &&
    llcType !== '' &&
    taxYear > 0 &&
    clientName.trim() !== '' &&
    clientEmail.trim() !== '' &&
    disclaimerAccepted

  // --- Submit ----------------------------------------------------------------

  async function handleSubmit() {
    if (!submission || !isFormValid || submitting) return
    setSubmitting(true)
    setSubmitError(null)

    try {
      const { error: updateErr } = await supabasePublic
        .from('tax_quote_submissions')
        .update({
          llc_name: llcName.trim(),
          llc_state: llcState,
          llc_type: llcType,
          tax_year: taxYear,
          client_name: clientName.trim(),
          client_email: clientEmail.trim().toLowerCase(),
          client_phone: clientPhone.trim() || null,
          status: 'completed',
          completed_at: new Date().toISOString(),
          client_user_agent: navigator.userAgent,
        })
        .eq('id', submission.id)

      if (updateErr) throw updateErr

      // Trigger auto-offer creation (non-blocking)
      try {
        await fetch('/api/tax-quote-completed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submission_id: submission.id, token: submission.token }),
        })
      } catch {
        // Non-blocking
      }

      setSubmitted(true)
      setSubmission(prev => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : null)
    } catch (err) {
      setSubmitError(L.errorSubmit)
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  // --- Render States ---------------------------------------------------------

  if (loading) return (
    <>
      <TaxQuoteStyles />
      <div className="tf-loading">
        <div className="tf-loading-spinner" />
        <span>{L.loading}</span>
      </div>
    </>
  )

  if (error) return (
    <>
      <TaxQuoteStyles />
      <div className="tf-error-page">
        <div>
          <h1>{L.notFound}</h1>
          <p>{L.notFoundMessage}</p>
        </div>
      </div>
    </>
  )

  if (!submission) return null

  // Success screen
  if (submitted) return (
    <>
      <TaxQuoteStyles />
      <div className="tf-success-page">
        <div className="tf-success-box">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Tony Durante LLC" className="tf-logo" />
          <div className="tf-success-icon">&#9989;</div>
          <h1>{L.successTitle}</h1>
          <p>{L.successMessage}</p>
        </div>
      </div>
    </>
  )

  // --- Pricing display based on selected LLC type ---
  const selectedPrice = llcType ? `$${PRICING[llcType].toLocaleString()}` : null

  // --- Main Form -------------------------------------------------------------

  return (
    <>
      <TaxQuoteStyles />
      <div className="tf-container">
        {/* Header */}
        <div className="tf-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Tony Durante LLC" className="tf-logo" />
          <div className="tf-lang-toggle">
            <button className={`tf-lang-btn ${lang === 'en' ? 'tf-lang-active' : ''}`} onClick={() => setLang('en')}>EN</button>
            <button className={`tf-lang-btn ${lang === 'it' ? 'tf-lang-active' : ''}`} onClick={() => setLang('it')}>IT</button>
          </div>
        </div>

        {/* Admin Preview Badge */}
        {isAdmin && (
          <div style={{ textAlign: 'center', marginBottom: -8 }}>
            <span style={{ display: 'inline-block', background: '#f59e0b', color: '#fff', padding: '3px 12px', borderRadius: 12, fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
              ADMIN PREVIEW
            </span>
          </div>
        )}

        {/* Hero */}
        <div className="tf-hero">
          <h1>{L.title}</h1>
          <p className="tf-hero-sub">{L.subtitle}</p>
        </div>

        {/* Form */}
        <div className="tf-step-content">
          <div className="tf-fields-grid">
            {/* LLC Name */}
            <div className="tf-field">
              <label className="tf-label">{L.llc_name}<span className="tf-required">*</span></label>
              <input
                type="text"
                className="tf-input"
                value={llcName}
                onChange={e => setLlcName(e.target.value)}
                placeholder="e.g. Alma Accelerator LLC"
              />
            </div>

            {/* LLC State */}
            <div className="tf-field">
              <label className="tf-label">{L.llc_state}<span className="tf-required">*</span></label>
              <select
                className="tf-input"
                value={llcState}
                onChange={e => setLlcState(e.target.value)}
              >
                <option value="">{L.selectPlaceholder}</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* LLC Type */}
            <div className="tf-field">
              <label className="tf-label">{L.llc_type}<span className="tf-required">*</span></label>
              <select
                className="tf-input"
                value={llcType}
                onChange={e => setLlcType(e.target.value as LLCType)}
              >
                <option value="">{L.selectPlaceholder}</option>
                {LLC_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o[lang]}</option>
                ))}
              </select>
            </div>

            {/* Tax Year */}
            <div className="tf-field">
              <label className="tf-label">{L.tax_year}<span className="tf-required">*</span></label>
              <select
                className="tf-input"
                value={taxYear}
                onChange={e => setTaxYear(Number(e.target.value))}
              >
                {taxYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            {/* Client Name */}
            <div className="tf-field">
              <label className="tf-label">{L.client_name}<span className="tf-required">*</span></label>
              <input
                type="text"
                className="tf-input"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
              />
            </div>

            {/* Client Email */}
            <div className="tf-field">
              <label className="tf-label">{L.client_email}<span className="tf-required">*</span></label>
              <input
                type="email"
                className="tf-input"
                value={clientEmail}
                onChange={e => setClientEmail(e.target.value)}
              />
            </div>

            {/* Client Phone */}
            <div className="tf-field">
              <label className="tf-label">{L.client_phone}</label>
              <input
                type="tel"
                className="tf-input"
                value={clientPhone}
                onChange={e => setClientPhone(e.target.value)}
              />
            </div>
          </div>

          {/* Pricing Note */}
          {selectedPrice && (
            <div className="tq-pricing-note">
              <strong>{lang === 'en' ? 'Estimated price' : 'Prezzo stimato'}:</strong> {selectedPrice}
            </div>
          )}

          {/* Disclaimer */}
          <div className="tf-disclaimer">
            <label className="tf-disclaimer-label">
              <input
                type="checkbox"
                checked={disclaimerAccepted}
                onChange={e => setDisclaimerAccepted(e.target.checked)}
                className="tf-disclaimer-checkbox"
              />
              <span>{L.disclaimer}</span>
            </label>
          </div>

          {submitError && <div className="tf-error-msg">{submitError}</div>}
        </div>

        {/* Submit Button */}
        <div className="tf-nav">
          <div className="tf-nav-spacer" />
          <button
            className="tf-nav-btn tf-nav-submit"
            onClick={handleSubmit}
            disabled={!isFormValid || submitting}
          >
            {submitting ? L.submitting : L.submit}
          </button>
        </div>
      </div>
    </>
  )
}

// --- Styles -------------------------------------------------------------------

function TaxQuoteStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;500;600;700&family=Playfair+Display:wght@700&display=swap');

      body { background: #f7f8fa !important; color: #374151 !important; font-family: 'Source Sans 3', -apple-system, sans-serif !important; line-height: 1.6 !important; -webkit-font-smoothing: antialiased; margin: 0; }

      :root {
        --tf-blue: #1e3a5f; --tf-blue-light: #e8eff7; --tf-blue-lighter: #f0f5fb;
        --tf-green: #059669; --tf-green-bg: #ecfdf5; --tf-green-border: #a7f3d0;
        --tf-red: #b8292f; --tf-yellow: #f59e0b; --tf-yellow-bg: #fffbeb; --tf-yellow-border: #fde68a;
        --tf-gray-100: #f7f8fa; --tf-gray-200: #edf0f4; --tf-gray-300: #d1d5db;
        --tf-gray-500: #6b7280; --tf-gray-700: #374151; --tf-white: #fff;
      }

      .tf-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-size: 18px; color: var(--tf-gray-500); }
      .tf-loading-spinner { width: 32px; height: 32px; border: 3px solid var(--tf-gray-200); border-top-color: var(--tf-blue); border-radius: 50%; animation: tf-spin 0.8s linear infinite; margin-bottom: 16px; }
      @keyframes tf-spin { to { transform: rotate(360deg); } }

      .tf-error-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; text-align: center; }
      .tf-error-page h1 { font-family: 'Playfair Display', serif; font-size: 28px; color: var(--tf-blue); margin-bottom: 12px; }
      .tf-error-page p { font-size: 16px; color: var(--tf-gray-500); }

      .tf-success-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .tf-success-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 520px; width: 100%; }
      .tf-success-icon { font-size: 48px; margin-bottom: 16px; }
      .tf-success-box h1 { font-family: 'Playfair Display', serif; font-size: 28px; color: var(--tf-green); margin-bottom: 12px; }
      .tf-success-box p { font-size: 16px; color: var(--tf-gray-500); line-height: 1.6; }

      .tf-logo { height: 44px; display: block; }
      .tf-container { max-width: 720px; margin: 0 auto; padding: 24px 16px 80px; }
      .tf-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
      .tf-lang-toggle { display: flex; gap: 4px; }
      .tf-lang-btn { padding: 6px 14px; border: 2px solid var(--tf-gray-200); border-radius: 6px; background: #fff; font-size: 14px; font-weight: 600; cursor: pointer; color: var(--tf-gray-500); transition: all .2s; }
      .tf-lang-active { border-color: var(--tf-blue); color: var(--tf-blue); background: var(--tf-blue-lighter); }

      .tf-hero { text-align: center; padding: 32px 0 24px; }
      .tf-hero h1 { font-family: 'Playfair Display', serif; font-size: 32px; color: var(--tf-blue); margin: 0 0 8px; }
      .tf-hero-sub { font-size: 16px; color: var(--tf-gray-500); }

      .tf-step-content { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.06); padding: 32px; margin-bottom: 16px; }

      .tf-fields-grid { display: flex; flex-direction: column; gap: 20px; }
      .tf-field { position: relative; }
      .tf-label { font-size: 14px; font-weight: 600; color: var(--tf-gray-700); display: block; margin-bottom: 6px; }
      .tf-required { color: var(--tf-red); margin-left: 4px; }

      .tf-input { width: 100%; padding: 12px 14px; border: 2px solid var(--tf-gray-200); border-radius: 8px; font-size: 15px; font-family: inherit; outline: none; transition: border-color .2s; box-sizing: border-box; background: #fff; }
      .tf-input:focus { border-color: var(--tf-blue); }

      .tq-pricing-note { background: var(--tf-blue-lighter); border: 1px solid #c9d8ea; border-radius: 12px; padding: 16px 20px; margin-top: 24px; font-size: 15px; color: var(--tf-blue); }

      .tf-disclaimer { background: var(--tf-yellow-bg); border: 1px solid var(--tf-yellow-border); border-radius: 12px; padding: 20px; margin-top: 24px; }
      .tf-disclaimer-label { display: flex; gap: 12px; font-size: 14px; line-height: 1.6; color: var(--tf-gray-700); cursor: pointer; }
      .tf-disclaimer-checkbox { margin-top: 2px; width: 20px; height: 20px; flex-shrink: 0; accent-color: var(--tf-blue); }

      .tf-error-msg { background: #fef2f2; border: 1px solid #fecaca; color: var(--tf-red); padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-top: 16px; }

      .tf-nav { display: flex; align-items: center; gap: 12px; padding: 16px 0; }
      .tf-nav-spacer { flex: 1; }
      .tf-nav-btn { padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all .2s; border: none; }
      .tf-nav-submit { background: var(--tf-green); color: #fff; padding: 14px 36px; }
      .tf-nav-submit:hover:not(:disabled) { background: #047857; }
      .tf-nav-submit:disabled { opacity: 0.5; cursor: not-allowed; }

      @media (max-width: 640px) {
        .tf-container { padding: 16px 12px 80px; }
        .tf-step-content { padding: 20px 16px; }
        .tf-hero h1 { font-size: 24px; }
        .tf-nav-btn { padding: 12px 20px; font-size: 15px; }
      }
    `}</style>
  )
}
