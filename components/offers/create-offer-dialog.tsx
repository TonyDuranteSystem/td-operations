'use client'

import { useState, useEffect, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Loader2, X, Upload, AlertTriangle, StickyNote, ExternalLink, CheckCircle2, BookOpen, Phone, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ReferrerPicker, type ReferrerValue } from './referrer-picker'
import { FORMATION_STATE_CODES, FORMATION_STATE_NAMES, type FormationStateCode } from '@/lib/formation/states'
import { parsePriceQuirk } from '@/lib/offers/compute-offer-totals'
import { parseAuthoredAmount, authoredAmountValue } from '@/lib/offers/parse-authored-amount'
import { deriveContractType } from '@/lib/offers/derive-contract-type'
import { formatOptionLabel } from '@/lib/offers/package-option-label'
import {
  validatePaymentPlan,
  clientFacingPartLabel,
  planTotalMatchesGross,
  type PaymentPlanPart,
  type TrancheTriggerKind,
} from '@/lib/offers/payment-plan'

// ── Service catalog: loaded from DB ──
interface CatalogService {
  id: string
  slug: string
  name: string
  description: string | null
  pipeline: string | null
  contract_type: string | null
  has_annual: boolean
  category: string
  default_price: number | null
  default_currency: string | null
  supports_quantity: boolean
  // Per-service default for the individual/business/ask dropdown. NULL means
  // not configured — dialog falls back to 'ask'. Populate via the catalog
  // row's default_service_context column (data-driven, no code edit needed
  // when adding a new service). See migration 20260512-1500.
  default_service_context: 'individual' | 'business' | 'ask' | null
}

interface SelectedService {
  id: string
  price: string            // unit price entered by staff
  quantity: number         // default 1; >1 only for services with supports_quantity
  service_context: 'individual' | 'business' | 'ask'
}

const PAYMENT_TYPES = [
  { value: 'both', label: 'Let client decide (Recommended)' },
  { value: 'bank_transfer', label: 'Bank Transfer only' },
  { value: 'checkout', label: 'Card only (+5%)' },
  { value: 'none', label: 'No payment link' },
]

const PAYMENT_GATEWAYS = [
  { value: 'stripe', label: 'Stripe (default)' },
  { value: 'whop', label: 'Whop' },
]

const BANK_OPTIONS = [
  { value: 'auto', label: 'Default (from settings)' },
  { value: 'relay', label: 'Relay (USD)' },
  { value: 'mercury', label: 'Mercury (USD)' },
  { value: 'revolut', label: 'Revolut (USD)' },
  { value: 'airwallex', label: 'Airwallex (EUR)' },
]

// ── Document types the client may need to upload ──
const DOCUMENT_TYPES = [
  { id: 'passport', name: 'Passport Copy' },
  { id: 'articles_of_organization', name: 'Articles of Organization' },
  { id: 'ein_letter', name: 'EIN Letter (IRS)' },
  { id: 'ss4', name: 'Form SS-4' },
  { id: 'operating_agreement', name: 'Operating Agreement' },
  { id: 'bank_statement', name: 'Bank Statement' },
  { id: 'proof_of_address', name: 'Proof of Address' },
  { id: 'tax_return_prior', name: 'Prior Year Tax Return' },
  { id: 'w7', name: 'Form W-7 (ITIN)' },
  { id: 'form_8832', name: 'Form 8832 (Entity Classification)' },
  { id: 'other', name: 'Other Document' },
] as const

// ── Pre-conditions: issues that must be resolved before onboarding ──
const PRECONDITION_PRESETS = [
  { id: 'de_franchise_tax', name: 'Unpaid Delaware Franchise Tax' },
  { id: 'wy_reinstatement', name: 'Wyoming Company Reinstatement' },
  { id: 'nm_reinstatement', name: 'New Mexico Company Reinstatement' },
  { id: 'annual_report_overdue', name: 'Overdue Annual Report' },
  { id: 'ra_renewal', name: 'Registered Agent Renewal' },
  { id: 'custom', name: 'Other (custom)' },
] as const

interface PreconditionItem {
  id: string
  name: string
  price: string
  customName?: string
}

interface NoteSource {
  type: 'lead_notes' | 'contact_notes' | 'account_notes' | 'call_summary'
  label: string
  content: string
  action_items?: string[]
  id: string
}

interface CreateOfferDialogProps {
  open: boolean
  onClose: () => void
  // At least one of lead_id / account_id / contact_id must be provided.
  // contact_id is required for individual-only offers (ITIN, Banking Physical)
  // per MASTER A6 (contact can buy individual services without an account).
  leadId?: string | null
  accountId?: string | null
  contactId?: string | null
  clientName: string
  clientEmail: string
  clientLanguage?: string | null
  referrerName?: string | null
  referrerType?: string | null
}

/**
 * Fire-and-forget capture to the error auto-audit system (system_errors
 * table via /api/system-errors/report). Never throws, never blocks the UI —
 * telemetry must not break the flow it is observing.
 */
function reportDialogError(payload: {
  route: string
  method: string
  http_status: number | null
  message: string
  body_snippet?: string | null
}) {
  try {
    void fetch('/api/system-errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, page_path: window.location.pathname }),
    }).catch(() => {})
  } catch {
    // ignore — reporting is best-effort
  }
}

/**
 * Read an API error response without assuming it is JSON. A dead session or
 * platform error returns HTML/plain text; the old `res.json().catch(...)`
 * collapsed those into "Unknown error" (2026-07-07 incident). Returns the
 * parsed body when possible plus the raw snippet for diagnostics.
 */
async function readErrorBody(res: Response): Promise<{ parsed: { error?: string; code?: string }; raw: string }> {
  const raw = await res.text().catch(() => '')
  try {
    return { parsed: JSON.parse(raw) as { error?: string; code?: string }, raw }
  } catch {
    return { parsed: {}, raw }
  }
}

const SESSION_EXPIRED_MSG = 'Your session expired — refresh the page, log in again, then retry. Nothing was lost.'

function isSessionExpired(status: number, parsed: { code?: string }): boolean {
  return status === 401 || parsed.code === 'SESSION_EXPIRED'
}

