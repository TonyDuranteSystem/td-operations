'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import { LOGO_URL } from '@/lib/supabase/public-client'
import {
  LABELS,
  TOOLTIPS,
  STEPS,
  getFieldsForStep,
  type ClosureSubmission,
  type FieldConfig,
  type LabelKey,
} from '@/lib/types/closure-form'

// ─── Cookie Helpers ─────────────────────────────────────────

const COOKIE_NAME = 'closure_verified'

function setVerifiedCookie(token: string) {
  document.cookie = `${COOKIE_NAME}_${token}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
}

function hasVerifiedCookie(token: string): boolean {
  return document.cookie.includes(`${COOKIE_NAME}_${token}=1`)
}

// ─── Date Helpers ───────────────────────────────────────────

function formatDateTime(d: string, lang: 'en' | 'it') {
  const date = new Date(d)
  const monthsEn = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const monthsIt = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']
  const months = lang === 'en' ? monthsEn : monthsIt
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${h}:${m}`
}

// ─── Main Component ─────────────────────────────────────────

export default function ClosureFormCodePage() {
  const { token, code } = useParams<{ token: string; code: string }>()
  const searchParams = useSearchParams()

  const [isAdmin, setIsAdmin] = useState(false)
  const [submission, setSubmission] = useState<ClosureSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [verified, setVerified] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState(false)
  const [lang, setLang] = useState<'en' | 'it'>('it')
  const [currentStep, setCurrentStep] = useState(1)
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null)
  const [uploadFiles, setUploadFiles] = useState<Record<string, File | null>>({})

  const L = LABELS[lang]

  // ─── Load Submission ────────────────────────────────────

  const loadSubmission = useCallback(async () => {
    try {
      const adminMode = searchParams.get('preview') === 'td'
      if (adminMode) {
        setIsAdmin(true)
        setVerified(true)
      }

      const { data, error: err } = await supabasePublic
        .from('closure_submissions')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      // Validate access code from URL path
      if (!adminMode && data.access_code !== code) {
        setError('invalid_link'); setLoading(false); return
      }

      const sub = data as ClosureSubmission

      if (sub.status === 'completed' || sub.status === 'reviewed') {
        setSubmission(sub)
        setLang(sub.language || 'it')
        setSubmitted(true)
        setLoading(false)
        return
      }

      setSubmission(sub)
      setLang(sub.language || 'it')

      if (sub.prefilled_data) {
        setFormData({ ...sub.prefilled_data })
      }

      setLoading(false)

      // Access code validated — skip email gate, auto-verify
      if (!adminMode) {
        setVerified(true)
        setVerifiedCookie(token)
        trackOpen(sub)
      }
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, code, searchParams])

  function trackOpen(sub: ClosureSubmission) {
    if (sub.status === 'pending' || sub.status === 'sent') {
      supabasePublic
        .from('closure_submissions')
        .update({
          opened_at: new Date().toISOString(),
          status: 'opened',
        })
        .eq('id', sub.id)
        .then(() => {})
    }
  }

  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!submission) return
    const prefillEmail = (submission.prefilled_data?.owner_email as string) || ''
    if (emailInput.toLowerCase().trim() === prefillEmail.toLowerCase().trim()) {
      setVerified(true)
      setEmailError(false)
      setVerifiedCookie(token)
      trackOpen(submission)
    } else {
      setEmailError(true)
    }
  }

  useEffect(() => {
    if (!token) { setError('invalid_link'); setLoading(false); return }
    loadSubmission()
  }, [token, loadSubmission])

  useEffect(() => {
    if (submission) {
      document.title = lang === 'en'
        ? `Company Closure — ${token}`
        : `Chiusura Società — ${token}`
      document.documentElement.lang = lang
    }
  }, [submission, lang, token])

  // ─── Form Field Handling ────────────────────────────────

  function updateField(key: string, value: unknown) {
    setFormData(prev => ({ ...prev, [key]: value }))
    setTouchedFields(prev => new Set(prev).add(key))
  }

  function isFieldChanged(key: string): boolean {
    if (!submission?.prefilled_data) return false
    const prefilled = submission.prefilled_data[key]
    if (prefilled === undefined || prefilled === null || prefilled === '') return false
    return touchedFields.has(key) && String(formData[key] || '') !== String(prefilled)
  }

  function isFieldPrefilled(key: string): boolean {
    if (!submission?.prefilled_data) return false
    const val = submission.prefilled_data[key]
    return val !== undefined && val !== null && val !== ''
  }

  // ─── Validation ─────────────────────────────────────────

  function getRequiredFieldsForCurrentStep(step: number): FieldConfig[] {
    return getFieldsForStep(step).filter(f => f.required)
  }

  function isStepValid(step: number): boolean {
    // Step 2: conditional requirement — if tax_returns_filed is "yes", tax_returns_years is required
    const required = getRequiredFieldsForCurrentStep(step)
    const allRequiredFilled = required.every(f => {
      const val = formData[f.key]
      return val !== undefined && val !== null && String(val).trim() !== ''
    })
    if (step === 2 && formData.tax_returns_filed === 'yes') {
      const years = String(formData.tax_returns_years || '').trim()
      return allRequiredFilled && years !== ''
    }
    return allRequiredFilled
  }

  const totalSteps = 3

  // ─── Submit ─────────────────────────────────────────────

  async function handleSubmit() {
    if (!submission || !disclaimerAccepted) return
    setSubmitting(true)
    setSubmitError(null)

    try {
      // 1. Upload files
      const uploadPaths: string[] = []
      for (const [key, file] of Object.entries(uploadFiles)) {
        if (!file) continue
        const path = `${submission.token}/${key}_${file.name}`
        const { error: upErr } = await supabasePublic.storage
          .from('closure-uploads')
          .upload(path, file, { cacheControl: '3600', upsert: false })
        if (!upErr) uploadPaths.push(path)
      }

      // 2. Build submitted data
      const submittedData: Record<string, unknown> = { ...formData }

      // 3. Compute changed fields
      const changedFields: Record<string, { old: unknown; new: unknown }> = {}
      if (submission.prefilled_data) {
        for (const [key, newVal] of Object.entries(submittedData)) {
          const oldVal = submission.prefilled_data[key]
          if (oldVal !== undefined && oldVal !== null && oldVal !== '' && String(newVal) !== String(oldVal)) {
            changedFields[key] = { old: oldVal, new: newVal }
          }
        }
      }

      // 4. Update submission
      const { error: subErr } = await supabasePublic
        .from('closure_submissions')
        .update({
          submitted_data: submittedData,
          changed_fields: changedFields,
          upload_paths: uploadPaths,
          status: 'completed',
          completed_at: new Date().toISOString(),
          client_ip: '',
          client_user_agent: navigator.userAgent,
        })
        .eq('id', submission.id)

      if (subErr) throw new Error(subErr.message)

      setSubmitted(true)
      setSubmission(prev => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : null)
    } catch (err) {
      setSubmitError(L.errorSubmit)
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Render Field ───────────────────────────────────────

  function renderField(field: FieldConfig) {
    const labelKey = field.key as LabelKey
    const label = L[labelKey] || field.key
    const value = formData[field.key] ?? ''
    const prefilled = isFieldPrefilled(field.key)
    const changed = isFieldChanged(field.key)
    const tooltip = TOOLTIPS[field.key]
    const hasTooltip = !!tooltip

    // Special handling for tax_returns_filed — show as radio buttons
    if (field.key === 'tax_returns_filed') {
      return (
        <div key={field.key} className="tf-field">
          <div className="tf-label-row">
            <label className="tf-label">
              {label}
              {field.required && <span className="tf-required">*</span>}
            </label>
            {hasTooltip && (
              <button type="button" className="tf-tooltip-btn" onClick={() => setActiveTooltip(activeTooltip === field.key ? null : field.key)} aria-label="Info">&#8505;&#65039;</button>
            )}
          </div>
          {activeTooltip === field.key && tooltip && <div className="tf-tooltip-box">{tooltip[lang]}</div>}
          <div className="tf-radio-group">
            {['yes', 'no', 'not_sure'].map(opt => (
              <label key={opt} className="tf-radio-label">
                <input
                  type="radio"
                  name="tax_returns_filed"
                  value={opt}
                  checked={formData.tax_returns_filed === opt}
                  onChange={() => updateField('tax_returns_filed', opt)}
                  className="tf-radio"
                />
                {L[`tax_returns_filed_${opt}` as LabelKey] || opt}
              </label>
            ))}
          </div>
          {/* Conditional: show years input if "yes" */}
          {formData.tax_returns_filed === 'yes' && (
            <div className="tf-field" style={{ marginTop: 12 }}>
              <label className="tf-label">
                {L.tax_returns_years}
                <span className="tf-required">*</span>
              </label>
              {TOOLTIPS.tax_returns_years && (
                <div className="tf-tooltip-box" style={{ marginTop: 4, marginBottom: 4 }}>{TOOLTIPS.tax_returns_years[lang]}</div>
              )}
              <input
                type="text"
                className="tf-input"
                value={String(formData.tax_returns_years || '')}
                onChange={e => updateField('tax_returns_years', e.target.value)}
                placeholder={lang === 'en' ? '2024, 2025' : '2024, 2025'}
              />
            </div>
          )}
        </div>
      )
    }

    // Skip tax_returns_years here — rendered inline with tax_returns_filed
    if (field.key === 'tax_returns_years') return null

    return (
      <div key={field.key} className={`tf-field ${changed ? 'tf-field-changed' : ''} ${prefilled ? 'tf-field-prefilled' : ''}`}>
        <div className="tf-label-row">
          <label className="tf-label">
            {label}
            {field.required && <span className="tf-required">*</span>}
          </label>
          <div className="tf-badges">
            {prefilled && !changed && <span className="tf-badge tf-badge-prefilled">{L.prefilled}</span>}
            {changed && <span className="tf-badge tf-badge-changed">{L.changed}</span>}
            {hasTooltip && (
              <button type="button" className="tf-tooltip-btn" onClick={() => setActiveTooltip(activeTooltip === field.key ? null : field.key)} aria-label="Info">&#8505;&#65039;</button>
            )}
          </div>
        </div>

        {activeTooltip === field.key && tooltip && <div className="tf-tooltip-box">{tooltip[lang]}</div>}

        {field.type === 'textarea' ? (
          <textarea
            className="tf-input tf-textarea"
            value={String(value)}
            onChange={e => updateField(field.key, e.target.value)}
            rows={3}
          />
        ) : field.type === 'select' && field.options ? (
          <select
            className="tf-input"
            value={String(value)}
            onChange={e => updateField(field.key, e.target.value)}
          >
            <option value="">—</option>
            {field.options.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
            className="tf-input"
            value={String(value)}
            onChange={e => updateField(field.key, field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          />
        )}
      </div>
    )
  }

  // ─── Render Step Content ────────────────────────────────

  function renderStepContent(step: number) {
    if (!submission) return null
    const fields = getFieldsForStep(step)

    if (step === 3) {
      // Documents & Review step
      return (
        <div className="tf-step-content">
          <h2 className="tf-step-title">{L.step3Title}</h2>

          {/* Optional document uploads */}
          <div className="tf-docs-section">
            <div className="tf-doc-item">
              <span>{L.uploadArticles}</span>
              <div className="tf-doc-upload">
                <span className="tf-doc-optional">{L.uploadOptional}</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setUploadFiles(prev => ({ ...prev, articles_of_org: e.target.files?.[0] || null }))} />
              </div>
            </div>
            <div className="tf-doc-item">
              <span>{L.uploadEinLetter}</span>
              <div className="tf-doc-upload">
                <span className="tf-doc-optional">{L.uploadOptional}</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setUploadFiles(prev => ({ ...prev, ein_letter: e.target.files?.[0] || null }))} />
              </div>
            </div>
            <div className="tf-doc-item">
              <span>{L.uploadOther}</span>
              <div className="tf-doc-upload">
                <span className="tf-doc-optional">{L.uploadOptional}</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={e => setUploadFiles(prev => ({ ...prev, other_doc: e.target.files?.[0] || null }))} />
              </div>
            </div>
          </div>

          {/* Data summary */}
          <div className="tf-review-summary">
            <h3>{lang === 'en' ? 'Summary' : 'Riepilogo'}</h3>
            <div className="tf-summary-grid">
              <div><strong>{L.owner_first_name}:</strong> {String(formData.owner_first_name || '\u2014')}</div>
              <div><strong>{L.owner_last_name}:</strong> {String(formData.owner_last_name || '\u2014')}</div>
              <div><strong>{L.owner_email}:</strong> {String(formData.owner_email || '\u2014')}</div>
              <div><strong>{L.owner_phone}:</strong> {String(formData.owner_phone || '\u2014')}</div>
              <div><strong>{L.llc_name}:</strong> {String(formData.llc_name || '\u2014')}</div>
              <div><strong>{L.llc_ein}:</strong> {String(formData.llc_ein || '\u2014')}</div>
              <div><strong>{L.llc_state}:</strong> {String(formData.llc_state || '\u2014')}</div>
              <div><strong>{L.llc_formation_year}:</strong> {String(formData.llc_formation_year || '\u2014')}</div>
              <div><strong>{L.registered_agent}:</strong> {String(formData.registered_agent || '\u2014')}</div>
              <div><strong>{L.tax_returns_filed}:</strong> {L[`tax_returns_filed_${formData.tax_returns_filed}` as LabelKey] || String(formData.tax_returns_filed || '\u2014')}</div>
              {formData.tax_returns_filed === 'yes' && (
                <div><strong>{L.tax_returns_years}:</strong> {String(formData.tax_returns_years || '\u2014')}</div>
              )}
            </div>
          </div>

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
      )
    }

    // Steps 1-2: render fields
    const stepTitle = step === 1 ? L.step1Title : L.step2Title

    return (
      <div className="tf-step-content">
        <h2 className="tf-step-title">{stepTitle}</h2>
        <div className="tf-fields-grid">
          {fields.map(f => renderField(f))}
        </div>
      </div>
    )
  }

  // ─── Render States ──────────────────────────────────────

  if (loading) return (
    <>
      <ClosureFormStyles />
      <div className="tf-loading">
        <div className="tf-loading-spinner" />
        <span>{L.loading}</span>
      </div>
    </>
  )

  if (error) return (
    <>
      <ClosureFormStyles />
      <div className="tf-error-page">
        <div>
          <h1>{L.notFound}</h1>
          <p>{L.notFoundMessage}</p>
        </div>
      </div>
    </>
  )

  if (!submission) return null

  // Already submitted
  if (submitted) return (
    <>
      <ClosureFormStyles />
      <div className="tf-success-page">
        <div className="tf-success-box">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Tony Durante LLC" className="tf-logo" />
          <div className="tf-success-icon">&#9989;</div>
          <h1>{L.successTitle}</h1>
          <p>{L.successMessage}</p>
          {submission.completed_at && (
            <p className="tf-success-ts">{L.successTimestamp}: {formatDateTime(submission.completed_at, lang)}</p>
          )}
        </div>
      </div>
    </>
  )

  // Email verification gate (kept as fallback, but normally skipped via access_code)
  const isAdminPreview = searchParams.get('preview') === 'td'
  if (!verified && !isAdminPreview && submission.prefilled_data?.owner_email) {
    return (
      <>
        <ClosureFormStyles />
        <div className="tf-gate">
          <div className="tf-gate-box">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_URL} alt="Tony Durante LLC" className="tf-logo" />
            <h2>{L.emailGateTitle}</h2>
            <p>{L.emailGateMessage}</p>
            <form onSubmit={handleEmailVerify}>
              <input
                type="email"
                value={emailInput}
                onChange={e => { setEmailInput(e.target.value); setEmailError(false) }}
                placeholder={L.emailPlaceholder}
                className={`tf-gate-input${emailError ? ' tf-gate-input-error' : ''}`}
                required
                autoFocus
              />
              {emailError && <div className="tf-gate-error-msg">{L.emailGateError}</div>}
              <button type="submit" className="tf-gate-btn">{L.emailGateButton}</button>
            </form>
          </div>
        </div>
      </>
    )
  }

  // ─── Main Form ──────────────────────────────────────────

  return (
    <>
      <ClosureFormStyles />
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
          <div className="tf-hero-label">{lang === 'en' ? 'LLC Dissolution' : 'Dissoluzione LLC'}</div>
          <h1>{L.title}</h1>
          <p className="tf-hero-sub">{L.subtitle}</p>
        </div>

        {/* Progress Bar */}
        <div className="tf-progress">
          {[1, 2, 3].map((step, idx) => (
            <div
              key={step}
              className={`tf-progress-step ${step === currentStep ? 'tf-progress-active' : ''} ${step < currentStep ? 'tf-progress-done' : ''}`}
              onClick={() => { if (step < currentStep) setCurrentStep(step) }}
            >
              <div className="tf-progress-num">{step < currentStep ? '\u2713' : idx + 1}</div>
              <div className="tf-progress-label">{STEPS[lang][step - 1]}</div>
            </div>
          ))}
          <div className="tf-progress-bar">
            <div className="tf-progress-bar-fill" style={{ width: `${((currentStep - 1) / (totalSteps - 1)) * 100}%` }} />
          </div>
        </div>

        {/* Step Content */}
        {renderStepContent(currentStep)}

        {/* Navigation */}
        <div className="tf-nav">
          {currentStep > 1 && (
            <button className="tf-nav-btn tf-nav-back" onClick={() => setCurrentStep(currentStep - 1)}>
              &larr; {L.back}
            </button>
          )}
          <div className="tf-nav-spacer" />
          {currentStep < totalSteps && (
            <button
              className="tf-nav-btn tf-nav-next"
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!isStepValid(currentStep)}
            >
              {L.next} &rarr;
            </button>
          )}
          {currentStep === totalSteps && (
            <button
              className="tf-nav-btn tf-nav-submit"
              onClick={handleSubmit}
              disabled={!disclaimerAccepted || submitting}
            >
              {submitting ? L.submitting : L.submit}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Styles ─────────────────────────────────────────────────

function ClosureFormStyles() {
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

      .tf-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .tf-gate-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 440px; width: 100%; }
      .tf-gate-box h2 { font-family: 'Playfair Display', serif; font-size: 24px; color: var(--tf-blue); margin-bottom: 8px; }
      .tf-gate-box p { font-size: 15px; color: var(--tf-gray-500); margin-bottom: 24px; line-height: 1.6; }
      .tf-gate-input { width: 100%; padding: 14px 16px; border: 2px solid var(--tf-gray-200); border-radius: 8px; font-size: 16px; outline: none; transition: border-color .2s; box-sizing: border-box; }
      .tf-gate-input:focus { border-color: var(--tf-blue); }
      .tf-gate-input-error { border-color: var(--tf-red) !important; }
      .tf-gate-error-msg { color: var(--tf-red); font-size: 14px; margin-top: 8px; }
      .tf-gate-btn { display: block; width: 100%; margin-top: 16px; padding: 14px; background: var(--tf-blue); color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background .2s; }
      .tf-gate-btn:hover { background: #162d4a; }

      .tf-success-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .tf-success-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 520px; width: 100%; }
      .tf-success-icon { font-size: 48px; margin-bottom: 16px; }
      .tf-success-box h1 { font-family: 'Playfair Display', serif; font-size: 28px; color: var(--tf-green); margin-bottom: 12px; }
      .tf-success-box p { font-size: 16px; color: var(--tf-gray-500); line-height: 1.6; }
      .tf-success-ts { font-size: 14px; color: var(--tf-gray-500); margin-top: 16px; }

      .tf-logo { height: 44px; display: block; }
      .tf-container { max-width: 720px; margin: 0 auto; padding: 24px 16px 80px; }
      .tf-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
      .tf-lang-toggle { display: flex; gap: 4px; }
      .tf-lang-btn { padding: 6px 14px; border: 2px solid var(--tf-gray-200); border-radius: 6px; background: #fff; font-size: 14px; font-weight: 600; cursor: pointer; color: var(--tf-gray-500); transition: all .2s; }
      .tf-lang-active { border-color: var(--tf-blue); color: var(--tf-blue); background: var(--tf-blue-lighter); }

      .tf-hero { text-align: center; padding: 32px 0 24px; }
      .tf-hero-label { display: inline-block; background: var(--tf-blue-light); color: var(--tf-blue); padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 12px; }
      .tf-hero h1 { font-family: 'Playfair Display', serif; font-size: 32px; color: var(--tf-blue); margin: 0 0 8px; }
      .tf-hero-sub { font-size: 16px; color: var(--tf-gray-500); }

      .tf-progress { display: flex; align-items: flex-start; gap: 0; margin-bottom: 32px; position: relative; padding: 0 8px; }
      .tf-progress-step { flex: 1; display: flex; flex-direction: column; align-items: center; position: relative; z-index: 1; cursor: default; }
      .tf-progress-done { cursor: pointer; }
      .tf-progress-num { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; background: var(--tf-gray-200); color: var(--tf-gray-500); transition: all .3s; margin-bottom: 6px; }
      .tf-progress-active .tf-progress-num { background: var(--tf-blue); color: #fff; }
      .tf-progress-done .tf-progress-num { background: var(--tf-green); color: #fff; }
      .tf-progress-label { font-size: 11px; color: var(--tf-gray-500); text-align: center; max-width: 100px; line-height: 1.3; }
      .tf-progress-active .tf-progress-label { color: var(--tf-blue); font-weight: 600; }
      .tf-progress-bar { position: absolute; top: 18px; left: 60px; right: 60px; height: 3px; background: var(--tf-gray-200); z-index: 0; border-radius: 2px; }
      .tf-progress-bar-fill { height: 100%; background: var(--tf-green); border-radius: 2px; transition: width .3s; }

      .tf-step-content { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.06); padding: 32px; margin-bottom: 16px; }
      .tf-step-title { font-family: 'Playfair Display', serif; font-size: 24px; color: var(--tf-blue); margin: 0 0 24px; }

      .tf-fields-grid { display: flex; flex-direction: column; gap: 20px; }
      .tf-field { position: relative; }
      .tf-field-prefilled { border-left: 3px solid var(--tf-blue-light); padding-left: 12px; }
      .tf-field-changed { border-left: 3px solid var(--tf-yellow); padding-left: 12px; background: var(--tf-yellow-bg); border-radius: 6px; padding: 8px 12px; }
      .tf-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .tf-label { font-size: 14px; font-weight: 600; color: var(--tf-gray-700); }
      .tf-required { color: var(--tf-red); margin-left: 4px; }
      .tf-badges { display: flex; align-items: center; gap: 6px; }
      .tf-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
      .tf-badge-prefilled { background: var(--tf-blue-light); color: var(--tf-blue); }
      .tf-badge-changed { background: var(--tf-yellow-bg); color: #92400e; border: 1px solid var(--tf-yellow-border); }

      .tf-tooltip-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 0 2px; line-height: 1; }
      .tf-tooltip-box { background: var(--tf-blue-lighter); border: 1px solid #c9d8ea; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; font-size: 13px; color: var(--tf-blue); line-height: 1.5; }

      .tf-input { width: 100%; padding: 12px 14px; border: 2px solid var(--tf-gray-200); border-radius: 8px; font-size: 15px; font-family: inherit; outline: none; transition: border-color .2s; box-sizing: border-box; background: #fff; }
      .tf-input:focus { border-color: var(--tf-blue); }
      .tf-textarea { resize: vertical; min-height: 80px; }

      .tf-radio-group { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 4px; }
      .tf-radio-label { display: flex; align-items: center; gap: 6px; font-size: 15px; cursor: pointer; color: var(--tf-gray-700); }
      .tf-radio { accent-color: var(--tf-blue); width: 18px; height: 18px; }

      .tf-docs-section { margin-bottom: 24px; }
      .tf-doc-item { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: var(--tf-gray-100); border-radius: 8px; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
      .tf-doc-optional { color: var(--tf-gray-500); font-weight: 500; font-size: 14px; font-style: italic; }
      .tf-doc-upload { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
      .tf-doc-upload input[type="file"] { font-size: 13px; }

      .tf-review-summary { background: var(--tf-blue-lighter); border: 1px solid #c9d8ea; border-radius: 12px; padding: 20px; margin: 24px 0; }
      .tf-review-summary h3 { font-size: 16px; color: var(--tf-blue); margin: 0 0 12px; }
      .tf-summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 14px; }
      .tf-summary-grid div { color: var(--tf-gray-700); }
      .tf-summary-grid strong { color: var(--tf-blue); }

      .tf-disclaimer { background: var(--tf-yellow-bg); border: 1px solid var(--tf-yellow-border); border-radius: 12px; padding: 20px; margin-top: 24px; }
      .tf-disclaimer-label { display: flex; gap: 12px; font-size: 14px; line-height: 1.6; color: var(--tf-gray-700); cursor: pointer; }
      .tf-disclaimer-checkbox { margin-top: 2px; width: 20px; height: 20px; flex-shrink: 0; accent-color: var(--tf-blue); }

      .tf-error-msg { background: #fef2f2; border: 1px solid #fecaca; color: var(--tf-red); padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-top: 16px; }

      .tf-nav { display: flex; align-items: center; gap: 12px; padding: 16px 0; }
      .tf-nav-spacer { flex: 1; }
      .tf-nav-btn { padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all .2s; border: none; }
      .tf-nav-back { background: var(--tf-gray-100); color: var(--tf-gray-700); border: 2px solid var(--tf-gray-200); }
      .tf-nav-back:hover { background: var(--tf-gray-200); }
      .tf-nav-next { background: var(--tf-blue); color: #fff; }
      .tf-nav-next:hover:not(:disabled) { background: #162d4a; }
      .tf-nav-next:disabled { opacity: 0.5; cursor: not-allowed; }
      .tf-nav-submit { background: var(--tf-green); color: #fff; padding: 14px 36px; }
      .tf-nav-submit:hover:not(:disabled) { background: #047857; }
      .tf-nav-submit:disabled { opacity: 0.5; cursor: not-allowed; }

      @media (max-width: 640px) {
        .tf-container { padding: 16px 12px 80px; }
        .tf-step-content { padding: 20px 16px; }
        .tf-hero h1 { font-size: 24px; }
        .tf-progress-label { font-size: 10px; }
        .tf-progress-num { width: 30px; height: 30px; font-size: 12px; }
        .tf-progress-bar { left: 40px; right: 40px; top: 15px; }
        .tf-nav-btn { padding: 12px 20px; font-size: 15px; }
        .tf-doc-item { flex-direction: column; align-items: flex-start; }
        .tf-doc-upload { align-items: flex-start; }
        .tf-summary-grid { grid-template-columns: 1fr; }
      }
    `}</style>
  )
}
