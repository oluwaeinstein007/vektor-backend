-- NW-003: packages/db migration 0007_whole_alice.sql does
--   GRANT SELECT, INSERT ON "audit_log" TO "vektor_app";
-- but nothing in the repo ever creates that role. The only place it got
-- created was packages/db/tests/rls.test.ts, at test time, against whatever
-- database happened to be running — so `pnpm db:migrate` against a genuinely
-- fresh Postgres failed at migration 0007 with:
--     ERROR: role "vektor_app" does not exist
--
-- Postgres images run every .sql in /docker-entrypoint-initdb.d once, on
-- first initialisation of an empty data directory. Creating the role here
-- makes the migration chain apply cleanly from zero.
--
-- This is a DEV password. ADR-0011 is explicit that RLS on audit_log is
-- defence-in-depth, not the primary control, and that a superuser or the
-- table owner bypasses it — a real deployment provisions this role through
-- Vault (INFRA-010), never from a file in the repo.
CREATE ROLE vektor_app LOGIN PASSWORD 'vektor_app_dev_password';
GRANT CONNECT ON DATABASE vektor TO vektor_app;
