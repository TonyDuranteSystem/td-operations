-- UNDO for 20261019-1000-marketing-leads.sql. Drops the three lead tables (and every lead stored in them). Run only on purpose.
DROP TABLE IF EXISTS marketing_lead_events;
DROP TABLE IF EXISTS marketing_leadgen_events;
DROP TABLE IF EXISTS marketing_leads;