export function CreateOfferDialog({
  open,
  onClose,
  leadId,
  accountId,
  contactId,
  clientName,
  clientEmail,
  clientLanguage,
  referrerName,
  referrerType,
}: CreateOfferDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [catalog, setCatalog] = useState<CatalogService[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [createdOfferUrl, setCreatedOfferUrl] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  // clientNameValue is editable so staff can correct the name shown on the offer
  const [clientNameValue, setClientNameValue] = useState(clientName)

  // Reset editable name whenever the dialog opens (e.g. switching context)
  useEffect(() => {
    if (open) setClientNameValue(clientName)
  }, [open, clientName])

  // Referrer — starts from the lead's inherited name (free text). Staff can pick
  // a real client/company/partner to pin it by ID so the pay->credit chain issues
  // the reward Credit Note to exactly the right party. Reset when the dialog opens.
  const initialReferrer = (): ReferrerValue => ({
    name: referrerName || '',
    type: referrerType === 'partner' ? 'partner' : referrerName ? 'client' : null,
    contactId: null,
    accountId: null,
  })
  const [referrer, setReferrer] = useState<ReferrerValue>(initialReferrer)
  useEffect(() => {
    if (open) setReferrer(initialReferrer())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, referrerName, referrerType])

  // Fetch service catalog from DB when dialog opens
  useEffect(() => {
    if (!open || catalog.length > 0) return
    setCatalogLoading(true)
    fetch('/api/service-catalog')
      .then(r => r.json())
      .then(d => {
        const services = (d.services ?? []) as Array<Record<string, unknown>>
        setCatalog(services.map(s => {
          const ctx = s.default_service_context as string | null | undefined
          return {
            id: (s.slug as string) || (s.id as string),
            slug: (s.slug as string) || '',
            name: s.name as string,
            description: (s.description as string | null) ?? null,
            pipeline: (s.pipeline as string | null) ?? null,
            contract_type: (s.contract_type as string | null) ?? null,
            has_annual: (s.has_annual as boolean) ?? false,
            category: (s.category as string) || 'addon',
            default_price: s.default_price != null ? Number(s.default_price) : null,
            default_currency: (s.default_currency as string | null) ?? null,
            supports_quantity: (s.supports_quantity as boolean) ?? false,
            default_service_context:
              ctx === 'individual' || ctx === 'business' || ctx === 'ask' ? ctx : null,
          }
        }))
      })
      .catch(() => toast.error('Failed to load service catalog'))
      .finally(() => setCatalogLoading(false))
  }, [open, catalog.length])

  const [language, setLanguage] = useState(
    clientLanguage === 'Italian' || clientLanguage === 'it' ? 'it' : 'en'
  )
  const [paymentType, setPaymentType] = useState('both')
  const [paymentGateway, setPaymentGateway] = useState('stripe')
  const [bankPreference, setBankPreference] = useState('auto')
  const [currency, setCurrency] = useState('EUR')
  const [installmentCurrency, setInstallmentCurrency] = useState('USD')
  // Entity type — drives formation form shape (SMLLC vs MMLLC collects members),
  // SS-4 content, OA members, tax routing. Only meaningful when contract_type='formation'.
  // Empty string = not set → consumers fall back to legacy derivation.
  const [entityType, setEntityType] = useState<'' | 'SMLLC' | 'MMLLC' | 'Corp'>('')
  // Formation state pinned on the offer (WS-B). '' = not decided yet — stored
  // as NULL; downstream falls back through wizard → submission → offer → NM.
  const [formationState, setFormationState] = useState<'' | FormationStateCode>('')

  // Subject of the offer — does it attach to an EXISTING company, or is it a
  // NEW company / standalone (no account)? Previously inferred silently from the
  // The offer's subject is the launch CONTEXT, not a choice in the dialog:
  // opened from an account page → for that company (accountId set); opened from
  // a contact page → for the person (accountId null, contactId set). The dialog
  // just honors the props it's given. dev_task 262be11c.

  // Selected services with prices
  const [selected, setSelected] = useState<SelectedService[]>([])

  // Recurring costs (year 2+)
  const [installment1, setInstallment1] = useState('')
  const [installment2, setInstallment2] = useState('')

  // ── Multiple options (dev job 3c1bb5fa) ─────────────────────────────────────
  // Everything above (services, entity type, state, annual rates) IS "Option 1"
  // when extra options exist — reused as-is, not duplicated. Extra options are
  // deliberately a SIMPLER single-price form (no add-on checklist) rather than
  // repeating the full services section N times; that scope boundary is
  // intentional for v1, not an oversight.
  interface ExtraPackageDraft {
    label: string
    price: string
    currency: 'EUR' | 'USD'
    entityType: '' | 'SMLLC' | 'MMLLC' | 'Corp'
    formationState: '' | FormationStateCode
    installment1: string
    installment2: string
    installmentCurrency: 'EUR' | 'USD'
  }
  const [extraPackages, setExtraPackages] = useState<ExtraPackageDraft[]>([])

  // ── WS-C: the setup fee paid in parts ──────────────────────────────────────
  // The engine (validatePaymentPlan + createOffer) shipped 2026-08-12 with NO way to
  // author a plan outside the MCP tool, so a real split deal could not be sold from
  // this screen at all. This section is that missing door. It deliberately mirrors the
  // engine's rules rather than inventing softer ones — every constraint below exists
  // because the engine refuses the shape, and a UI that lets you type a refusable plan
  // just moves the error later.
  const [splitEnabled, setSplitEnabled] = useState(false)
  const [allowSplitPaymentChoice, setAllowSplitPaymentChoice] = useState(false)
  const [splitParts, setSplitParts] = useState<Array<{ amount: string; kind: TrancheTriggerKind; date: string; label: string }>>([
    { amount: '', kind: 'signing', date: '', label: '' },
    { amount: '', kind: 'manual', date: '', label: '' },
  ])
  // The component stays mounted when closed, so without this a plan authored for one client
  // rides onto the next offer raised from the same panel — money attached to the wrong deal
  // (bug-hunter, 2026-08-13). Client name and referrer already reset the same way.
  // allowSplitPaymentChoice joined this reset 2026-08-27 (bug-hunter, second council pass):
  // it was declared alongside splitEnabled/splitParts but omitted here, so a staff member
  // who opted one client into the client-chosen split checkbox would find it still checked
  // for the next, unrelated offer.
  useEffect(() => {
    if (!open) return
    setSplitEnabled(false)
    setAllowSplitPaymentChoice(false)
    setSplitParts([
      { amount: '', kind: 'signing', date: '', label: '' },
      { amount: '', kind: 'manual', date: '', label: '' },
    ])
  }, [open])

  // Required documents
  const [requiredDocs, setRequiredDocs] = useState<string[]>([])

  // Pre-conditions (issues with prices)
  const [preconditions, setPreconditions] = useState<PreconditionItem[]>([])

  // Admin notes (internal only)
  const [adminNotes, setAdminNotes] = useState('')

  // Partner deal (optional, per-sale): a managed partner sells the service at a
  // custom price with a setup share (paid at activation) + a renewal share (paid
  // each year the client renews). Amounts are USD.
  const [partners, setPartners] = useState<Array<{ id: string; partner_name: string; default_payout_model: string | null; default_payout_rate: number | null }>>([])
  const [partnerId, setPartnerId] = useState('')
  const [partnerSetupPayout, setPartnerSetupPayout] = useState('')
  const [partnerRenewalPayout, setPartnerRenewalPayout] = useState('')
  useEffect(() => {
    fetch('/api/crm/admin-actions/partner-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', params: {} }),
    })
      .then((r) => (r.ok ? r.json() : { data: { partners: [] } }))
      .then((d) => setPartners(d.data?.partners ?? []))
      .catch(() => setPartners([]))
  }, [])

  // Narrative content (client-facing, AI-generated or manual)
  const [narrativeOpen, setNarrativeOpen] = useState(false)
  // Conversational refine: discuss the narrative with the AI. It returns ONLY the
  // sections it changed, applied over the current (possibly hand-edited) content.
  const [refineInput, setRefineInput] = useState('')
  const [refineLoading, setRefineLoading] = useState(false)
  const [refineMessages, setRefineMessages] = useState<{ role: 'you' | 'ai'; text: string }[]>([])
  const [narrativeLoading, setNarrativeLoading] = useState(false)
  const [introEn, setIntroEn] = useState('')
  const [introIt, setIntroIt] = useState('')
  const [strategyJson, setStrategyJson] = useState('')
  const [nextStepsJson, setNextStepsJson] = useState('')
  const [futureDevJson, setFutureDevJson] = useState('')
  const [immediateActionsJson, setImmediateActionsJson] = useState('')

  // Notes context for offer creation
  const [notesContext, setNotesContext] = useState<NoteSource[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  // WS-A: credit this client already paid, shown while the offer is being built.
  const [heldCredit, setHeldCredit] = useState<Array<{ amount: number; currency: string }>>([])
  // WS-A: warnings raised WHILE creating the offer (a credit that could not be
  // attached, a mis-typed price). These HOLD the screen — see the note below.
  const [creditCheckFailed, setCreditCheckFailed] = useState(false)
  const [postCreateWarnings, setPostCreateWarnings] = useState<string[]>([])
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)

  const dismissWarnings = () => {
    setPostCreateWarnings([])
    setCreatedUrl(null)
    onClose()
  }
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set())
  const [notesExpanded, setNotesExpanded] = useState(true)
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(new Set())

  // Fetch notes context when dialog opens
  useEffect(() => {
    if (!open) { setHeldCredit([]); setCreditCheckFailed(false); return }
    if (!leadId && !contactId && !accountId) return

    setNotesLoading(true)
    const params = new URLSearchParams()
    if (leadId) params.set('lead_id', leadId)
    if (contactId) params.set('contact_id', contactId)
    if (accountId) params.set('account_id', accountId)

    fetch(`/api/crm/admin-actions/offer-notes-context?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        const sources = (d.sources ?? []) as NoteSource[]
        setNotesContext(sources)
        setHeldCredit((d.held_credit ?? []) as Array<{ amount: number; currency: string }>)
        // An absent banner must never be the way we report "we could not check".
        setCreditCheckFailed(d.credit_check_failed === true)
        // Select all by default
        setSelectedNoteIds(new Set(sources.map(s => s.id)))
      })
      .catch(() => {
        // Notes are optional; the CREDIT check is not. Swallowing this made an
        // unreachable server indistinguishable from a client who owes nothing.
        setCreditCheckFailed(true)
      })
      .finally(() => setNotesLoading(false))
  }, [open, leadId, contactId, accountId])

  const toggleNoteSelection = (id: string) => {
    setSelectedNoteIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleNoteExpanded = (id: string) => {
    setExpandedNoteIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const currencySymbol = currency === 'EUR' ? '\u20AC' : '$'
  const installmentCurrencySymbol = installmentCurrency === 'EUR' ? '\u20AC' : '$'

  // AI narrative generation handler
  async function generateNarrative() {
    if (narrativeLoading) return
    if (selected.length === 0) {
      toast.error('Select at least one service before generating')
      return
    }
    setNarrativeLoading(true)
    try {
      // Build notes context for AI (same as what goes into admin_notes)
      const noteParts: string[] = []
      for (const source of notesContext) {
        if (!selectedNoteIds.has(source.id)) continue
        if (source.type === 'call_summary') {
          let section = `${source.label}: ${source.content}`
          if (source.action_items && source.action_items.length > 0) {
            section += '\nAction Items: ' + source.action_items.join('; ')
          }
          noteParts.push(section)
        } else {
          noteParts.push(`${source.label}: ${source.content}`)
        }
      }
      if (adminNotes.trim()) noteParts.push(`Admin Notes: ${adminNotes.trim()}`)

      // Send each selected service's real name + catalog description so the
      // writer describes the ACTUAL service (from the editable catalog), not
      // prose invented in code.
      const serviceDetails = selected.map(s => {
        const cat = catalog.find(c => c.id === s.id)
        return { name: cat?.name || s.id, description: cat?.description || null }
      })

      // Whether this offer carries ongoing management — true if a selected
      // service is a management contract (formation / onboarding / renewal), OR
      // carries a recurring annual fee, OR is a primary service. Using all three
      // signals (not contract_type alone) means a management service whose
      // catalog row is missing contract_type still counts. A standalone offer
      // (ITIN-only, notary-only, banking-only) stays false, so the writer won't
      // promise registered agent / annual filing / the portal the client didn't buy.
      const includesManagement = selected.some(s => {
        const svc = catalog.find(c => c.id === s.id)
        const ct = svc?.contract_type
        return ct === 'formation' || ct === 'onboarding' || ct === 'renewal'
          || !!svc?.has_annual || svc?.category === 'primary'
      })

      const res = await fetch('/api/crm/admin-actions/generate-offer-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: clientNameValue,
          language,
          services: serviceDetails,
          notes_context: noteParts.join('\n\n'),
          // Same contract-type the offer RECORD uses (derivedContractType skips
          // null-contract_type services), so the narrative can't describe forming
          // a new company for an onboarding client on a bundled offer.
          contract_type: derivedContractType,
          // Entity type drives the tax wording (SMLLC = 5472/1120 information
          // return, MMLLC = 1065 partnership with P&L + balance sheet). Without
          // it the writer can't describe the correct filing for this client.
          entity_type: entityType || null,
          // Gates the management/portal language so standalone offers don't
          // over-promise ongoing services.
          includes_management: includesManagement,
          // Tells the writer to mention (without inventing details of) the
          // picker on the offer page — Antonio's bug report, dev job 3c1bb5fa.
          has_multiple_options: extraPackages.length > 0,
          // Let the server pull the client's full call transcript (notes + every
          // turn) from call_summaries for a richer, personalized narrative.
          lead_id: leadId || null,
          account_id: accountId || null,
        }),
      })

      if (!res.ok) {
        const { parsed, raw } = await readErrorBody(res)
        if (isSessionExpired(res.status, parsed)) {
          throw new Error(SESSION_EXPIRED_MSG)
        }
        reportDialogError({
          route: '/api/crm/admin-actions/generate-offer-narrative',
          method: 'POST',
          http_status: res.status,
          message: parsed.error || `Non-JSON error response (HTTP ${res.status})`,
          body_snippet: parsed.error ? null : raw.slice(0, 500),
        })
        throw new Error(parsed.error || `Generation failed (HTTP ${res.status})`)
      }

      const data = await res.json()
      const n = data.narrative

      // Populate editable fields
      setIntroEn(n.intro_en || '')
      setIntroIt(n.intro_it || '')
      setStrategyJson(JSON.stringify(n.strategy, null, 2))
      setNextStepsJson(JSON.stringify(n.next_steps, null, 2))
      setFutureDevJson(JSON.stringify(n.future_developments, null, 2))
      setImmediateActionsJson(JSON.stringify(n.immediate_actions, null, 2))
      setNarrativeOpen(true)
      toast.success('Narrative generated — review and edit before creating draft')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Generation failed'
      toast.error(msg)
    } finally {
      setNarrativeLoading(false)
    }
  }

  // Conversational refine — discuss the narrative; apply only what changed.
  async function refineNarrative() {
    const instruction = refineInput.trim()
    if (refineLoading || !instruction) return
    if (selected.length === 0) { toast.error('Generate or add a narrative first'); return }
    setRefineLoading(true)
    setRefineMessages(m => [...m, { role: 'you', text: instruction }])
    setRefineInput('')
    try {
      const serviceDetails = selected.map(s => {
        const cat = catalog.find(c => c.id === s.id)
        return { name: cat?.name || s.id, description: cat?.description || null }
      })
      const includesManagement = selected.some(s => {
        const svc = catalog.find(c => c.id === s.id)
        const ct = svc?.contract_type
        return ct === 'formation' || ct === 'onboarding' || ct === 'renewal' || !!svc?.has_annual || svc?.category === 'primary'
      })
      const res = await fetch('/api/crm/admin-actions/refine-offer-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: clientNameValue,
          language,
          services: serviceDetails,
          contract_type: derivedContractType,
          entity_type: entityType || null,
          includes_management: includesManagement,
          current: {
            intro_en: introEn, intro_it: introIt,
            strategy: strategyJson, next_steps: nextStepsJson,
            future_developments: futureDevJson, immediate_actions: immediateActionsJson,
          },
          instruction,
          // Lets the server look up an email when the instruction asks for one
          // (e.g. "read the email from Francesco") — scoped to whichever of
          // these identifies who this offer is actually for.
          lead_id: leadId || null,
          account_id: accountId || null,
          contact_id: contactId || null,
        }),
      })
      if (!res.ok) {
        const { parsed, raw } = await readErrorBody(res)
        if (isSessionExpired(res.status, parsed)) throw new Error(SESSION_EXPIRED_MSG)
        reportDialogError({ route: '/api/crm/admin-actions/refine-offer-narrative', method: 'POST', http_status: res.status, message: parsed.error || `Non-JSON error (HTTP ${res.status})`, body_snippet: parsed.error ? null : raw.slice(0, 500) })
        throw new Error(parsed.error || `Refine failed (HTTP ${res.status})`)
      }
      const data = await res.json()
      const changes = data.changes || {}
      const applied: string[] = []
      if ('intro_en' in changes) { setIntroEn(changes.intro_en || ''); applied.push('intro (EN)') }
      if ('intro_it' in changes) { setIntroIt(changes.intro_it || ''); applied.push('intro (IT)') }
      if ('strategy' in changes) { setStrategyJson(JSON.stringify(changes.strategy, null, 2)); applied.push('strategy') }
      if ('next_steps' in changes) { setNextStepsJson(JSON.stringify(changes.next_steps, null, 2)); applied.push('next steps') }
      if ('future_developments' in changes) { setFutureDevJson(JSON.stringify(changes.future_developments, null, 2)); applied.push('future developments') }
      if ('immediate_actions' in changes) { setImmediateActionsJson(JSON.stringify(changes.immediate_actions, null, 2)); applied.push('immediate actions') }
      const note = typeof data.note === 'string' && data.note ? data.note : (applied.length ? `Updated ${applied.join(', ')}.` : 'No change made.')
      setRefineMessages(m => [...m, { role: 'ai', text: applied.length ? `${note} (updated: ${applied.join(', ')})` : note }])
      if (applied.length) toast.success(`Updated: ${applied.join(', ')}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Refine failed'
      setRefineMessages(m => [...m, { role: 'ai', text: `⚠️ ${msg}` }])
      toast.error(msg)
    } finally {
      setRefineLoading(false)
    }
  }

  // Parse narrative JSON fields safely (returns null if empty/invalid)
  function parseJsonField(str: string): unknown | null {
    const trimmed = str.trim()
    if (!trimmed) return null
    try { return JSON.parse(trimmed) } catch { return null }
  }

  // ── Derived values ──
  // See lib/offers/derive-contract-type.ts for why this can't be a plain
  // first-match loop over click order (dev job 3c1bb5fa bug report, 2026-08-26).
  const derivedContractType = useMemo(() => {
    return deriveContractType(selected.map(s => catalog.find(c => c.id === s.id)?.contract_type))
  }, [selected, catalog])

  const derivedPipelines = useMemo(() => {
    return selected
      .map(s => catalog.find(c => c.id === s.id)?.pipeline)
      .filter((p): p is string => !!p)
  }, [selected, catalog])

  const showAnnual = useMemo(() => {
    return selected.some(s => {
      const svc = catalog.find(c => c.id === s.id)
      return svc?.has_annual
    })
  }, [selected, catalog])

  // Detect bank/currency incompatibility. Mercury/Relay/Revolut are USD-only;
  // Airwallex is EUR-only. 'auto' is always compatible (picks the right one by currency).
  const bankCurrencyMismatch = useMemo(() => {
    const usdOnly = ['relay', 'mercury', 'revolut']
    const eurOnly = ['airwallex']
    const bankLabel = BANK_OPTIONS.find(b => b.value === bankPreference)?.label || bankPreference
    if (usdOnly.includes(bankPreference) && currency !== 'USD') {
      return { bankLabel, expected: 'USD' as const }
    }
    if (eurOnly.includes(bankPreference) && currency !== 'EUR') {
      return { bankLabel, expected: 'EUR' as const }
    }
    return null
  }, [bankPreference, currency])

  // WS-A3: the PARSER is shared (one regex in the engine); the aggregation is
  // the dialog's own — draft form state with a per-line quantity multiplier the
  // stored-offer engine deliberately has no concept of.
  const servicesTotalAmount = selected.reduce((sum, s) => {
    return sum + parsePriceQuirk(s.price) * (s.quantity ?? 1)
  }, 0)

  const preconditionsTotalAmount = preconditions.reduce((sum, p) => {
    return sum + parsePriceQuirk(p.price)
  }, 0)

  const totalAmount = servicesTotalAmount + preconditionsTotalAmount

  // ── WS-C split: build the plan exactly as the engine will read it ──────────
  // ⛔ A plan can share an offer with a referrer or a managed partner (Antonio, 2026-08-13,
  // reversing the earlier lock). Commission is now released ONCE, by a human, only after the
  // whole plan is settled in real cash — see the account-page release action — so there is
  // nothing left for this screen to protect against by refusing to let a split be typed.
  const splitActive = splitEnabled

  // Each typed amount, parsed WITHOUT the stored-price quirk (which turns "1.750" into 1.75).
  // An ambiguous or unreadable entry yields 0, so the plan cannot validate and the author is
  // stopped rather than surprised by a €1.75 part.
  const parsedAmounts = useMemo(() => splitParts.map(p => parseAuthoredAmount(p.amount)), [splitParts])
  const ambiguousAmounts = parsedAmounts
    .map((a, i) => (a.kind === "ambiguous" ? { seq: i + 1, ...a } : null))
    .filter(Boolean) as Array<{ seq: number; raw: string; asThousands: number; asDecimal: number }>

  const planDraft: PaymentPlanPart[] = useMemo(
    () =>
      splitParts.map((p, i) => ({
        seq: i + 1,
        amount: authoredAmountValue(parsedAmounts[i]),
        // One currency for the whole plan — the offer's. Credit, bank matching and
        // activation are all single-currency, so a per-part currency would break
        // further down where the error means nothing.
        currency,
        trigger: {
          kind: i === 0 ? ('signing' as TrancheTriggerKind) : p.kind,
          ...(p.kind === 'date' && i > 0 ? { date: p.date } : {}),
          ...(p.kind === 'manual' && i > 0 && p.label.trim() ? { label: p.label.trim() } : {}),
        },
      })),
    [splitParts, currency, parsedAmounts],
  )
  const planCheck = useMemo(
    () => (splitActive ? validatePaymentPlan(planDraft) : null),
    [splitActive, planDraft],
  )
  const planSum = planDraft.reduce((s, p) => s + p.amount, 0)
  // ⛔ COMPARED AGAINST THE ENGINE'S GROSS — services PLUS pre-conditions (`totalAmount`), which
  // is what computeOfferTotals sums and what decideSigningBill judges the plan against. Comparing
  // against the services subtotal alone was wrong in BOTH directions (bug-hunter, 2026-08-13): it
  // passed a plan the engine would refuse — stripping every pay control so the client cannot pay
  // at all — and fired a FALSE warning on the plan the engine actually wants, steering the author
  // into the broken shape. Any pre-condition on the offer triggered it.
  // ⛔ 0.01 — THE SAME TOLERANCE THE ENGINE USES, not a friendlier one. The first fix corrected
  // WHAT is compared and left the threshold at 0.5, which is 50× looser than decideSigningBill
  // and resolveDueNow (both `> 0.01`), and there is no server-side plan-vs-gross crosscheck
  // behind this gate. A three-way split of a fee that does not divide (3500 → 1166.66 × 3 =
  // 3499.98, off by 0.02) sailed through here and was then refused by every consumer: the offer
  // page hides the payment block, the contract cannot state the amount, and signing bills the
  // WHOLE fee. A gate looser than the thing it guards is not a gate.
  const planMismatch = splitActive && planSum > 0 && !planTotalMatchesGross(planSum, totalAmount)

  // ⛔ A HALF-WRITTEN SPLIT MUST STOP THE SUBMIT — it must NEVER become "no split".
  // The first cut posted null whenever the plan failed to validate, on the theory that never
  // sending a bad plan was the safe choice. It is the DANGEROUS one (bug-hunter, 2026-08-13):
  // the offer is created as an ordinary full-payment deal, with no error, no toast and no trace
  // that a split was ever intended — the client signs and is billed the whole fee. Silence is
  // indistinguishable from "the author changed their mind". So the split now BLOCKS instead.
  //
  const splitBlockReason: string | null = !splitActive
    ? null
    : ambiguousAmounts.length > 0
      ? `Part ${ambiguousAmounts[0].seq}: "${ambiguousAmounts[0].raw}" could mean ${currencySymbol}${ambiguousAmounts[0].asThousands.toLocaleString('en-US')} or ${currencySymbol}${ambiguousAmounts[0].asDecimal}. Write it without the dot (e.g. ${ambiguousAmounts[0].asThousands}).`
      : planCheck && !planCheck.ok
        ? `Payment plan not usable — ${planCheck.errors.join(' ')}`
        : planMismatch
          ? `The parts add up to ${currencySymbol}${planSum.toLocaleString('en-US')} but this offer totals ${currencySymbol}${totalAmount.toLocaleString('en-US')}. They must match, or the client is billed the full amount at signing.`
          : null

  // Data-driven default for the per-service individual/business/ask
  // dropdown. The value comes from service_catalog.default_service_context
  // (see migration 20260512-1500). Adding a new individual-level service
  // means setting that column on its catalog row — no code change here.
  const getDefaultContext = (svc: CatalogService | undefined): 'individual' | 'business' | 'ask' => {
    return svc?.default_service_context ?? 'ask'
  }

  const toggleService = (id: string) => {
    setSelected(prev => {
      const exists = prev.find(s => s.id === id)
      if (exists) return prev.filter(s => s.id !== id)
      const svc = catalog.find(c => c.id === id)
      const defaultPrice = svc?.default_price != null ? String(svc.default_price) : ''
      return [...prev, { id, price: defaultPrice, quantity: 1, service_context: getDefaultContext(svc) }]
    })
  }

  const updatePrice = (id: string, price: string) => {
    setSelected(prev =>
      prev.map(s => s.id === id ? { ...s, price } : s)
    )
  }

  const updateQuantity = (id: string, quantity: number) => {
    setSelected(prev =>
      prev.map(s => s.id === id ? { ...s, quantity: Math.max(1, quantity) } : s)
    )
  }

  const updateServiceContext = (id: string, ctx: 'individual' | 'business' | 'ask') => {
    setSelected(prev =>
      prev.map(s => s.id === id ? { ...s, service_context: ctx } : s)
    )
  }

  const isSelected = (id: string) => selected.some(s => s.id === id)

  const toggleDoc = (docId: string) => {
    setRequiredDocs(prev =>
      prev.includes(docId) ? prev.filter(d => d !== docId) : [...prev, docId]
    )
  }

  const togglePrecondition = (presetId: string) => {
    setPreconditions(prev => {
      const exists = prev.find(p => p.id === presetId)
      if (exists) return prev.filter(p => p.id !== presetId)
      const preset = PRECONDITION_PRESETS.find(p => p.id === presetId)
      return [...prev, { id: presetId, name: preset?.name || presetId, price: '' }]
    })
  }

  const updatePreconditionPrice = (id: string, price: string) => {
    setPreconditions(prev => prev.map(p => p.id === id ? { ...p, price } : p))
  }

  const updatePreconditionName = (id: string, customName: string) => {
    setPreconditions(prev => prev.map(p => p.id === id ? { ...p, customName } : p))
  }

  // ── Submit ──
  const handleSubmit = () => {
    if (selected.length === 0) {
      toast.error('Select at least one service')
      return
    }

    const withPrices = selected.filter(s => s.price.trim())
    if (withPrices.length === 0) {
      toast.error('Enter a price for at least one service')
      return
    }

    if (splitBlockReason) {
      toast.error(splitBlockReason)
      return
    }

    if (extraPackages.length > 0) {
      if (splitEnabled) {
        toast.error('Multiple options can’t be combined with paying the setup fee in parts')
        return
      }
      for (let i = 0; i < extraPackages.length; i++) {
        const p = extraPackages[i]
        const label = `Option ${i + 2}`
        if (!p.label.trim()) { toast.error(`${label}: needs a label`); return }
        if (!p.price.trim() || !(parseFloat(p.price.replace(/[^0-9.]/g, '')) > 0)) {
          toast.error(`${label}: needs a setup price`); return
        }
        if (!p.entityType) { toast.error(`${label}: pick a company type`); return }
        if (!p.formationState) { toast.error(`${label}: pick a US state`); return }
        if (!p.installment1.trim() || !p.installment2.trim()) {
          toast.error(`${label}: needs both renewal installment amounts`); return
        }
      }
    }

    startTransition(async () => {
      try {
        const servicesJson = selected
          .filter(s => s.price.trim())
          .map(s => {
            const svc_cat = catalog.find(c => c.id === s.id)
            const unitPrice = s.price.replace(/[^0-9.]/g, '')
            const qty = s.quantity ?? 1
            const totalPrice = (parseFloat(unitPrice) * qty).toLocaleString('en-US')
            const svc: Record<string, unknown> = {
              name: svc_cat?.name || s.id,
              price: `${currencySymbol}${qty > 1 ? totalPrice : unitPrice}`,
              service_context: s.service_context,
            }
            if (svc_cat?.contract_type) svc.contract_type = svc_cat.contract_type
            if (svc_cat?.pipeline) svc.pipeline_type = svc_cat.pipeline
            if (qty > 1) {
              svc.quantity = qty
              svc.unit_price = `${currencySymbol}${unitPrice}`
            }
            return svc
          })

        const costItems = servicesJson.map(s => {
          const qty = (s.quantity as number | undefined) ?? 1
          const displayName = qty > 1
            ? `${s.name as string} × ${qty}`
            : s.name as string
          return { name: displayName, price: s.price as string }
        })

        const costSummary: Array<{ label: string; total: string; items: Array<{ name: string; price: string }> }> = [{
          label: 'Setup Fee',
          total: `${currencySymbol}${servicesTotalAmount.toLocaleString('en-US')}`,
          items: costItems,
        }]

        // Add preconditions as a separate cost group
        const activePreconditions = preconditions.filter(p => p.price.trim())
        if (activePreconditions.length > 0) {
          const preItems = activePreconditions.map(p => ({
            name: p.id === 'custom' && p.customName ? p.customName : p.name,
            price: `${currencySymbol}${p.price.replace(/[^0-9.]/g, '')}`,
          }))
          costSummary.push({
            label: 'Pre-conditions (to be resolved)',
            total: `${currencySymbol}${preconditionsTotalAmount.toLocaleString('en-US')}`,
            items: preItems,
          })
        }

        // Build issues JSONB from preconditions (shown to client on offer page)
        const issuesJson = activePreconditions.length > 0
          ? activePreconditions.map(p => ({
              title: p.id === 'custom' && p.customName ? p.customName : p.name,
              description: `${currencySymbol}${p.price.replace(/[^0-9.]/g, '')} -- must be resolved before onboarding can proceed.`,
            }))
          : null

        let recurringCosts = null
        if (showAnnual && (installment1 || installment2)) {
          recurringCosts = []
          if (installment1) {
            recurringCosts.push({ label: '1st Installment (January)', price: `${installmentCurrencySymbol}${installment1}`, currency: installmentCurrency })
          }
          if (installment2) {
            recurringCosts.push({ label: '2nd Installment (June)', price: `${installmentCurrencySymbol}${installment2}`, currency: installmentCurrency })
          }
          const annualTotal = (parseFloat(installment1 || '0') + parseFloat(installment2 || '0'))
          if (annualTotal > 0) {
            recurringCosts.push({ label: 'Annual Total', price: `${installmentCurrencySymbol}${annualTotal.toLocaleString('en-US')}`, currency: installmentCurrency })
          }
        }

        // Build required_documents JSONB
        const requiredDocsJson = requiredDocs.length > 0
          ? requiredDocs.map(docId => {
              const doc = DOCUMENT_TYPES.find(d => d.id === docId)
              return { id: docId, name: doc?.name || docId }
            })
          : null

        // Build combined admin notes: selected note sources + user-typed notes
        const noteParts: string[] = []
        for (const source of notesContext) {
          if (!selectedNoteIds.has(source.id)) continue
          if (source.type === 'call_summary') {
            let section = `=== ${source.label} ===\n${source.content}`
            if (source.action_items && source.action_items.length > 0) {
              section += '\nAction Items:\n' + source.action_items.map(item => `- ${item}`).join('\n')
            }
            noteParts.push(section)
          } else {
            noteParts.push(`=== ${source.label} ===\n${source.content}`)
          }
        }
        if (adminNotes.trim()) {
          noteParts.push(`=== Admin Notes ===\n${adminNotes.trim()}`)
        }
        const combinedNotes = noteParts.length > 0 ? noteParts.join('\n\n') : null

        // Multiple options (dev job 3c1bb5fa): Option 1 is exactly what's already
        // been built above (servicesJson/costSummary/recurringCosts) — reused, not
        // recomputed — plus one simplified single-price package per extra option.
        const packages = extraPackages.length > 0
          ? [
              {
                key: 'option-1',
                label: 'Option 1',
                currency,
                entity_type: entityType,
                formation_state: formationState,
                services: servicesJson,
                cost_summary: costSummary,
                recurring_costs: recurringCosts,
                installment_currency: showAnnual ? installmentCurrency : installmentCurrency,
              },
              ...extraPackages.map((p, i) => {
                const pkgSymbol = p.currency === 'EUR' ? '€' : '$'
                const pkgInstSymbol = p.installmentCurrency === 'EUR' ? '€' : '$'
                const cleanPrice = p.price.replace(/[^0-9.]/g, '')
                return {
                  key: `option-${i + 2}`,
                  label: p.label,
                  currency: p.currency,
                  entity_type: p.entityType,
                  formation_state: p.formationState,
                  services: [{ name: 'Company Formation', price: `${pkgSymbol}${cleanPrice}` }],
                  cost_summary: [{
                    label: 'Setup Fee',
                    total: `${pkgSymbol}${cleanPrice}`,
                    items: [{ name: 'Company Formation', price: `${pkgSymbol}${cleanPrice}` }],
                  }],
                  recurring_costs: [
                    { label: '1st Installment (January)', price: `${pkgInstSymbol}${p.installment1}`, currency: p.installmentCurrency },
                    { label: '2nd Installment (June)', price: `${pkgInstSymbol}${p.installment2}`, currency: p.installmentCurrency },
                  ],
                  installment_currency: p.installmentCurrency,
                }
              }),
            ]
          : null

        const res = await fetch('/api/crm/admin-actions/create-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId || null,
            // Only attach the account when the offer is explicitly for an
            // existing company. A new-company/standalone offer never carries it
            // (the server also enforces this for formations). dev_task 262be11c.
            // Subject = launch context: account page → that company; contact
            // page → person (accountId is null). The server also strips the
            // account for a formation (new company) as a backstop. dev_task 262be11c.
            account_id: accountId || null,
            contact_id: contactId || null,
            client_name: clientNameValue,
            client_email: clientEmail,
            language,
            contract_type: derivedContractType,
            packages,
            entity_type: entityType || null,
            // Gated on the DERIVED type: a state picked while the offer looked like a
            // formation must not ride along if service edits turned it into onboarding
            // (adversarial QA finding — the hidden value would become the client's
            // future formation default via the activation copy).
            formation_state: derivedContractType === 'formation' ? (formationState || null) : null,
            payment_type: paymentType === 'both' ? 'checkout' : paymentType,
            payment_gateway: paymentGateway,
            bank_preference: bankPreference,
            currency,
            installment_currency: showAnnual ? installmentCurrency : null,
            // Reached only when `splitBlockReason` is null (both submit gates return
            // early otherwise), so an enabled split is ALWAYS sent as a valid plan and
            // can never degrade into a silent full-payment offer.
            payment_plan: splitActive ? (planCheck?.plan ?? null) : null,
            allow_split_payment_choice: allowSplitPaymentChoice,
            services: servicesJson,
            cost_summary: costSummary,
            recurring_costs: recurringCosts,
            bundled_pipelines: derivedPipelines,
            referrer_name: referrer.name.trim() || null,
            referrer_type: referrer.type || null,
            referrer_contact_id: referrer.contactId,
            referrer_account_id: referrer.accountId,
            // Managed-partner deal (per-sale): flat-fee setup share (paid at
            // activation) + renewal share (paid each year). USD.
            partner_id: partnerId || null,
            partner_payout_model: partnerId ? (partnerSetupPayout ? 'flat_fee' : 'none') : null,
            partner_payout_rate: partnerId && partnerSetupPayout ? Number(partnerSetupPayout) : null,
            partner_renewal_payout: partnerId && partnerRenewalPayout ? Number(partnerRenewalPayout) : null,
            required_documents: requiredDocsJson,
            issues: issuesJson,
            admin_notes: combinedNotes,
            // Narrative content (client-facing)
            intro_en: introEn.trim() || null,
            intro_it: introIt.trim() || null,
            strategy: parseJsonField(strategyJson),
            next_steps: parseJsonField(nextStepsJson),
            future_developments: parseJsonField(futureDevJson),
            immediate_actions: parseJsonField(immediateActionsJson),
          }),
        })

        if (!res.ok) {
          const { parsed, raw } = await readErrorBody(res)
          if (isSessionExpired(res.status, parsed)) {
            toast.error(SESSION_EXPIRED_MSG)
            return
          }
          reportDialogError({
            route: '/api/crm/admin-actions/create-offer',
            method: 'POST',
            http_status: res.status,
            message: parsed.error || `Non-JSON error response (HTTP ${res.status})`,
            body_snippet: parsed.error ? null : raw.slice(0, 500),
          })
          toast.error(parsed.error || `Failed to create offer (HTTP ${res.status})`)
          return
        }

        const data = await res.json()

        const warnings = (data.warnings ?? []) as string[]
        setCreatedOfferUrl(data.offer_url)

        // WS-A: a warning must HOLD THE SCREEN, not be a toast.
        // This previously toasted and then immediately opened the offer in a new
        // tab — which took focus, so the warning was raised on a screen the user
        // was instantly navigated away from and never saw. Antonio hit exactly
        // that. When something is wrong, the preview waits until he has read it.
        if (warnings.length > 0) {
          setPostCreateWarnings(warnings)
          setCreatedUrl(data.offer_url)
          // Two channels on purpose. The screen is the one that holds; the toast
          // is insurance in case anything ever unmounts this component again.
          for (const w of warnings) toast.warning(w, { duration: 30000 })
          router.refresh()
          return
        }

        toast.success(`Draft offer created — opening preview`)
        window.open(`${data.offer_url}?preview=td`, '_blank')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  // WS-A: the offer was created, but something needs reading BEFORE it is sent.
  // A full screen, not a toast — the previous version raised this and then
  // opened the offer in a new tab in the same breath, so it was never seen.
  if (postCreateWarnings.length > 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
          <h2 className="text-lg font-semibold mb-1">Offer created — read this before sending</h2>
          <p className="text-sm text-zinc-500 mb-4">The draft is saved. Nothing has gone to the client.</p>
          <div className="space-y-3 mb-5">
            {postCreateWarnings.map((w, i) => (
              <div key={i} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                {w}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={dismissWarnings}
              className="px-3 py-1.5 text-sm rounded-md border hover:bg-zinc-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                if (createdUrl) window.open(`${createdUrl}?preview=td`, '_blank')
                dismissWarnings()
              }}
              className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              Open the offer anyway
            </button>
          </div>
        </div>
      </div>
    )
  }

  // DELIBERATELY ABOVE THE `open` GATE.
  // Creating an offer takes seconds (many sequential writes). If the staffer
  // closes the dialog while that is in flight, the response still arrives and
  // sets these warnings — and if this lived below the gate, the component would
  // return null and the warning would be destroyed. Unrecoverably: once the
  // offer exists the Create Offer button disappears, so it could never repaint.
  // That is the sixth defect in this feature where the message was produced and
  // never reached a human; the warning outliving its own dialog is the fix.
  if (!open) return null

  const primaryServices = catalog.filter(s => s.category === 'primary')
  const standaloneServices = catalog.filter(s => s.category === 'standalone')
  const addonServices = catalog.filter(s => s.category === 'addon')
  const _sourceLabel = accountId ? 'account' : 'lead'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Create Offer</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Client info — name is editable so staff can correct it before creating */}
          <div className="bg-zinc-50 rounded-lg p-3 space-y-1.5">
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">
                Client name <span className="text-zinc-400">(shown on offer page — editable)</span>
              </label>
              <input
                type="text"
                value={clientNameValue}
                onChange={e => setClientNameValue(e.target.value)}
                className="w-full text-sm font-medium bg-white border border-zinc-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Client name"
              />
            </div>
            <p className="text-sm text-zinc-600">{clientEmail}</p>
            {/* WS-A: what this client has ALREADY PAID. Shown here, while the
                services are still being chosen, because learning it after the
                offer is written is too late to price the deal. */}
            {creditCheckFailed && heldCredit.length === 0 && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-sm text-amber-900">
                  ⚠ Could not check whether this client has unused credit. That is
                  <strong> not</strong> the same as them having none — check before you price this.
                </p>
              </div>
            )}
            {heldCredit.length > 0 && (
              <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                <p className="text-sm font-medium text-emerald-900">
                  💳 Already paid:{' '}
                  {heldCredit
                    .map(c => `${c.currency === 'EUR' ? '€' : '$'}${c.amount.toLocaleString('en-US')}`)
                    .join(' + ')}{' '}
                  unused credit
                </p>
                <p className="mt-0.5 text-xs text-emerald-800">
                  It is deducted automatically on an offer in the same currency. A credit in
                  another currency is never converted — price this offer to match it.
                </p>
              </div>
            )}
            <div className="pt-1">
              <ReferrerPicker value={referrer} onChange={setReferrer} />
            </div>
          </div>

          {/* Partner deal (optional, per-sale) */}
          {partners.length > 0 && (
            <div className="rounded-lg border border-zinc-200 p-3 space-y-2">
              <p className="text-xs font-semibold text-zinc-700 uppercase tracking-wide">Partner deal (optional)</p>
              <p className="text-[11px] text-zinc-500">
                For a sale brought by a managed partner: their <b>setup payout</b> (paid once at activation) and <b>renewal payout</b> (paid in full on EACH installment the client pays — two per year). Leave renewal blank if none agreed. Amounts in USD.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={partnerId}
                  onChange={(e) => {
                    setPartnerId(e.target.value)
                    if (!e.target.value) { setPartnerSetupPayout(''); setPartnerRenewalPayout('') }
                    const p = partners.find((x) => x.id === e.target.value)
                    if (p && p.default_payout_model === 'flat_fee' && p.default_payout_rate != null && !partnerSetupPayout) {
                      setPartnerSetupPayout(String(p.default_payout_rate))
                    }
                  }}
                  className="border rounded px-2 py-1.5 text-sm"
                >
                  <option value="">No partner</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>{p.partner_name}</option>
                  ))}
                </select>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Setup payout $"
                  value={partnerSetupPayout}
                  onChange={(e) => setPartnerSetupPayout(e.target.value)}
                  disabled={!partnerId}
                  className="border rounded px-2 py-1.5 text-sm disabled:bg-zinc-50"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Renewal payout $ (each installment)"
                  value={partnerRenewalPayout}
                  onChange={(e) => setPartnerRenewalPayout(e.target.value)}
                  disabled={!partnerId}
                  className="border rounded px-2 py-1.5 text-sm disabled:bg-zinc-50"
                />
              </div>
            </div>
          )}

          {/* Notes & Call Context */}
          {(notesLoading || notesContext.length > 0) && (
            <div className="border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setNotesExpanded(prev => !prev)}
                className="flex items-center justify-between w-full px-3 py-2.5 bg-violet-50 hover:bg-violet-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-violet-600" />
                  <span className="text-sm font-semibold text-violet-900">Notes &amp; Call Context</span>
                  {notesContext.length > 0 && (
                    <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 text-xs font-medium rounded-full bg-violet-200 text-violet-800">
                      {notesContext.length}
                    </span>
                  )}
                </div>
                {notesExpanded ? <ChevronUp className="h-4 w-4 text-violet-600" /> : <ChevronDown className="h-4 w-4 text-violet-600" />}
              </button>

              {notesExpanded && (
                <div className="p-3 space-y-2">
                  {notesLoading && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading notes...
                    </div>
                  )}

                  {!notesLoading && notesContext.length === 0 && (
                    <p className="text-xs text-muted-foreground py-1">No notes available</p>
                  )}

                  {notesContext.map(source => {
                    const isChecked = selectedNoteIds.has(source.id)
                    const isFullyExpanded = expandedNoteIds.has(source.id)
                    const preview = source.content.length > 150 && !isFullyExpanded
                      ? source.content.slice(0, 150) + '...'
                      : source.content

                    return (
                      <div
                        key={source.id}
                        className={`rounded-lg border p-2.5 transition-colors ${
                          isChecked
                            ? 'bg-violet-50 border-violet-200'
                            : 'bg-white border-zinc-200'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleNoteSelection(source.id)}
                            className="h-4 w-4 mt-0.5 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              {source.type === 'call_summary' ? (
                                <Phone className="h-3.5 w-3.5 text-violet-500 flex-shrink-0" />
                              ) : (
                                <StickyNote className="h-3.5 w-3.5 text-violet-500 flex-shrink-0" />
                              )}
                              <span className="text-xs font-medium text-zinc-700 truncate">{source.label}</span>
                            </div>
                            <p className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap break-words">{preview}</p>
                            {source.content.length > 150 && (
                              <button
                                type="button"
                                onClick={() => toggleNoteExpanded(source.id)}
                                className="text-xs text-violet-600 hover:text-violet-800 mt-0.5 font-medium"
                              >
                                {isFullyExpanded ? 'Show less' : 'Show full'}
                              </button>
                            )}
                            {isFullyExpanded && source.action_items && source.action_items.length > 0 && (
                              <div className="mt-1.5">
                                <p className="text-xs font-medium text-zinc-600">Action Items:</p>
                                <ul className="text-xs text-zinc-500 mt-0.5 space-y-0.5">
                                  {source.action_items.map((item, i) => (
                                    <li key={i} className="flex gap-1">
                                      <span className="text-zinc-400">-</span>
                                      <span>{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Services -- grouped by category */}
          <div>
            <label className="block text-sm font-semibold mb-3">What is the client buying?</label>

            {catalogLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading services...
              </div>
            )}

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Annual Management</p>
            <div className="space-y-2 mb-4">
              {primaryServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  quantity={selected.find(s => s.id === svc.id)?.quantity ?? 1}
                  serviceContext={selected.find(s => s.id === svc.id)?.service_context || 'ask'}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                  onQuantityChange={(q) => updateQuantity(svc.id, q)}
                  onContextChange={(ctx) => updateServiceContext(svc.id, ctx)}
                />
              ))}
            </div>

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Standalone Services</p>
            <div className="space-y-2 mb-4">
              {standaloneServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  quantity={selected.find(s => s.id === svc.id)?.quantity ?? 1}
                  serviceContext={selected.find(s => s.id === svc.id)?.service_context || 'ask'}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                  onQuantityChange={(q) => updateQuantity(svc.id, q)}
                  onContextChange={(ctx) => updateServiceContext(svc.id, ctx)}
                />
              ))}
            </div>

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Add-ons</p>
            <div className="space-y-2">
              {addonServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  quantity={selected.find(s => s.id === svc.id)?.quantity ?? 1}
                  serviceContext={selected.find(s => s.id === svc.id)?.service_context || 'ask'}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                  onQuantityChange={(q) => updateQuantity(svc.id, q)}
                  onContextChange={(ctx) => updateServiceContext(svc.id, ctx)}
                />
              ))}
            </div>
          </div>

          {/* Total */}
          {totalAmount > 0 && (
            <div className="flex justify-between items-center bg-zinc-50 rounded-lg p-3">
              <span className="text-sm font-medium">Total</span>
              <span className="text-lg font-bold">{currencySymbol}{totalAmount.toLocaleString('en-US')}</span>
            </div>
          )}

          {/* Language + Currency + Payment */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Language</label>
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="en">English</option>
                <option value="it">Italian</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Payment</label>
              <select
                value={paymentType}
                onChange={e => setPaymentType(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PAYMENT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Payment Gateway + Bank Account */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Payment Gateway</label>
              <select
                value={paymentGateway}
                onChange={e => setPaymentGateway(e.target.value)}
                disabled={paymentType === 'bank_transfer' || paymentType === 'none'}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:bg-zinc-100"
              >
                {PAYMENT_GATEWAYS.map(g => (
                  <option key={g.value} value={g.value}>{g.label}</option>
                ))}
              </select>
              {(paymentType === 'bank_transfer' || paymentType === 'none') && (
                <p className="text-xs text-zinc-400 mt-0.5">N/A for this payment type</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Bank Account</label>
              <select
                value={bankPreference}
                onChange={e => setBankPreference(e.target.value)}
                className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 ${
                  bankCurrencyMismatch
                    ? 'border-red-400 focus:ring-red-500 bg-red-50'
                    : 'focus:ring-blue-500'
                }`}
              >
                {BANK_OPTIONS.map(b => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
              {bankCurrencyMismatch ? (
                <p className="text-xs text-red-600 mt-0.5 font-medium flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>
                    {bankCurrencyMismatch.bankLabel} is {bankCurrencyMismatch.expected}-only — switch currency to {bankCurrencyMismatch.expected} or pick a different bank.
                  </span>
                </p>
              ) : bankPreference === 'auto' ? (
                <p className="text-xs text-zinc-400 mt-0.5">Picks default bank from Invoice Settings</p>
              ) : null}
            </div>
          </div>

          {/* Entity Type — formation and onboarding offers */}
          {(derivedContractType === 'formation' || derivedContractType === 'onboarding') && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Entity Type
                <span className="text-xs font-normal text-muted-foreground ml-2">
                  (drives the formation wizard shape, SS-4, OA, and tax routing)
                </span>
              </label>
              <div className="flex gap-2">
                {[
                  { value: 'SMLLC', label: 'Single-Member LLC' },
                  { value: 'MMLLC', label: 'Multi-Member LLC' },
                  { value: 'Corp', label: 'C-Corp' },
                ].map(opt => (
                  <label
                    key={opt.value}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm border rounded-md cursor-pointer transition-colors ${
                      entityType === opt.value
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-zinc-200 hover:border-zinc-400'
                    }`}
                  >
                    <input
                      type="radio"
                      name="entity_type"
                      value={opt.value}
                      checked={entityType === opt.value}
                      onChange={() => setEntityType(opt.value as 'SMLLC' | 'MMLLC' | 'Corp')}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {!entityType && (
                <p className="text-xs text-amber-600 mt-1">
                  Not set — pick explicitly for multi-member offers so the formation wizard, SS-4, and OA use the right shape.
                </p>
              )}
            </div>
          )}

          {/* Formation State — formation offers only (WS-B, dev job c0a61e44) */}
          {derivedContractType === 'formation' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                State of Formation
                <span className="text-xs font-normal text-muted-foreground ml-2">
                  (shown to the client on the offer + contract; formation flow default)
                </span>
              </label>
              <div className="flex gap-2">
                {FORMATION_STATE_CODES.map(code => (
                  <label
                    key={code}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm border rounded-md cursor-pointer transition-colors ${
                      formationState === code
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-zinc-200 hover:border-zinc-400'
                    }`}
                  >
                    <input
                      type="radio"
                      name="formation_state"
                      value={code}
                      checked={formationState === code}
                      onChange={() => setFormationState(code)}
                      className="sr-only"
                    />
                    {FORMATION_STATE_NAMES[code]}
                  </label>
                ))}
              </div>
              {!formationState && (
                <p className="text-xs text-amber-600 mt-1">
                  Not set — the formation flow will default to New Mexico unless overridden later.
                </p>
              )}
            </div>
          )}

          {/* Setup fee paid in parts (WS-C payment plan) */}
          <div className="border rounded-md p-3 bg-zinc-50/60">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={splitEnabled}
                onChange={e => {
                  setSplitEnabled(e.target.checked)
                  if (e.target.checked) setAllowSplitPaymentChoice(false)
                }}
              />
              Client pays the setup fee in parts
            </label>
            {splitEnabled && (referrer.name.trim() || referrer.contactId || referrer.accountId || partnerId) && (
              <p className="text-xs text-blue-600 mt-1">
                This offer carries a referrer or a managed partner. Their commission is released
                once, by hand, from the account page — only after the whole split is paid in full
                cash. Nothing pays automatically on the first part.
              </p>
            )}

            {splitActive && (
              <div className="mt-3 space-y-3">
                {splitParts.map((part, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <div className="w-28">
                      <label className="text-xs text-muted-foreground">Part {i + 1} amount</label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-sm text-zinc-400">{currencySymbol}</span>
                        <input
                          type="text"
                          value={part.amount}
                          onChange={e => setSplitParts(prev => prev.map((p, j) => j === i ? { ...p, amount: e.target.value } : p))}
                          placeholder="1750"
                          className="w-full pl-7 pr-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    {i === 0 ? (
                      <div className="text-xs text-muted-foreground pb-2">
                        due on signing — this part activates the deal
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="text-xs text-muted-foreground">Due</label>
                          <select
                            value={part.kind}
                            onChange={e => setSplitParts(prev => prev.map((p, j) => j === i ? { ...p, kind: e.target.value as TrancheTriggerKind } : p))}
                            className="block px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="manual">When you say so</option>
                            <option value="date">On a date</option>
                          </select>
                        </div>
                        {part.kind === 'date' ? (
                          <div>
                            <label className="text-xs text-muted-foreground">Date</label>
                            <input
                              type="date"
                              // A past date renders verbatim into the client's offer, signed
                              // contract and portal schedule ("due by 1 September 2025" for a
                              // payment that has not happened) — a year typo is the realistic
                              // way in. The picker refuses it at the source.
                              min={new Date().toISOString().slice(0, 10)}
                              value={part.date}
                              onChange={e => setSplitParts(prev => prev.map((p, j) => j === i ? { ...p, date: e.target.value } : p))}
                              className="block px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                        ) : (
                          <div className="flex-1 min-w-[200px]">
                            <label className="text-xs text-muted-foreground">What the client is waiting for (they read this)</label>
                            <input
                              type="text"
                              value={part.label}
                              onChange={e => setSplitParts(prev => prev.map((p, j) => j === i ? { ...p, label: e.target.value } : p))}
                              placeholder="e.g. 30 days after signing"
                              className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                        )}
                        {splitParts.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setSplitParts(prev => prev.filter((_, j) => j !== i))}
                            className="pb-1.5 text-xs text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => setSplitParts(prev => [...prev, { amount: '', kind: 'manual', date: '', label: '' }])}
                  className="text-xs text-blue-600 hover:underline"
                >
                  + Add another part
                </button>

                {/* No part after the first ever invoices itself — a date is a reminder, not a
                    scheduler. Said here because the alternative is Antonio discovering it by a
                    payment that never arrived. */}
                <p className="text-xs text-muted-foreground">
                  Only the first part is invoiced automatically, at signing. Every later part is raised
                  by you from the client&apos;s account page when it comes due — a date is a reminder, not
                  a scheduler.
                </p>

                {ambiguousAmounts.map(a => (
                  <p key={a.seq} className="text-xs text-red-600">
                    Part {a.seq}: &quot;{a.raw}&quot; could mean {currencySymbol}{a.asThousands.toLocaleString('en-US')} or{' '}
                    {currencySymbol}{a.asDecimal} — write it without the dot ({a.asThousands}) so there is no doubt.
                  </p>
                ))}

                {planMismatch && (
                  <p className="text-xs text-amber-600">
                    The parts add up to {currencySymbol}{planSum.toLocaleString('en-US')} but this offer totals{' '}
                    {currencySymbol}{totalAmount.toLocaleString('en-US')}. They must match — otherwise the client is
                    billed the full amount at signing and cannot pay from the offer at all.
                  </p>
                )}

                {planCheck && !planCheck.ok && (
                  <ul className="text-xs text-red-600 list-disc pl-4">
                    {planCheck.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                )}

                {/* THE AUTHORING ECHO — the author sees the client's exact sentences at the one
                    moment they can still change them. Same rule as the MCP tool. */}
                {planCheck?.ok && planCheck.plan && (
                  <div className="text-xs bg-white border rounded-md p-2">
                    <div className="font-medium mb-1">The client will read, on the offer and in the signed contract:</div>
                    <ul className="space-y-0.5">
                      {planCheck.plan.map(p => (
                        <li key={p.seq} className="flex justify-between gap-3">
                          <span>{clientFacingPartLabel(p, planCheck.plan!.length)}</span>
                          {/* The wording alone hid a mistyped amount (a "1.750" that parsed as
                              €1.75 rendered an identical sentence). The figure is shown here
                              so the author checks the money, not just the words. */}
                          <span className="font-semibold whitespace-nowrap">
                            {currencySymbol}{p.amount.toLocaleString('en-US')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Let the CLIENT choose to split, BEFORE signing — distinct from the staff-authored
              plan above. Works with multi-option offers too (the split is computed from
              whichever option the client picks, after they pick it, before they sign) — that's
              the whole reason this exists as a separate, simpler toggle (Antonio, 2026-08-27,
              following the auto-charge council review). Mutually exclusive with the
              staff-authored plan above: one offer can't carry both a pre-decided split and a
              client-decided one.
              ⛔ REDESIGNED (council review, second pass, 2026-08-27): originally the client chose
              AFTER signing, which fabricated paid revenue against the full-amount invoice
              signing had already minted — see choose-payment-split/route.ts and
              docs/systems/offers.md for the incident. The choice now happens BEFORE signing, so
              the copy below must never again say "after signing". */}
          {!splitActive && (
            <div className="border rounded-md p-3 bg-zinc-50/60">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowSplitPaymentChoice}
                  onChange={e => setAllowSplitPaymentChoice(e.target.checked)}
                />
                Let the client choose to split the setup fee (50% now, 50% in 30 days, +5% fee) before they sign
              </label>
              {allowSplitPaymentChoice && (
                <p className="text-xs text-muted-foreground mt-1">
                  The client sees this as a choice right before they sign — after picking an option
                  if this is a multi-option offer, but before the contract is generated. You never
                  set an amount here; it&apos;s calculated from whatever price they end up owing.
                </p>
              )}
            </div>
          )}

          {/* Annual Rates */}
          {showAnnual && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">Annual Rates (Year 2+)</label>
                <select
                  value={installmentCurrency}
                  onChange={e => setInstallmentCurrency(e.target.value)}
                  className="px-2 py-1 text-xs border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">1st Installment (Jan)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-sm text-zinc-400">{installmentCurrencySymbol}</span>
                    <input
                      type="text"
                      value={installment1}
                      onChange={e => setInstallment1(e.target.value)}
                      // ⛔ NOT "1,000" (bug-hunter, full E2E QA, 2026-08-27): a numeric placeholder here
                      // reads as an already-filled value on an EMPTY, required, easy-to-miss field —
                      // confirmed live: staff can submit the whole offer believing this is set, only to
                      // be rejected by the packages validator with "missing the 1st (January) renewal
                      // installment amount". The per-option fields below (Multiple options) never had
                      // this problem — they use a descriptive hint, not a number. Matched here.
                      placeholder="1st (Jan)"
                      className="w-full pl-7 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">2nd Installment (Jun)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-sm text-zinc-400">{installmentCurrencySymbol}</span>
                    <input
                      type="text"
                      value={installment2}
                      onChange={e => setInstallment2(e.target.value)}
                      placeholder="2nd (Jun)"
                      className="w-full pl-7 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Multiple options (dev job 3c1bb5fa) — formation offers only, same gate as
              entity type / state above. Everything filled in above becomes "Option 1". */}
          {derivedContractType === 'formation' && (
            <div className="border rounded-md p-3 bg-zinc-50/60">
              <label className="block text-sm font-medium mb-1">Multiple options (optional)</label>
              <p className="text-xs text-muted-foreground mb-3">
                Everything above is Option 1. Add more complete options below — the client picks
                one on the offer page, and whichever they pick becomes the real price, state,
                company type, and renewal rate. Each option needs its own renewal amounts too.
              </p>
              {extraPackages.map((pkg, i) => {
                const pkgSymbol = pkg.currency === 'EUR' ? '€' : '$'
                const pkgInstSymbol = pkg.installmentCurrency === 'EUR' ? '€' : '$'
                const update = (patch: Partial<ExtraPackageDraft>) =>
                  setExtraPackages(prev => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)))
                return (
                  <div key={i} className="border rounded-md p-3 mb-2 bg-white space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-medium text-muted-foreground">Option {i + 2}</span>
                      <button
                        type="button"
                        onClick={() => setExtraPackages(prev => prev.filter((_, j) => j !== i))}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                    <div
                      className={`w-full px-2 py-1.5 text-sm border rounded-md bg-zinc-50 ${pkg.label ? 'text-zinc-900' : 'text-zinc-400 italic'}`}
                    >
                      {pkg.label || 'Label fills in automatically once you pick a company type and state below'}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-sm text-zinc-400">{pkgSymbol}</span>
                        <input
                          type="text"
                          placeholder="Setup price"
                          value={pkg.price}
                          onChange={e => update({ price: e.target.value })}
                          className="w-full pl-7 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <select
                        value={pkg.currency}
                        onChange={e => update({ currency: e.target.value as 'EUR' | 'USD' })}
                        className="px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="EUR">EUR (€)</option>
                        <option value="USD">USD ($)</option>
                      </select>
                    </div>
                    <div className="flex gap-2">
                      {[
                        { value: 'SMLLC', label: 'Single-Member LLC' },
                        { value: 'MMLLC', label: 'Multi-Member LLC' },
                        { value: 'Corp', label: 'C-Corp' },
                      ].map(opt => (
                        <label
                          key={opt.value}
                          className={`flex-1 text-center px-2 py-1.5 text-xs border rounded-md cursor-pointer ${
                            pkg.entityType === opt.value ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-zinc-200'
                          }`}
                        >
                          <input
                            type="radio"
                            className="sr-only"
                            checked={pkg.entityType === opt.value}
                            onChange={() => {
                              const entityType = opt.value as ExtraPackageDraft['entityType']
                              update({ entityType, label: formatOptionLabel(entityType, pkg.formationState) })
                            }}
                          />
                          {opt.label}
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      {FORMATION_STATE_CODES.map(code => (
                        <label
                          key={code}
                          className={`flex-1 text-center px-2 py-1.5 text-xs border rounded-md cursor-pointer ${
                            pkg.formationState === code ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-zinc-200'
                          }`}
                        >
                          <input
                            type="radio"
                            className="sr-only"
                            checked={pkg.formationState === code}
                            onChange={() => update({ formationState: code, label: formatOptionLabel(pkg.entityType, code) })}
                          />
                          {FORMATION_STATE_NAMES[code]}
                        </label>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-sm text-zinc-400">{pkgInstSymbol}</span>
                        <input
                          type="text"
                          placeholder="1st (Jan)"
                          value={pkg.installment1}
                          onChange={e => update({ installment1: e.target.value })}
                          className="w-full pl-7 pr-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-sm text-zinc-400">{pkgInstSymbol}</span>
                        <input
                          type="text"
                          placeholder="2nd (Jun)"
                          value={pkg.installment2}
                          onChange={e => update({ installment2: e.target.value })}
                          className="w-full pl-7 pr-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <select
                        value={pkg.installmentCurrency}
                        onChange={e => update({ installmentCurrency: e.target.value as 'EUR' | 'USD' })}
                        className="px-2 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                      </select>
                    </div>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() =>
                  setExtraPackages(prev => [
                    ...prev,
                    {
                      label: '',
                      price: '',
                      currency: currency as 'EUR' | 'USD',
                      entityType: '',
                      formationState: '',
                      installment1: '',
                      installment2: '',
                      installmentCurrency: installmentCurrency as 'EUR' | 'USD',
                    },
                  ])
                }
                className="text-xs text-blue-600 hover:underline"
              >
                + Add another option
              </button>
              {extraPackages.length > 0 && splitEnabled && (
                <p className="text-xs text-red-600 mt-2">
                  Multiple options can&apos;t be combined with paying the setup fee in parts — turn one off.
                </p>
              )}
              {extraPackages.length > 0 && extraPackages.some(p => p.entityType && p.entityType !== entityType) && (
                <p className="text-xs text-amber-600 mt-2">
                  ⚠ These options are different company types. The written description below (and
                  &quot;Generate with AI&quot;) is only written once, for Option 1 — the system does not
                  rewrite it per option. Keep the wording generic, or the client may read a signed
                  contract that describes the wrong company type for whichever option they picked.
                </p>
              )}
            </div>
          )}

          {/* Required Documents */}
          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-1.5">
              <Upload className="h-4 w-4 text-zinc-500" />
              Required Documents (for client to upload)
            </label>
            <div className="grid grid-cols-2 gap-2">
              {DOCUMENT_TYPES.map(doc => (
                <label
                  key={doc.id}
                  className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                    requiredDocs.includes(doc.id)
                      ? 'bg-orange-50 border-orange-300'
                      : 'bg-white border-zinc-200 hover:border-zinc-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={requiredDocs.includes(doc.id)}
                    onChange={() => toggleDoc(doc.id)}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-orange-600 focus:ring-orange-500"
                  />
                  <span className="text-xs">{doc.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Pre-conditions / Issues */}
          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Pre-conditions (issues to resolve before onboarding)
            </label>
            <div className="space-y-2">
              {PRECONDITION_PRESETS.map(preset => {
                const active = preconditions.find(p => p.id === preset.id)
                return (
                  <div key={preset.id}>
                    <div
                      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors cursor-pointer ${
                        active
                          ? 'bg-amber-50 border-amber-300'
                          : 'bg-white border-zinc-200 hover:border-zinc-300'
                      }`}
                      onClick={() => { if (!active) togglePrecondition(preset.id) }}
                    >
                      <input
                        type="checkbox"
                        checked={!!active}
                        onChange={() => togglePrecondition(preset.id)}
                        onClick={e => e.stopPropagation()}
                        className="h-4 w-4 rounded border-zinc-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span className={`flex-1 text-sm ${active ? 'font-medium text-zinc-900' : 'text-zinc-600'}`}>
                        {preset.name}
                      </span>
                      {active && (
                        <div className="relative" onClick={e => e.stopPropagation()}>
                          <span className="absolute left-2.5 top-1.5 text-sm text-zinc-400">{currencySymbol}</span>
                          <input
                            type="text"
                            value={active.price}
                            onChange={e => updatePreconditionPrice(preset.id, e.target.value)}
                            placeholder="0"
                            autoFocus
                            className="w-28 pl-6 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                          />
                        </div>
                      )}
                    </div>
                    {/* Custom name input for "Other" */}
                    {active && preset.id === 'custom' && (
                      <input
                        type="text"
                        value={active.customName || ''}
                        onChange={e => updatePreconditionName('custom', e.target.value)}
                        placeholder="Describe the issue..."
                        className="mt-1 w-full px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    )}
                  </div>
                )
              })}
            </div>
            {preconditionsTotalAmount > 0 && (
              <div className="flex justify-between items-center bg-amber-50 rounded-lg p-2 mt-2">
                <span className="text-xs font-medium text-amber-800">Pre-conditions subtotal</span>
                <span className="text-sm font-bold text-amber-900">{currencySymbol}{preconditionsTotalAmount.toLocaleString('en-US')}</span>
              </div>
            )}
          </div>

          {/* Admin Notes (internal only) */}
          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-1.5">
              <StickyNote className="h-4 w-4 text-zinc-500" />
              Admin Notes (internal -- not shown to client)
            </label>
            <textarea
              value={adminNotes}
              onChange={e => setAdminNotes(e.target.value)}
              rows={3}
              placeholder="Internal notes about this offer, pricing decisions, call context..."
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* Narrative Content (client-facing, AI-assisted) */}
          <div className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-50 to-blue-50 border-b">
              <button
                type="button"
                onClick={() => setNarrativeOpen(!narrativeOpen)}
                className="flex items-center gap-2 text-sm font-semibold text-violet-900"
              >
                <Sparkles className="h-4 w-4 text-violet-500" />
                Client-Facing Narrative
                {(introEn || introIt) && <span className="text-xs font-normal text-violet-600 bg-violet-100 px-1.5 py-0.5 rounded">has content</span>}
                {narrativeOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={generateNarrative}
                disabled={narrativeLoading || selected.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                {narrativeLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {narrativeLoading ? 'Generating...' : 'Generate with AI'}
              </button>
            </div>
            {narrativeOpen && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-[10px] text-zinc-400">These sections appear on the client-facing offer page. Edit freely — AI-generated content is a starting point.</p>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Introduction (English)</label>
                  <textarea value={introEn} onChange={e => setIntroEn(e.target.value)} rows={3} placeholder="Personalized introduction for the client..." className="w-full mt-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Introduction (Italian)</label>
                  <textarea value={introIt} onChange={e => setIntroIt(e.target.value)} rows={3} placeholder="Introduzione personalizzata per il cliente..." className="w-full mt-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Immediate Actions <span className="font-normal text-zinc-400">(JSON array)</span></label>
                  <textarea value={immediateActionsJson} onChange={e => setImmediateActionsJson(e.target.value)} rows={3} placeholder='[{"title": "...", "description": "..."}]' className="w-full mt-1 px-3 py-2 text-xs font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Strategy <span className="font-normal text-zinc-400">(JSON array)</span></label>
                  <textarea value={strategyJson} onChange={e => setStrategyJson(e.target.value)} rows={3} placeholder='[{"step_number": 1, "title": "...", "description": "..."}]' className="w-full mt-1 px-3 py-2 text-xs font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Next Steps <span className="font-normal text-zinc-400">(JSON array)</span></label>
                  <textarea value={nextStepsJson} onChange={e => setNextStepsJson(e.target.value)} rows={3} placeholder='[{"step_number": 1, "title": "...", "description": "..."}]' className="w-full mt-1 px-3 py-2 text-xs font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-700">Future Developments <span className="font-normal text-zinc-400">(JSON array)</span></label>
                  <textarea value={futureDevJson} onChange={e => setFutureDevJson(e.target.value)} rows={2} placeholder='[{"text": "..."}]' className="w-full mt-1 px-3 py-2 text-xs font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" />
                </div>
                {(introEn || introIt || strategyJson || nextStepsJson) && (
                  <div className="border border-violet-200 rounded-lg bg-violet-50/50 p-3 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-900">
                      <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                      Discuss with AI
                      <span className="font-normal text-violet-500">— ask for a change (e.g. &ldquo;shorten the intro&rdquo;, &ldquo;drop step 3&rdquo;)</span>
                    </div>
                    {refineMessages.length > 0 && (
                      <div className="max-h-40 overflow-y-auto space-y-1.5 text-xs">
                        {refineMessages.map((m, i) => (
                          <div key={i} className={m.role === 'you' ? 'text-right' : 'text-left'}>
                            <span className={`inline-block px-2 py-1 rounded-md ${m.role === 'you' ? 'bg-violet-600 text-white' : 'bg-white border text-zinc-700'}`}>
                              {m.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <textarea
                        value={refineInput}
                        onChange={e => setRefineInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); refineNarrative() } }}
                        disabled={refineLoading}
                        rows={3}
                        placeholder="Tell the AI what to change, or give it context about the client… (⌘/Ctrl+Enter to send)"
                        className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 resize-y min-h-[64px] max-h-56"
                      />
                      <button type="button" onClick={refineNarrative} disabled={refineLoading || !refineInput.trim()} className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 shrink-0">
                        {refineLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        {refineLoading ? 'Working...' : 'Send'}
                      </button>
                    </div>
                    <p className="text-[10px] text-violet-400">Give it context about the client or ask for a change. It only edits what you ask, keeps your other edits, and won&rsquo;t promise services that aren&rsquo;t in the offer.</p>
                  </div>
                )}
                {(introEn || strategyJson) && (
                  <button type="button" onClick={() => { setIntroEn(''); setIntroIt(''); setStrategyJson(''); setNextStepsJson(''); setFutureDevJson(''); setImmediateActionsJson(''); setRefineMessages([]) }} className="text-xs text-red-500 hover:text-red-700">
                    Clear all narrative content
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Auto-derived summary */}
          {selected.length > 0 && (
            <div className="bg-blue-50 rounded-lg p-3 text-sm space-y-1">
              <p className="font-medium text-blue-900">Auto-derived:</p>
              <p className="text-xs text-blue-800">
                Contract: <span className="font-medium">{derivedContractType}</span>
              </p>
              <p className="text-xs text-blue-800">
                Pipelines: <span className="font-medium">{derivedPipelines.join(', ') || 'none'}</span>
              </p>
              {(paymentType === 'checkout' || paymentType === 'both') && (
                <p className="text-xs text-blue-800">
                  {paymentType === 'both'
                    ? `Client will see both options: bank transfer + card via ${paymentGateway === 'whop' ? 'Whop' : 'Stripe'} (+5%)`
                    : `${paymentGateway === 'whop' ? 'Whop' : 'Stripe'} checkout link (+5% card fee)`}
                </p>
              )}
              <p className="text-xs text-blue-800">
                Bank: <span className="font-medium">{BANK_OPTIONS.find(b => b.value === bankPreference)?.label}</span>
              </p>
              {requiredDocs.length > 0 && (
                <p className="text-xs text-blue-800">
                  Docs required: <span className="font-medium">{requiredDocs.length}</span>
                </p>
              )}
              {preconditions.length > 0 && (
                <p className="text-xs text-blue-800">
                  Pre-conditions: <span className="font-medium">{preconditions.length} ({currencySymbol}{preconditionsTotalAmount.toLocaleString('en-US')})</span>
                </p>
              )}
              {adminNotes.trim() && (
                <p className="text-xs text-blue-800">
                  Admin notes: <span className="font-medium">included</span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t">
          {createdOfferUrl ? (
            <>
              <div className="flex items-center gap-2 text-sm text-emerald-700 mr-auto">
                <CheckCircle2 className="h-4 w-4" />
                Offer created
              </div>
              <a
                href={`${createdOfferUrl}?preview=td`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md border border-blue-600 text-blue-600 hover:bg-blue-50"
              >
                <ExternalLink className="h-4 w-4" />
                Preview Offer
              </a>
              <button
                onClick={() => { setCreatedOfferUrl(null); onClose() }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  // Pre-submit validation — mirrors checks inside handleSubmit so the
                  // confirm modal never opens for invalid input.
                  if (selected.length === 0) {
                    toast.error('Select at least one service')
                    return
                  }
                  const withPrices = selected.filter(s => s.price.trim())
                  if (withPrices.length === 0) {
                    toast.error('Enter a price for at least one service')
                    return
                  }
                  if (bankCurrencyMismatch) {
                    toast.error(`Bank/currency mismatch: ${bankCurrencyMismatch.bankLabel} is ${bankCurrencyMismatch.expected}-only`)
                    return
                  }
                  if (splitBlockReason) {
                    toast.error(splitBlockReason)
                    return
                  }
                  setShowConfirm(true)
                }}
                disabled={isPending || selected.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Review &amp; Confirm
              </button>
            </>
          )}
        </div>
      </div>

      {/* Confirm-on-submit modal — final sanity check on currency/bank/amount
          before the offer is created. Catches the class of mistakes like
          "EUR services shipped with a Mercury USD bank block". */}
      {showConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center gap-2 px-5 py-4 border-b">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="text-base font-semibold">Review Draft Details</h3>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm">
              <p className="text-xs text-zinc-500">
                Review before creating the draft. The client will <strong>NOT</strong> see this until you send it.
              </p>
              <dl className="space-y-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Client</dt>
                  <dd className="font-medium text-right truncate">{clientNameValue}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Language</dt>
                  <dd className="font-medium">{language === 'it' ? 'Italian' : 'English'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Contract</dt>
                  <dd className="font-medium">{derivedContractType}</dd>
                </div>
                <div className="flex justify-between items-center gap-3 bg-blue-50 rounded px-2 py-1.5">
                  <dt className="text-zinc-600 font-medium">Amount</dt>
                  <dd className="text-lg font-bold text-blue-700">
                    {currencySymbol}{totalAmount.toLocaleString('en-US')} {currency}
                  </dd>
                </div>
                {/* The split is MONEY and it was invisible on the last screen before Create
                    (bug-hunter, 2026-08-13) — an author could confirm an offer without ever
                    being shown the schedule they had authored. Amounts included on purpose:
                    the client-facing echo renders wording only, so this is the one place a
                    mistyped figure can actually be SEEN before it reaches a client. */}
                {splitActive && planCheck?.ok && planCheck.plan && (
                  <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    <dt className="text-zinc-600 font-medium mb-1">Paid in parts</dt>
                    <dd>
                      <ul className="space-y-0.5">
                        {planCheck.plan.map(p => (
                          <li key={p.seq} className="flex justify-between gap-3">
                            <span className="text-zinc-600">{clientFacingPartLabel(p, planCheck.plan!.length)}</span>
                            <span className="font-bold text-amber-800 whitespace-nowrap">
                              {currencySymbol}{p.amount.toLocaleString('en-US')}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-zinc-500 mt-1">
                        Only part 1 is invoiced at signing. You raise the rest by hand.
                      </p>
                    </dd>
                  </div>
                )}
                <div className="flex justify-between items-center gap-3 bg-blue-50 rounded px-2 py-1.5">
                  <dt className="text-zinc-600 font-medium">Bank</dt>
                  <dd className="font-bold text-blue-700">
                    {BANK_OPTIONS.find(b => b.value === bankPreference)?.label}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Payment</dt>
                  <dd className="font-medium">{PAYMENT_TYPES.find(p => p.value === paymentType)?.label}</dd>
                </div>
                {(paymentType === 'checkout' || paymentType === 'both') && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500">Gateway</dt>
                    <dd className="font-medium capitalize">{paymentGateway}</dd>
                  </div>
                )}
              </dl>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-3">
                ⚠ Once the client opens this offer, changing currency or bank means re-creating it. Make sure the amount currency and bank account match.
              </p>
            </div>
            <div className="flex justify-end gap-3 px-5 py-4 border-t">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={isPending}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
              >
                Go Back
              </button>
              <button
                onClick={() => { setShowConfirm(false); handleSubmit() }}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Create Draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Service row component ──
const SERVICE_CONTEXT_OPTIONS = [
  { value: 'business', label: 'Business', color: 'text-blue-700 bg-blue-50' },
  { value: 'individual', label: 'Individual', color: 'text-emerald-700 bg-emerald-50' },
  { value: 'ask', label: 'Ask client', color: 'text-amber-700 bg-amber-50' },
] as const

function ServiceRow({
  service,
  isSelected,
  price,
  quantity,
  serviceContext,
  currencySymbol,
  onToggle,
  onPriceChange,
  onQuantityChange,
  onContextChange,
}: {
  service: { id: string; name: string; supports_quantity: boolean }
  isSelected: boolean
  price: string
  quantity: number
  serviceContext: 'individual' | 'business' | 'ask'
  currencySymbol: string
  onToggle: () => void
  onPriceChange: (price: string) => void
  onQuantityChange: (quantity: number) => void
  onContextChange: (ctx: 'individual' | 'business' | 'ask') => void
}) {
  const unitPrice = parsePriceQuirk(price)
  const lineTotal = unitPrice > 0 && quantity > 1
    ? `= ${currencySymbol}${(unitPrice * quantity).toLocaleString('en-US')}`
    : null

  return (
    <div
      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors cursor-pointer ${
        isSelected
          ? 'bg-blue-50 border-blue-300'
          : 'bg-white border-zinc-200 hover:border-zinc-300'
      }`}
      onClick={() => { if (!isSelected) onToggle() }}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggle}
        onClick={e => e.stopPropagation()}
        className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
      />
      <span className={`flex-1 text-sm ${isSelected ? 'font-medium text-zinc-900' : 'text-zinc-600'}`}>
        {service.name}
      </span>
      {isSelected && (
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <select
            value={serviceContext}
            onChange={e => onContextChange(e.target.value as 'individual' | 'business' | 'ask')}
            className={`text-xs font-medium px-2 py-1 rounded-md border-0 cursor-pointer focus:ring-2 focus:ring-blue-500 ${
              SERVICE_CONTEXT_OPTIONS.find(o => o.value === serviceContext)?.color || ''
            }`}
          >
            {SERVICE_CONTEXT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {/* Quantity input — only for services that support it (e.g. ITIN) */}
          {service.supports_quantity && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={10}
                value={quantity}
                onChange={e => onQuantityChange(parseInt(e.target.value, 10) || 1)}
                className="w-14 px-2 py-1.5 text-sm text-center border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                title="Quantity"
              />
              {lineTotal && (
                <span className="text-xs text-zinc-500 whitespace-nowrap">{lineTotal}</span>
              )}
            </div>
          )}
          <div className="relative">
            <span className="absolute left-2.5 top-1.5 text-sm text-zinc-400">{currencySymbol}</span>
            <input
              type="text"
              value={price}
              onChange={e => onPriceChange(e.target.value)}
              placeholder="0"
              autoFocus
              className="w-28 pl-6 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      )}
    </div>
  )
}
