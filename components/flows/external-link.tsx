import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { resolveSecretaryOfStateLink } from '@/lib/flows/state-links'

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
}

/**
 * Prominent external link button. Two modes:
 *  - literal `url` present → open it directly (Harbor Compliance case).
 *  - no `url` → resolve the Secretary of State portal from the account's state.
 *    New Mexico has no annual report (shows a note instead of a dead link);
 *    unrecognized/unmapped states show a muted "not available" note.
 */
export function ExternalLinkCard({ label, url, stateOfFormation }: ExternalLinkCardProps) {
  // Mode 1 — explicit URL from the layout.
  if (url) {
    return <LinkButton href={url} label={label || 'Open link'} />
  }

  // Mode 2 — resolve the Secretary of State portal from the account's state.
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
