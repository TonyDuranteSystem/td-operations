-- UNDO for 20261019-2000-marketing-meta-connection.sql. Drops the stored (encrypted) Page key. Lead intake then uses the Vercel setting again.
DROP TABLE IF EXISTS marketing_meta_connection;
