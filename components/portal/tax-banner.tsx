'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, CheckCircle, Clock, Pencil, Loader2 } from 'lucide-react'
import type { ReviewStatus } from '@/lib/tax/review-status'
import { flowStageBannerState } from '@/lib/tax/flow-banner'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'

interface TaxBannerProps {
  taxYear: number
  returnType: string | null
  /** New: fine-grained review sub-state from tax_return_submissions.review_status */
  reviewStatus?: ReviewStatus | null
  /** New: submission id for the Confirm action */
  submissionId?: string | null
  /** Whether the client has already clicked Confirm on their P&L + Balance
   *  Sheet — decides whether the submitted/resubmitted banner asks them to
   *  finish, or tells them they're done. */
  confirmationAccepted?: boolean | null
  /** Legacy fallback for pre-Slice-2 submissions */
  dataReceived?: boolean
  sentToAccountant?: boolean
  /** MMLLC/Corp financials flow (Slice 9): link to the generated P&L + BS review screen. */
  showFinancialsLink?: boolean
  /** Flow-workspace SD stage (e.g. "Sent for Signature"). Drives the banner
   *  when there is no review_status — see lib/tax/flow-banner.ts. */
  sdStage?: string | null
}

const editHref = '/portal/wizard?type=tax'
const signHref = '/portal/sign'

function EditButton({ cta }: { cta: string }) {
  return (
    <a
      href={editHref}
      className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
    >
      <Pencil className="h-3.5 w-3.5" />
      {cta}
    </a>
  )
}

function ConfirmButton({
  submissionId,
  onConfirmed,
}: {
  submissionId: string
  onConfirmed: () => void
}) {
  const { t } = useLocale()
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  async function handleConfirm() {
    setState('loading')
    setErrMsg(null)
    try {
      const res = await fetch('/api/portal/tax-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error || t('taxBanner.errorRetry'))
      }
      onConfirmed()
    } catch (err) {
      setErrMsg(err instanceof Error && err.message ? err.message : t('taxBanner.errorRetry'))
      setState('idle')
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleConfirm}
        disabled={state === 'loading'}
        className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {state === 'loading' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCircle className="h-3.5 w-3.5" />
        )}
        {t('taxBanner.confirm')}
      </button>
      {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
    </div>
  )
}

