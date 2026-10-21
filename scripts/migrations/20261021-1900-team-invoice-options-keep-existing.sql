-- Dev job e5d5400d (2026-10-21). Two new owner-ticked options for team members with Invoices & Billing:
--   payment_links   = may add / change / remove the company's payment links
--   invoice_history = may see invoices and expenses saved before they joined
-- Until now a team member with invoices_billing could already do both. So that nobody loses what they have today,
-- every EXISTING team member who has invoices_billing keeps both options. Only people invited from now on start without them.
-- Data only (no schema change). Safe to run twice.
UPDATE portal_team_members
SET capabilities = capabilities || '{"payment_links": true, "invoice_history": true}'::jsonb
WHERE (capabilities ->> 'invoices_billing') = 'true';
