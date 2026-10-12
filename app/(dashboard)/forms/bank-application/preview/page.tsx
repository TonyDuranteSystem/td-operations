/**
 * /forms/bank-application/preview — staff view of the bank application form, exactly as the client
 * sees it, with nothing saved or sent. Sits under the dashboard group, so the staff session gate
 * and the /forms admin-only rule protect it.
 */

import { BankApplicationForm } from "@/components/forms/bank-application-form"

export default function BankApplicationPreviewPage() {
  return (
    <div className="p-6">
      <BankApplicationForm token="preview" preview />
    </div>
  )
}
