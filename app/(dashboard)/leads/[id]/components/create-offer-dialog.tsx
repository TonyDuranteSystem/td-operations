'use client'

/**
 * Re-exports the shared CreateOfferDialog for use on the Lead detail page.
 * This thin wrapper maps lead-specific props to the generic dialog.
 */

import { CreateOfferDialog as SharedCreateOfferDialog } from '@/components/offers/create-offer-dialog'

interface CreateOfferDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
  leadEmail: string
  leadLanguage?: string | null
  leadReferrer?: string | null
  leadReferrerType?: string | null
}

export function CreateOfferDialog({
  open,
  onClose,
  leadId,
  leadName,
  leadEmail,
  leadLanguage,
  leadReferrer,
  leadReferrerType,
}: CreateOfferDialogProps) {
  return (
    <SharedCreateOfferDialog
      open={open}
      onClose={onClose}
      leadId={leadId}
      clientName={leadName}
      clientEmail={leadEmail}
      clientLanguage={leadLanguage}
      referrerName={leadReferrer}
      referrerType={leadReferrerType}
    />
  )
}
