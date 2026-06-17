import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { resolveSecretaryOfStateLink, resolveFormationFilingLink } from '@/lib/flows/state-links'

interface ExternalLinkCardProps {
  /** Button label from stage_layout, e.g. "File on Secretary of State Portal". */
  label?: string
  /**
   * Literal URL from stage_layout (e.g. the Harbor Compliance portal on the RA
   * "Renewal Due" stage). When absent, the link is resolved dynamically from the
   * account's state_of_formation — the Secretary of State filing portal — since
   * stage_layout JSON can't hold per-account logic.
   */
  url?: string
  /** Account state_of_formation, used for dynamic SoS resolution. */
  stateOfFormation?: string | null
  /** SD service_type — Company Formation uses the formation-filing portal map. */
  serviceType?: string
}

/**
 * Prominent external link button. Modes:
 *  - literal `url` present → open it directly (Harbor Compliance case).
 *  - Company Formation, no `url` → the formation-filing / name-search portal,
 *    resolved from state and ALWAYS available (defaults to New Mexico).
 *  - otherwise, no `url` → the annual-report Secretary of State portal from the
 *    account's state (NM has no annual report; unmapped states show a note).
 */
export function ExternalLinkCard({ label, url, stateOfFormation, serviceType }: ExternalLinkCardProps) {
  // Mode 1 — explicit URL from the layout.
  if (url) {
    return <LinkButton href={url} label={label || 'Open link'} />
  }

  // Mode 2 — Company Formation: the formation-filing portal (always resolves).
  if (serviceType === 'Company Formation') {
    const f = resolveFormationFilingLink(stateOfFormation)
    return (
      <div>
        <LinkButton href={f.url} label={label || 'Open the Secretary of State site'} />
        {f.defaulted && (
          <p className="mt-1.5 text-[11px] text-zinc-400">
            Defaulted to New Mexico — set the account&apos;s state of formation for the exact state portal.
          </p>
        )}
      </div>
    )
  }

  // Mode 3 — resolve the annual-report Secretary of State portal from the state.
  const resolved = resolveSecretaryOfStateLink(stateOfFormation)

  if (resolved.url) {
    return <LinkButton href={resolved.url} label={label || 'File on Secretary of State Portal'} />
  }

  if (resolved.noAnnualReport) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
        New Mexico has no annual report — nothing to file with the Secretary of State.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
      No Secretary of State filing link is configured for this state
      {resolved.stateCode ? ` (${resolved.stateCode})` : ''}.
    </div>
  )
}

function LinkButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700"
    >
      <ExternalLinkIcon className="h-4 w-4" />
      {label}
    </a>
  )
}
