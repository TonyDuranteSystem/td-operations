'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import { LOGO_URL } from '@/lib/supabase/public-client'
import {
  LABELS,
  TOOLTIPS,
  STEPS,
  FORM_FIELDS,
  getFieldsForStep,
  type ITINSubmission,
  type FieldConfig,
  type LabelKey,
} from '@/lib/types/itin-form'

// --- Country List ---

const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
  'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
  'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Brazzaville)','Congo (DRC)',
  'Costa Rica','Croatia','Cuba','Cyprus','Czech Republic','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador',
  'Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France',
  'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
  'Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland',
  'Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo',
  'Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania',
  'Luxembourg','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius',
  'Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia',
  'Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway',
  'Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland',
  'Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines',
  'Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore',
  'Slovakia','Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan',
  'Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo',
  'Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom',
  'United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe',
]

// --- Cookie Helpers ---

const COOKIE_NAME = 'itin_verified'

function setVerifiedCookie(token: string) {
  document.cookie = `${COOKIE_NAME}_${token}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
}

// --- Date Helpers ---

function formatDateTime(d: string, lang: 'en' | 'it') {
  const date = new Date(d)
  const monthsEn = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const monthsIt = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']
  const months = lang === 'en' ? monthsEn : monthsIt
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${h}:${m}`
}

// --- Main Component ---

