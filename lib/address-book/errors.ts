/** Address book: an error whose words are meant for the person at the screen (R099). The routes hand `message` and `status` straight back. */
export class AddressBookError extends Error {
  status: number
  extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = "AddressBookError"
    this.status = status
    this.extra = extra
  }
}

export function isAddressBookError(e: unknown): e is AddressBookError {
  return e instanceof Error && e.name === "AddressBookError"
}
