// Kill switches for the lead window features that change records or reach clients (dev job 6fc63c52).
// Both default OFF: shipping the code changes nothing until Antonio turns a switch on in the host's environment.
//
//   LEAD_AUTO_CALL_DONE=true   a recording may move a lead Call Scheduled -> Call Done by itself.
//                              While OFF the same decision is only LOGGED (a lead_status_moves row with reason
//                              'dry_run_auto_call_done', no status change), so he can see what would have moved.
//   LEAD_WINDOW_SEND=true      the follow-up draft panel may send (email / WhatsApp). While OFF it can still write
//                              drafts and rewrite them; the person copies the text and sends it by hand.

export function autoCallDoneEnabled(): boolean {
  return process.env.LEAD_AUTO_CALL_DONE === 'true'
}

export function leadSendEnabled(): boolean {
  return process.env.LEAD_WINDOW_SEND === 'true'
}
