"use client"

/** Public one-time bank-account application page (dev job 11d484a4). All the behaviour lives in the shared form component. */

import { useParams } from "next/navigation"
import { BankApplicationForm } from "@/components/forms/bank-application-form"

export default function BankApplicationPage() {
  const { token } = useParams<{ token: string }>()
  return <BankApplicationForm token={token} />
}