export default function ITINFormCodePage() {
  const { token, code } = useParams<{ token: string; code: string }>()
  const searchParams = useSearchParams()

  const [isAdmin, setIsAdmin] = useState(false)
  const [submission, setSubmission] = useState<ITINSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState<'en' | 'it'>('en')
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

  // --- Load Submission ---

  const loadSubmission = useCallback(async () => {
    try {
      const adminMode = searchParams.get('preview') === 'td'
      if (adminMode) {
        setIsAdmin(true)
      }

      const { data, error: err } = await supabasePublic
        .from('itin_submissions')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      // Validate access_code from URL path
      if (!adminMode && data.access_code !== code) {
        setError('invalid_link'); setLoading(false); return
      }

      const sub = data as ITINSubmission

      if (sub.status === 'completed' || sub.status === 'reviewed') {
        setSubmission(sub)
        setLang(sub.language || 'en')
        setSubmitted(true)
        setLoading(false)
        return
      }

      setSubmission(sub)
      setLang(sub.language || 'en')

      if (sub.prefilled_data) {
        setFormData({ ...sub.prefilled_data })
      }

      setLoading(false)

      // Set cookie and track open
      if (!adminMode) {
        setVerifiedCookie(token)
        trackOpen(sub)
      }
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, code, searchParams])

  function trackOpen(sub: ITINSubmission) {
    if (sub.status === 'pending' || sub.status === 'sent') {
      supabasePublic
        .from('itin_submissions')
        .update({
          opened_at: new Date().toISOString(),
          status: 'opened',
        })
        .eq('id', sub.id)
        .then(() => {})
    }
  }

  useEffect(() => {
    if (!token || !code) { setError('invalid_link'); setLoading(false); return }
    loadSubmission()
  }, [token, code, loadSubmission])

  useEffect(() => {
    if (submission) {
      document.title = lang === 'en'
        ? `ITIN Application - ${token}`
        : `Richiesta ITIN - ${token}`
      document.documentElement.lang = lang
    }
  }, [submission, lang, token])

  // --- Form Field Handling ---

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

  // --- Validation ---

  function isStepValid(step: number): boolean {
    if (step === 3) return true // documents step — validated separately
    const fields = getFieldsForStep(step)
    const required = fields.filter(f => f.required)
    return required.every(f => {
      // Skip previous_itin validation if has_previous_itin is No
      if (f.key === 'previous_itin') {
        return formData.has_previous_itin !== 'Yes' || (String(formData[f.key] || '').trim() !== '')
      }
      const val = formData[f.key]
      return val !== undefined && val !== null && String(val).trim() !== ''
    })
  }

  // --- Submit ---

  async function handleSubmit() {
    if (!submission || !disclaimerAccepted) return

    // Check passport upload
    if (!uploadFiles.passport_owner) {
      setSubmitError(lang === 'en' ? 'Passport scan is required.' : 'La scansione del passaporto e obbligatoria.')
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      // 1. Upload files to Supabase Storage
      const uploadPaths: string[] = []
      for (const [key, file] of Object.entries(uploadFiles)) {
        if (!file) continue
        const path = `${submission.token}/${key}_${file.name}`
        const { error: upErr } = await supabasePublic.storage
          .from('onboarding-uploads')
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
        .from('itin_submissions')
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

      // 5. Notify backend
      try {
        await fetch('/api/itin-form-completed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: submission.token }),
        })
      } catch {
        // Non-blocking — form is already saved
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

  // --- Render Field ---

  function renderField(field: FieldConfig) {
    const labelKey = field.key as LabelKey
    const label = L[labelKey] || field.key
    const value = formData[field.key] ?? ''
    const prefilled = isFieldPrefilled(field.key)
    const changed = isFieldChanged(field.key)
    const tooltip = TOOLTIPS[field.key]
    const hasTooltip = !!tooltip

    // Conditional: hide previous_itin if has_previous_itin is not Yes
    if (field.key === 'previous_itin' && formData.has_previous_itin !== 'Yes') {
      return null
    }

    return (
      <div key={field.key} className={`tf-field ${changed ? 'tf-field-changed' : ''} ${prefilled ? 'tf-field-prefilled' : ''}`}>
        <div className="tf-label-row">
          <label className="tf-label">
            {label}
            {field.required && field.key !== 'previous_itin' && <span className="tf-required">*</span>}
            {field.key === 'previous_itin' && formData.has_previous_itin === 'Yes' && <span className="tf-required">*</span>}
          </label>
          <div className="tf-badges">
            {prefilled && !changed && <span className="tf-badge tf-badge-prefilled">{L.prefilled}</span>}
            {changed && <span className="tf-badge tf-badge-changed">{L.changed}</span>}
            {hasTooltip && (
              <button
                type="button"
                className="tf-tooltip-btn"
                onClick={() => setActiveTooltip(activeTooltip === field.key ? null : field.key)}
                aria-label="Info"
              >
                &#8505;&#65039;
              </button>
            )}
          </div>
        </div>

        {activeTooltip === field.key && tooltip && (
          <div className="tf-tooltip-box">{tooltip[lang]}</div>
        )}

        {field.type === 'country' ? (
          <select
            className="tf-input"
            value={String(value)}
            onChange={e => updateField(field.key, e.target.value)}
          >
            <option value="">---</option>
            {COUNTRIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        ) : field.type === 'select' && field.options ? (
          <select
            className="tf-input"
            value={String(value)}
            onChange={e => updateField(field.key, e.target.value)}
          >
            <option value="">---</option>
            {field.options.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : 'text'}
            className="tf-input"
            value={String(value)}
            onChange={e => updateField(field.key, e.target.value)}
          />
        )}
      </div>
    )
  }

  // --- Render Step Content ---

  function renderStepContent(step: number) {
    if (!submission) return null

    if (step === 3) {
      // Documents & Review step
      const allFields = FORM_FIELDS.filter(f => f.step === 1 || f.step === 2)
      return (
        <div className="tf-step-content">
          <h2 className="tf-step-title">{L.step3Title}</h2>

          {/* Passport uploads */}
          <div className="tf-docs-section">
            <div className="tf-doc-item">
              <div>
                <span className="tf-doc-label">{L.passportUpload}</span>
                <span className="tf-doc-req"> *</span>
              </div>
              <div className="tf-doc-upload">
                {uploadFiles.passport_owner ? (
                  <span className="tf-doc-ok">{uploadFiles.passport_owner.name}</span>
                ) : (
                  <span className="tf-doc-missing">{L.uploadRequired}</span>
                )}
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setUploadFiles(prev => ({ ...prev, passport_owner: e.target.files?.[0] || null }))}
                />
              </div>
            </div>

            <div className="tf-doc-item">
              <div>
                <span className="tf-doc-label">{L.passportUpload2}</span>
              </div>
              <div className="tf-doc-upload">
                {uploadFiles.passport_owner_2 ? (
                  <span className="tf-doc-ok">{uploadFiles.passport_owner_2.name}</span>
                ) : (
                  <span className="tf-doc-optional">{lang === 'en' ? 'Optional' : 'Opzionale'}</span>
                )}
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setUploadFiles(prev => ({ ...prev, passport_owner_2: e.target.files?.[0] || null }))}
                />
              </div>
            </div>
          </div>

          {/* Data summary */}
          <div className="tf-review-summary">
            <h3>{lang === 'en' ? 'Summary' : 'Riepilogo'}</h3>
            <div className="tf-summary-grid">
              {allFields.map(f => {
                if (f.key === 'previous_itin' && formData.has_previous_itin !== 'Yes') return null
                const fieldLabel = L[f.key as LabelKey] || f.key
                const val = String(formData[f.key] || '---')
                return (
                  <div key={f.key}><strong>{fieldLabel}:</strong> {val}</div>
                )
              })}
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
    const fields = getFieldsForStep(step)
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

  // --- Render States ---

  if (loading) return (
    <>
      <ITINFormStyles />
      <div className="tf-loading">
        <div className="tf-loading-spinner" />
        <span>{L.loading}</span>
      </div>
    </>
  )

  if (error) return (
    <>
      <ITINFormStyles />
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
      <ITINFormStyles />
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

  // --- Main Form ---

  const visibleSteps = [1, 2, 3]
  const currentIdx = visibleSteps.indexOf(currentStep)
  const prevStep = currentIdx > 0 ? visibleSteps[currentIdx - 1] : null
  const nextStep = currentIdx >= 0 && currentIdx < visibleSteps.length - 1 ? visibleSteps[currentIdx + 1] : null
  const isLastStep = currentStep === visibleSteps[visibleSteps.length - 1]
  const isAdminPreview = searchParams.get('preview') === 'td'

  return (
    <>
      <ITINFormStyles />
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
        {(isAdmin || isAdminPreview) && (
          <div style={{ textAlign: 'center', marginBottom: -8 }}>
            <span style={{ display: 'inline-block', background: '#f59e0b', color: '#fff', padding: '3px 12px', borderRadius: 12, fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
              ADMIN PREVIEW
            </span>
          </div>
        )}

        {/* Hero */}
        <div className="tf-hero">
          <div className="tf-hero-label">IRS W-7</div>
          <h1>{L.title}</h1>
          <p className="tf-hero-sub">{L.subtitle}</p>
        </div>

        {/* Progress Bar */}
        <div className="tf-progress">
          {visibleSteps.map((step, idx) => (
            <div
              key={step}
              className={`tf-progress-step ${step === currentStep ? 'tf-progress-active' : ''} ${visibleSteps.indexOf(step) < visibleSteps.indexOf(currentStep) ? 'tf-progress-done' : ''}`}
              onClick={() => { if (visibleSteps.indexOf(step) < visibleSteps.indexOf(currentStep)) setCurrentStep(step) }}
            >
              <div className="tf-progress-num">{visibleSteps.indexOf(step) < visibleSteps.indexOf(currentStep) ? '\u2713' : idx + 1}</div>
              <div className="tf-progress-label">{STEPS[lang][step - 1]}</div>
            </div>
          ))}
          <div className="tf-progress-bar">
            <div className="tf-progress-bar-fill" style={{ width: `${(visibleSteps.indexOf(currentStep) / (visibleSteps.length - 1)) * 100}%` }} />
          </div>
        </div>

        {/* Step Content */}
        {renderStepContent(currentStep)}

        {/* Navigation */}
        <div className="tf-nav">
          {prevStep !== null && (
            <button className="tf-nav-btn tf-nav-back" onClick={() => setCurrentStep(prevStep)}>
              &larr; {L.back}
            </button>
          )}
          <div className="tf-nav-spacer" />
          {nextStep !== null && (
            <button
              className="tf-nav-btn tf-nav-next"
              onClick={() => setCurrentStep(nextStep)}
              disabled={!isStepValid(currentStep)}
            >
              {L.next} &rarr;
            </button>
          )}
          {isLastStep && (
            <button
              className="tf-nav-btn tf-nav-submit"
              onClick={handleSubmit}
              disabled={!disclaimerAccepted || submitting || !uploadFiles.passport_owner}
            >
              {submitting ? L.submitting : L.submit}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// --- Styles ---

function ITINFormStyles() {
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

      .tf-docs-section { margin-bottom: 24px; }
      .tf-doc-item { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: var(--tf-gray-100); border-radius: 8px; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
      .tf-doc-label { font-weight: 600; font-size: 14px; color: var(--tf-gray-700); }
      .tf-doc-req { color: var(--tf-red); font-weight: 700; }
      .tf-doc-ok { color: var(--tf-green); font-weight: 600; font-size: 14px; }
      .tf-doc-missing { color: var(--tf-yellow); font-weight: 500; font-size: 14px; }
      .tf-doc-optional { color: var(--tf-gray-500); font-weight: 400; font-size: 14px; }
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
