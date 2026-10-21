-- Undo of 20261021-1900-team-invoice-options-keep-existing.sql: removes the two keys from every team member.
UPDATE portal_team_members
SET capabilities = capabilities - 'payment_links' - 'invoice_history'
WHERE capabilities ? 'payment_links' OR capabilities ? 'invoice_history';
