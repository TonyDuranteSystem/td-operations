'use client'

interface LeadLifecycleBarProps {
  leadStatus: string | null
  callDate: string | null
  offerStatus: string | null
  offerViewedAt: string | null
  signedAt: string | null
  activationStatus: string | null
  paymentConfirmedAt: string | null
  convertedToContactId: string | null
}

interface Stage {
  key: string
  label: string
  completed: boolean
  current: boolean
}

function computeStages(props: LeadLifecycleBarProps): Stage[] {
  const {
    leadStatus,
    callDate,
    offerStatus,
    offerViewedAt,
    signedAt,
    activationStatus,
    paymentConfirmedAt,
    convertedToContactId,
  } = props

  const isLost = leadStatus === 'Lost'
  const isSuspended = leadStatus === 'Suspended'

  const offerExists = !!offerStatus
  const offerSent = offerExists && offerStatus !== 'draft'
  const offerViewed = offerSent && (!!offerViewedAt || offerStatus === 'viewed' || offerStatus === 'signed' || offerStatus === 'completed')
  const offerSigned = !!signedAt || offerStatus === 'signed' || offerStatus === 'completed'
  const paid = !!paymentConfirmedAt || activationStatus === 'activated' || activationStatus === 'payment_confirmed'
  const activated = activationStatus === 'activated' || !!convertedToContactId

  const stages: Stage[] = [
    { key: 'lead', label: 'Lead', completed: true, current: false },
    { key: 'call', label: 'Call', completed: !!callDate || ['Call Done', 'Qualified', 'Offer Sent', 'Negotiating', 'Converted', 'Paid'].includes(leadStatus || ''), current: false },
    { key: 'offer', label: 'Offer', completed: offerExists, current: false },
    { key: 'sent', label: 'Sent', completed: offerSent, current: false },
    { key: 'viewed', label: 'Viewed', completed: offerViewed, current: false },
    { key: 'signed', label: 'Signed', completed: offerSigned, current: false },
    { key: 'paid', label: 'Paid', completed: paid, current: false },
    { key: 'active', label: 'Active', completed: activated, current: false },
  ]

  // Mark the current stage (last completed or first incomplete)
  if (!isLost && !isSuspended) {
    let lastCompleted = -1
    for (let i = stages.length - 1; i >= 0; i--) {
      if (stages[i].completed) { lastCompleted = i; break }
    }
    if (lastCompleted >= 0) {
      stages[lastCompleted].current = true
    }
  }

  return stages
}

export function LeadLifecycleBar(props: LeadLifecycleBarProps) {
  const stages = computeStages(props)
  const isLost = props.leadStatus === 'Lost'
  const isSuspended = props.leadStatus === 'Suspended'

  return (
    <div className="bg-white rounded-lg border px-5 py-3 mb-6">
      <div className="flex items-center gap-0">
        {stages.map((stage, i) => (
          <div key={stage.key} className="flex items-center flex-1 last:flex-none">
            {/* Stage dot + label */}
            <div className="flex flex-col items-center gap-1 min-w-0">
              <div
                className={`w-3 h-3 rounded-full border-2 transition-colors ${
                  isLost || isSuspended
                    ? stage.completed
                      ? 'bg-zinc-300 border-zinc-400'
                      : 'bg-white border-zinc-200'
                    : stage.current
                      ? 'bg-blue-600 border-blue-600 ring-4 ring-blue-100'
                      : stage.completed
                        ? 'bg-emerald-500 border-emerald-500'
                        : 'bg-white border-zinc-300'
                }`}
              />
              <span
                className={`text-[11px] font-medium leading-tight ${
                  isLost || isSuspended
                    ? 'text-zinc-400'
                    : stage.current
                      ? 'text-blue-700'
                      : stage.completed
                        ? 'text-emerald-700'
                        : 'text-zinc-400'
                }`}
              >
                {stage.label}
              </span>
            </div>
            {/* Connector line */}
            {i < stages.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-1 mt-[-14px] ${
                  isLost || isSuspended
                    ? 'bg-zinc-200'
                    : stages[i + 1].completed
                      ? 'bg-emerald-400'
                      : stage.completed
                        ? 'bg-blue-200'
                        : 'bg-zinc-200'
                }`}
              />
            )}
          </div>
        ))}
      </div>
      {(isLost || isSuspended) && (
        <p className={`text-[11px] font-medium mt-1 text-center ${isLost ? 'text-zinc-500' : 'text-yellow-600'}`}>
          {isLost ? 'Lead Lost' : 'Suspended'}
        </p>
      )}
    </div>
  )
}
