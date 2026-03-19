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
  type FormationSubmission,
  type FieldConfig,
  type LabelKey,
} from '@/lib/types/formation-form'

// ─── Cookie Helpers ─────────────────────────────────────────

const COOKIE_NAME = 'formation_verified'

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

export default function FormationFormPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params.token as string

  const [isAdmin, setIsAdmin] = useState(false)
  const [submission, setSubmission] = useState<FormationSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [verified, setVerified] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState(false)
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

  // Dynamic arrays for MMLLC additional members
  const [members, setMembers] = useState<Record<string, string>[]>([])

  const L = LABELS[lang]

  // ─── Load Submission ────────────────────────────────────

  const loadSubmission = useCallback(async () => {
    try {
      // Admin preview bypass
      const adminMode = searchParams.get('preview') === 'td'
      if (adminMode) {
        setIsAdmin(true)
        setVerified(true)
      }

      const { data, error: err } = await supabasePublic
        .from('formation_submissions')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      const sub = data as FormationSubmission

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

      if (adminMode) return

      if (hasVerifiedCookie(token)) {
        setVerified(true)
      }

      if (hasVerifiedCookie(token) || !sub.prefilled_data?.owner_email) {
        trackOpen(sub)
      }
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, searchParams])

  function trackOpen(sub: FormationSubmission) {
    if (sub.status === 'pending' || sub.status === 'sent') {
      supabasePublic
        .from('formation_submissions')
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
        ? `LLC Formation — ${token}`
        : `Costituzione LLC — ${token}`
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

  function getRequiredFieldsForStep(step: number): FieldConfig[] {
    if (!submission) return []
    return getFieldsForStep(submission.entity_type, step).filter(f => f.required && !f.isArray)
  }

  function isStepValid(step: number): boolean {
    if (step === 3 && submission?.entity_type === 'SMLLC') return true // skip step 3 for SMLLC
    const required = getRequiredFieldsForStep(step)
    return required.every(f => {
      const val = formData[f.key]
      return val !== undefined && val !== null && String(val).trim() !== ''
    })
  }

  // Determine visible steps based on entity type
  function getVisibleSteps(): number[] {
    if (!submission) return [1, 2, 3, 4]
    if (submission.entity_type === 'SMLLC') return [1, 2, 4] // skip step 3
    return [1, 2, 3, 4]
  }

  function getNextStep(current: number): number | null {
    const steps = getVisibleSteps()
    const idx = steps.indexOf(current)
    return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null
  }

  function getPrevStep(current: number): number | null {
    const steps = getVisibleSteps()
    const idx = steps.indexOf(current)
    return idx > 0 ? steps[idx - 1] : null
  }

  function isLastStep(current: number): boolean {
    const steps = getVisibleSteps()
    return current === steps[steps.length - 1]
  }

  // ─── Submit ─────────────────────────────────────────────

  async function handleSubmit() {
    if (!submission || !disclaimerAccepted) return

    // Validate passport upload is mandatory
    if (!uploadFiles.passport_owner) {
      setSubmitError(lang === 'it' ? 'Il passaporto del titolare è obbligatorio. Carica una copia del passaporto per procedere.' : 'Owner passport is required. Please upload a copy of your passport to proceed.')
      return
    }

    // For MMLLC, validate all member passports
    if (submission.entity_type === 'MMLLC' && members.length > 0) {
      for (let i = 0; i < members.length; i++) {
        if (!uploadFiles[`passport_member_${i}`]) {
          setSubmitError(lang === 'it' ? `Il passaporto del membro ${members[i].member_first_name || ''} ${members[i].member_last_name || ''} è obbligatorio.` : `Passport for member ${members[i].member_first_name || ''} ${members[i].member_last_name || ''} is required.`)
          return
        }
      }
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      // 1. Upload files
      const uploadPaths: string[] = []
      const uploadErrors: string[] = []
      for (const [key, file] of Object.entries(uploadFiles)) {
        if (!file) continue
        const path = `${submission.token}/${key}_${file.name}`
        const { error: upErr } = await supabasePublic.storage
          .from('formation-uploads')
          .upload(path, file, { cacheControl: '3600', upsert: false })
        if (upErr) {
          console.error(`Upload failed for ${key}:`, upErr.message)
          uploadErrors.push(`${file.name}: ${upErr.message}`)
        } else {
          uploadPaths.push(path)
        }
      }
      // Block submission if passport upload failed
      if (uploadErrors.length > 0 && uploadPaths.length === 0) {
        setSubmitError(lang === 'it' ? `Errore nel caricamento dei file: ${uploadErrors.join(', ')}. Riprova.` : `File upload failed: ${uploadErrors.join(', ')}. Please try again.`)
        setSubmitting(false)
        return
      }

      // 2. Build submitted data
      const submittedData: Record<string, unknown> = { ...formData }
      if (members.length > 0) submittedData.additional_members = members

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
        .from('formation_submissions')
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

      // Trigger auto-chain (non-blocking)
      try {
        await fetch('/api/formation-form-completed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submission_id: submission.id, token: submission.token }),
        })
      } catch { /* non-blocking */ }

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
    if (field.isArray) return null

    const labelKey = field.key as LabelKey
    const label = L[labelKey] || field.key
    const value = formData[field.key] ?? ''
    const prefilled = isFieldPrefilled(field.key)
    const changed = isFieldChanged(field.key)
    const tooltip = TOOLTIPS[field.key]
    const hasTooltip = !!tooltip

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

  // ─── Render Members (MMLLC) ─────────────────────────────

  function renderMembers() {
    if (!submission || submission.entity_type !== 'MMLLC') return null
    return (
      <div className="tf-array-section">
        <div className="tf-array-header">
          <h3>{L.additional_members}</h3>
          <button type="button" className="tf-add-btn" onClick={() => setMembers(prev => [...prev, {}])}>
            {L.addMember}
          </button>
        </div>
        {members.length === 0 && (
          <p className="tf-empty-msg">{L.step3Empty}</p>
        )}
        {members.map((member, i) => (
          <div key={i} className="tf-array-item">
            <div className="tf-array-item-header">
              <span>#{i + 1}</span>
              <button type="button" className="tf-remove-btn" onClick={() => setMembers(prev => prev.filter((_, j) => j !== i))}>
                {L.removeMember}
              </button>
            </div>
            <div className="tf-array-fields">
              <input className="tf-input" placeholder={L.member_first_name} value={member.member_first_name || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_first_name: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_last_name} value={member.member_last_name || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_last_name: e.target.value }; setMembers(m) }} />
              <input className="tf-input" type="email" placeholder={L.member_email} value={member.member_email || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_email: e.target.value }; setMembers(m) }} />
              <input className="tf-input tf-input-sm" type="number" placeholder={L.member_ownership_pct} value={member.member_ownership_pct || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_ownership_pct: e.target.value }; setMembers(m) }} />
              <input className="tf-input" type="date" placeholder={L.member_dob} value={member.member_dob || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_dob: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_nationality} value={member.member_nationality || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_nationality: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_street} value={member.member_street || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_street: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_city} value={member.member_city || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_city: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_zip} value={member.member_zip || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_zip: e.target.value }; setMembers(m) }} />
              <input className="tf-input" placeholder={L.member_country} value={member.member_country || ''} onChange={e => { const m = [...members]; m[i] = { ...m[i], member_country: e.target.value }; setMembers(m) }} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ─── Render Step Content ────────────────────────────────

  function renderStepContent(step: number) {
    if (!submission) return null
    const fields = getFieldsForStep(submission.entity_type, step)

    if (step === 4) {
      // Documents & Review step
      return (
        <div className="tf-step-content">
          <h2 className="tf-step-title">{L.step4Title}</h2>

          {/* Passport upload */}
          <div className="tf-docs-section">
            <div className="tf-doc-item">
              <span>{L.passportUpload} <span style={{color:'#dc2626'}}>*</span></span>
              <div className="tf-doc-upload">
                <span className="tf-doc-missing" style={{color: uploadFiles.passport_owner ? '#16a34a' : '#dc2626'}}>{uploadFiles.passport_owner ? (lang === 'it' ? 'Caricato' : 'Uploaded') : (lang === 'it' ? 'Obbligatorio' : 'Required')}</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setUploadFiles(prev => ({ ...prev, passport_owner: e.target.files?.[0] || null }))}
                />
              </div>
            </div>

            {/* Member passport uploads for MMLLC */}
            {submission.entity_type === 'MMLLC' && members.map((m, i) => (
              <div key={`passport_member_${i}`} className="tf-doc-item">
                <span>{L.passportMemberUpload}: {m.member_first_name || ''} {m.member_last_name || ''}</span>
                <div className="tf-doc-upload">
                  <span className="tf-doc-missing">{L.uploadRequired}</span>
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={e => setUploadFiles(prev => ({ ...prev, [`passport_member_${i}`]: e.target.files?.[0] || null }))}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Data summary */}
          <div className="tf-review-summary">
            <h3>{lang === 'en' ? 'Summary' : 'Riepilogo'}</h3>
            <div className="tf-summary-grid">
              <div><strong>{L.owner_first_name}:</strong> {String(formData.owner_first_name || '—')}</div>
              <div><strong>{L.owner_last_name}:</strong> {String(formData.owner_last_name || '—')}</div>
              <div><strong>{L.owner_email}:</strong> {String(formData.owner_email || '—')}</div>
              <div><strong>{L.owner_phone}:</strong> {String(formData.owner_phone || '—')}</div>
              <div><strong>{L.owner_dob}:</strong> {String(formData.owner_dob || '—')}</div>
              <div><strong>{L.owner_nationality}:</strong> {String(formData.owner_nationality || '—')}</div>
              <div><strong>{L.owner_country}:</strong> {String(formData.owner_country || '—')}</div>
              <div><strong>{L.llc_name_1}:</strong> {String(formData.llc_name_1 || '—')}</div>
              <div><strong>{L.llc_name_2}:</strong> {String(formData.llc_name_2 || '—')}</div>
              <div><strong>{L.llc_name_3}:</strong> {String(formData.llc_name_3 || '—')}</div>
              <div><strong>{lang === 'en' ? 'Entity Type' : 'Tipo'}:</strong> {submission.entity_type}</div>
              <div><strong>{lang === 'en' ? 'State' : 'Stato'}:</strong> {submission.state}</div>
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

    if (step === 3) {
      // Additional Members step (MMLLC only)
      return (
        <div className="tf-step-content">
          <h2 className="tf-step-title">{L.step3Title}</h2>
          {renderMembers()}
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
      <FormationFormStyles />
      <div className="tf-loading">
        <div className="tf-loading-spinner" />
        <span>{L.loading}</span>
      </div>
    </>
  )

  if (error) return (
    <>
      <FormationFormStyles />
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
      <FormationFormStyles />
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

  // Email verification gate (admin preview bypasses synchronously)
  const isAdminPreview = searchParams.get('preview') === 'td'
  if (!verified && !isAdminPreview && submission.prefilled_data?.owner_email) {
    return (
      <>
        <FormationFormStyles />
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

  const visibleSteps = getVisibleSteps()
  const prevStep = getPrevStep(currentStep)
  const nextStep = getNextStep(currentStep)

  return (
    <>
      <FormationFormStyles />
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
          <div className="tf-hero-label">{submission.entity_type} — {submission.state}</div>
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
          {isLastStep(currentStep) && (
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

function FormationFormStyles() {
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
      .tf-input-sm { max-width: 120px; }

      .tf-empty-msg { font-size: 15px; color: var(--tf-gray-500); font-style: italic; }

      .tf-array-section { margin-top: 12px; }
      .tf-array-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
      .tf-array-header h3 { font-size: 16px; color: var(--tf-gray-700); margin: 0; flex: 1; }
      .tf-add-btn { padding: 8px 16px; background: var(--tf-blue-lighter); color: var(--tf-blue); border: 1px solid #c9d8ea; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
      .tf-add-btn:hover { background: var(--tf-blue-light); }
      .tf-array-item { background: var(--tf-gray-100); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
      .tf-array-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-weight: 600; font-size: 14px; color: var(--tf-gray-500); }
      .tf-remove-btn { padding: 4px 12px; border: 1px solid var(--tf-gray-300); border-radius: 6px; background: #fff; color: var(--tf-red); font-size: 13px; cursor: pointer; }
      .tf-remove-btn:hover { background: #fef2f2; }
      .tf-array-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

      .tf-docs-section { margin-bottom: 24px; }
      .tf-doc-item { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: var(--tf-gray-100); border-radius: 8px; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
      .tf-doc-ok { color: var(--tf-green); font-weight: 600; font-size: 14px; }
      .tf-doc-missing { color: var(--tf-yellow); font-weight: 500; font-size: 14px; }
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
        .tf-array-fields { grid-template-columns: 1fr; }
        .tf-nav-btn { padding: 12px 20px; font-size: 15px; }
        .tf-doc-item { flex-direction: column; align-items: flex-start; }
        .tf-doc-upload { align-items: flex-start; }
        .tf-summary-grid { grid-template-columns: 1fr; }
      }
    `}</style>
  )
}