export function TaxBanner({
  taxYear,
  returnType,
  reviewStatus,
  submissionId,
  confirmationAccepted = false,
  dataReceived = false,
  sentToAccountant = false,
  showFinancialsLink = false,
  sdStage = null,
}: TaxBannerProps) {
  const router = useRouter()
  const { t } = useLocale()
  const returnLabel = returnType || 'Tax Return'
  const y = String(taxYear)
  const tok = { year: y, returnLabel }

  // MMLLC/Corp: after submission the generated P&L + Balance Sheet live on
  // their own review screen (Slice 9) — surface the path from the banner.
  const financialsLink = showFinancialsLink ? (
    <a href="/portal/tax-financials" className="mt-2 inline-block text-xs font-semibold text-blue-700 underline hover:text-blue-900">
      {t('taxBanner.checkFinancials')}
    </a>
  ) : null

  // ─── New review-status states ───
  if (reviewStatus !== undefined && reviewStatus !== null) {
    switch (reviewStatus) {
      case 'submitted':
      case 'resubmitted': {
        // Split by whether the client has actually hit Confirm — before this,
        // the same "under review" wording rendered for both a client who still
        // owed us categorization work AND one who'd already confirmed, which
        // is what produced a client-confirmed live case of "the portal says
        // I'm fine, I don't understand what to fix" (PAMAG LLC, 2026-08-17).
        // Scoped to showFinancialsLink (MMLLC/Corp with a submission) — that's
        // the only population with an actual categorize-and-confirm step
        // waiting on tax-financials. Everyone else (bug-hunter catch, same
        // day: this unconditionally sent SMLLC clients — no bank-statement
        // step in their engagement at all — to a page asking them to upload
        // statements that were never collected) keeps the original,
        // entity-agnostic wording below.
        if (showFinancialsLink) {
          if (!confirmationAccepted) {
            const title = interpolateString(t('taxBanner.actionNeededTitle'), tok)
            const desc = t('taxBanner.actionNeededDesc')
            const cta = t('taxBanner.finishNow')
            const editCta = t('taxBanner.editYourAnswers')
            return (
              <div className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 mb-6">
                <div className="flex items-start gap-4">
                  <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
                    <AlertTriangle className="h-5 w-5 text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
                    <p className="text-amber-700 text-xs sm:text-sm mt-1">{desc}</p>
                    <a href={editHref} className="mt-2 inline-block text-xs font-semibold text-amber-700 underline hover:text-amber-900">
                      {editCta}
                    </a>
                  </div>
                  <a
                    href="/portal/tax-financials"
                    className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    {cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            )
          }
          const doneTitle = interpolateString(t('taxBanner.doneTitle'), tok)
          const doneDesc = interpolateString(t('taxBanner.doneDesc'), tok)
          return (
            <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
              <div className="flex items-start gap-4">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                  <CheckCircle className="h-5 w-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-blue-900 text-sm sm:text-base">{doneTitle}</p>
                  <p className="text-blue-700 text-xs sm:text-sm mt-1">{doneDesc}</p>
                  {financialsLink}
                </div>
              </div>
            </div>
          )
        }

        // No financials flow for this account (not MMLLC/Corp, or no
        // submission yet) — original wording, unchanged from before this
        // whole fix, since there's no hidden categorize-and-confirm step to
        // clarify for this population.
        const title = interpolateString(t('taxBanner.submittedTitle'), tok)
        const desc = interpolateString(t('taxBanner.submittedDesc'), tok)
        const cta = t('taxBanner.edit')
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <CheckCircle className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
              <EditButton cta={cta} />
            </div>
          </div>
        )
      }

      case 'under_review': {
        const title = interpolateString(t('taxBanner.underReviewTitle'), tok)
        const desc = interpolateString(t('taxBanner.reviewStatusUnderReviewDesc'), tok)
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <Clock className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
              </div>
            </div>
          </div>
        )
      }

      case 'revision_requested': {
        const title = interpolateString(t('taxBanner.revisionRequestedTitle'), tok)
        const desc = t('taxBanner.revisionRequestedDesc')
        const cta = t('taxBanner.editAndResubmit')
        return (
          <div className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
                <p className="text-amber-700 text-xs sm:text-sm mt-1">{desc}</p>
                {financialsLink}
              </div>
              <a
                href={editHref}
                className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
              >
                <Pencil className="h-3.5 w-3.5" />
                {cta}
              </a>
            </div>
          </div>
        )
      }

      case 'approved': {
        const title = interpolateString(t('taxBanner.approvedTitle'), tok)
        const desc = t('taxBanner.approvedDesc')
        const editCta = t('taxBanner.edit')
        return (
          <div className="block w-full rounded-xl border-2 border-emerald-300 bg-emerald-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 border border-emerald-300">
                <CheckCircle className="h-5 w-5 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-emerald-900 text-sm sm:text-base">{title}</p>
                <p className="text-emerald-700 text-xs sm:text-sm mt-1">{desc}</p>
                {financialsLink}
              </div>
              <div className="shrink-0 flex items-center gap-2 self-center">
                {submissionId && (
                  <ConfirmButton
                    submissionId={submissionId}
                    onConfirmed={() => router.refresh()}
                  />
                )}
                <EditButton cta={editCta} />
              </div>
            </div>
          </div>
        )
      }

      case 'confirmed': {
        const title = interpolateString(t('taxBanner.confirmedTitle'), tok)
        const desc = interpolateString(t('taxBanner.confirmedDesc'), tok)
        return (
          <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
                <CheckCircle className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
                <p className="text-blue-700 text-xs sm:text-sm mt-1">{desc}</p>
                {financialsLink}
              </div>
            </div>
          </div>
        )
      }

      case 'reopened': {
        const title = interpolateString(t('taxBanner.reopenedTitle'), tok)
        const desc = t('taxBanner.reopenedDesc')
        const cta = t('taxBanner.reviewAndResubmit')
        return (
          <div className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
                <p className="text-amber-700 text-xs sm:text-sm mt-1">{desc}</p>
                {financialsLink}
              </div>
              <a
                href={editHref}
                className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
              >
                <Pencil className="h-3.5 w-3.5" />
                {cta}
              </a>
            </div>
          </div>
        )
      }
    }
  }

  // ─── Flow-workspace SD-stage states ───
  // Consulted ONLY after review_status (so production review_status clients are
  // never affected) and before the legacy fallback. Fixes flow Tax Returns that
  // have no review_status but a real SD stage (e.g. "Sent for Signature") and
  // were wrongly showing the legacy "Edit submission" banner.
  const flowState = sdStage ? flowStageBannerState(sdStage) : null
  if (flowState) {
    type Tone = 'amber' | 'blue' | 'emerald'
    const cfg: {
      tone: Tone
      Icon: React.ComponentType<{ className?: string }>
      title: string
      desc: string
      action?: { href: string; cta: string }
    } = (() => {
      switch (flowState) {
        case 'complete_form':
          return {
            tone: 'amber', Icon: AlertTriangle,
            title: interpolateString(t('taxBanner.flowCompleteFormTitle'), tok),
            desc: interpolateString(t('taxBanner.flowCompleteFormDesc'), tok),
            action: { href: editHref, cta: t('taxBanner.completeTaxFormCta') },
          }
        case 'under_review':
          return {
            tone: 'blue', Icon: Clock,
            title: interpolateString(t('taxBanner.underReviewTitle'), tok),
            desc: interpolateString(t('taxBanner.flowUnderReviewDesc'), tok),
          }
        case 'preparing':
          return {
            tone: 'blue', Icon: Clock,
            title: interpolateString(t('taxBanner.preparingTitle'), tok),
            desc: interpolateString(t('taxBanner.preparingDesc'), tok),
          }
        case 'revision_requested':
          return {
            tone: 'amber', Icon: AlertTriangle,
            title: interpolateString(t('taxBanner.revisionRequestedTitle'), tok),
            desc: t('taxBanner.flowRevisionRequestedDesc'),
            action: { href: editHref, cta: t('taxBanner.editYourSubmission') },
          }
        case 'sign':
          return {
            tone: 'emerald', Icon: Pencil,
            title: interpolateString(t('taxBanner.signTitle'), tok),
            desc: interpolateString(t('taxBanner.signDesc'), tok),
            action: { href: signHref, cta: t('taxBanner.signYourTaxReturn') },
          }
        case 'signed':
          return {
            tone: 'emerald', Icon: CheckCircle,
            title: interpolateString(t('taxBanner.signedTitle'), tok),
            desc: interpolateString(t('taxBanner.signedDesc'), tok),
          }
        case 'filed':
          return {
            tone: 'emerald', Icon: CheckCircle,
            title: interpolateString(t('taxBanner.filedTitle'), tok),
            desc: interpolateString(t('taxBanner.filedDesc'), tok),
          }
        case 'completed':
          return {
            tone: 'emerald', Icon: CheckCircle,
            title: interpolateString(t('taxBanner.completedTitle'), tok),
            desc: interpolateString(t('taxBanner.completedDesc'), tok),
          }
      }
    })()

    const tones: Record<Tone, { card: string; iconWrap: string; icon: string; title: string; desc: string; btn: string }> = {
      amber: { card: 'border-amber-400 bg-amber-50', iconWrap: 'bg-amber-100 border-amber-300', icon: 'text-amber-600', title: 'text-amber-900', desc: 'text-amber-700', btn: 'bg-amber-600 hover:bg-amber-700' },
      blue: { card: 'border-blue-300 bg-blue-50', iconWrap: 'bg-blue-100 border-blue-300', icon: 'text-blue-600', title: 'text-blue-900', desc: 'text-blue-700', btn: 'bg-blue-600 hover:bg-blue-700' },
      emerald: { card: 'border-emerald-300 bg-emerald-50', iconWrap: 'bg-emerald-100 border-emerald-300', icon: 'text-emerald-600', title: 'text-emerald-900', desc: 'text-emerald-700', btn: 'bg-emerald-600 hover:bg-emerald-700' },
    }
    const tn = tones[cfg.tone]
    const Icon = cfg.Icon
    const inner = (
      <div className="flex items-start gap-4">
        <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${tn.iconWrap}`}>
          <Icon className={`h-5 w-5 ${tn.icon}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm sm:text-base ${tn.title}`}>{cfg.title}</p>
          <p className={`text-xs sm:text-sm mt-1 ${tn.desc}`}>{cfg.desc}</p>
          {/* Post-submit: surface the P&L / Balance Sheet review link. The flow-
              workspace path is SD-stage-driven (no review_status), so without
              this the client lands on a link-less "Under review" banner and can
              never reach /portal/tax-financials. (financialsLink is null unless
              showFinancialsLink — MMLLC/Corp with a submission.) */}
          {(flowState === 'under_review' || flowState === 'preparing') && financialsLink}
        </div>
        {cfg.action && (
          <div className={`shrink-0 flex items-center gap-1.5 self-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${tn.btn}`}>
            <Pencil className="h-3.5 w-3.5" />
            {cfg.action.cta}
          </div>
        )}
      </div>
    )
    return cfg.action ? (
      <a href={cfg.action.href} className={`block w-full rounded-xl border-2 px-5 py-4 mb-6 transition-all hover:shadow-md ${tn.card}`}>
        {inner}
      </a>
    ) : (
      <div className={`block w-full rounded-xl border-2 px-5 py-4 mb-6 ${tn.card}`}>
        {inner}
      </div>
    )
  }

  // ─── Legacy fallback (pre-Slice-2 submissions: no review_status) ───

  if (sentToAccountant) {
    const title = interpolateString(t('taxBanner.inProgressTitle'), tok)
    const description = interpolateString(t('taxBanner.inProgressDesc'), tok)
    return (
      <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
        <div className="flex items-start gap-4">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
            <Clock className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
            <p className="text-blue-700 text-xs sm:text-sm mt-1">{description}</p>
          </div>
        </div>
      </div>
    )
  }

  if (dataReceived) {
    const title = interpolateString(t('taxBanner.dataReceivedTitle'), tok)
    const description = interpolateString(t('taxBanner.dataReceivedDesc'), tok)
    const cta = t('taxBanner.editSubmission')
    return (
      <div className="block w-full rounded-xl border-2 border-blue-300 bg-blue-50 px-5 py-4 mb-6">
        <div className="flex items-start gap-4">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 border border-blue-300">
            <CheckCircle className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-blue-900 text-sm sm:text-base">{title}</p>
            <p className="text-blue-700 text-xs sm:text-sm mt-1">{description}</p>
            {financialsLink}
          </div>
          <a
            href={editHref}
            className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            <Pencil className="h-3.5 w-3.5" />
            {cta}
          </a>
        </div>
      </div>
    )
  }

  // State 1: action required — client needs to complete the form
  const title = interpolateString(t('taxBanner.actionRequiredTitle'), tok)
  const description = interpolateString(t('taxBanner.actionRequiredDesc'), tok)
  const cta = t('taxBanner.completeTaxForm')
  return (
    <a
      href={editHref}
      className="block w-full rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-4 transition-all hover:bg-amber-100 hover:shadow-md mb-6"
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-300">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-amber-900 text-sm sm:text-base">{title}</p>
          <p className="text-amber-700 text-xs sm:text-sm mt-1">{description}</p>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 self-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
          {cta}
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
      </div>
    </a>
  )
}
