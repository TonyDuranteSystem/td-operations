/**
 * The yearly steps that start when an installment is PAID (dev job bea928e0).
 *
 * Normally they run when staff or the bank feed mark the invoice paid (lib/operations/payment.ts). But an installment that the
 * client's credit covers completely is born already Paid — nobody marks it paid afterwards, so those steps (January: the four
 * recurring services; June: lifting the tax-return gate) never ran for an installment raised from the company page. The June
 * cron already compensates for its own invoices; this is the same for the manual button.
 *
 * Same rule as the payment path: only a Client company runs them.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { installmentNumberOf } from "@/lib/billing/installment-invoice-key"
import { onFirstInstallmentPaid, onSecondInstallmentPaid } from "@/lib/installment-handler"

export interface InstallmentPaidStepsResult {
  ran: boolean
  reason?: string
  /** Names of steps that reported an error (empty when everything ran clean). */
  failedSteps: string[]
}

export async function runInstallmentPaidSteps(args: {
  accountId: string
  installment: string
  year: number
}): Promise<InstallmentPaidStepsResult> {
  const number = installmentNumberOf(args.installment)
  if (!number) return { ran: false, reason: "not one of the two installments", failedSteps: [] }

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("account_type")
    .eq("id", args.accountId)
    .single()
  if (account?.account_type !== "Client") {
    return { ran: false, reason: `account type is ${account?.account_type || "unknown"}, not Client`, failedSteps: [] }
  }

  const outcome = number === 1
    ? await onFirstInstallmentPaid(args.accountId, args.year)
    : await onSecondInstallmentPaid(args.accountId, args.year)
  const failedSteps = (outcome.steps ?? []).filter((s) => s.status === "error").map((s) => s.step)
  return { ran: true, failedSteps }
}
