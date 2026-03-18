'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import { LOGO_URL } from '@/lib/supabase/public-client'
import { LABELS, type ITINSubmission } from '@/lib/types/itin-form'

// --- Cookie Helpers ---

const COOKIE_NAME = 'itin_verified'

function setVerifiedCookie(token: string) {
  document.cookie = `${COOKIE_NAME}_${token}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
}

function hasVerifiedCookie(token: string): boolean {
  return document.cookie.includes(`${COOKIE_NAME}_${token}=1`)
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

export default function ITINFormGatePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = params.token as string

  const [submission, setSubmission] = useState<ITINSubmission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState(false)
  const [lang, setLang] = useState<'en' | 'it'>('en')

  const L = LABELS[lang]

  const loadSubmission = useCallback(async () => {
    try {
      // Admin preview bypass — redirect to [code] route
      const adminMode = searchParams.get('preview') === 'td'

      const { data, error: err } = await supabasePublic
        .from('itin_submissions')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      const sub = data as ITINSubmission
      setSubmission(sub)
      setLang(sub.language || 'en')

      if (adminMode) {
        // Redirect to [code] route with preview param
        router.replace(`/itin-form/${token}/${sub.access_code || 'preview'}?preview=td`)
        return
      }

      // If cookie is set, redirect to [code] route
      if (hasVerifiedCookie(token) && sub.access_code) {
        router.replace(`/itin-form/${token}/${sub.access_code}`)
        return
      }

      setLoading(false)
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, searchParams, router])

  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!submission) return
    const prefillEmail = (submission.prefilled_data?.email as string) || ''
    if (emailInput.toLowerCase().trim() === prefillEmail.toLowerCase().trim()) {
      setEmailError(false)
      setVerifiedCookie(token)
      // Redirect to [code] route
      if (submission.access_code) {
        router.replace(`/itin-form/${token}/${submission.access_code}`)
      }
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
        ? `ITIN Application - ${token}`
        : `Richiesta ITIN - ${token}`
      document.documentElement.lang = lang
    }
  }, [submission, lang, token])

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
  if (submission.status === 'completed' || submission.status === 'reviewed') {
    return (
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
  }

  // Email verification gate
  return (
    <>
      <ITINFormStyles />
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

      .tf-logo { height: 44px; display: block; margin: 0 auto 24px; }

      @media (max-width: 640px) {
        .tf-gate-box { padding: 32px 20px; }
        .tf-success-box { padding: 32px 20px; }
      }
    `}</style>
  )
}
