-- READ ONLY. Prepared for a future authorized review; not run against Supabase.
-- Run with the intended migration administrator, never a browser/service key.
BEGIN TRANSACTION READ ONLY;
SELECT current_user AS migration_role, session_user AS connection_role,
  current_setting('server_version') AS postgres_version,
  current_setting('transaction_isolation') AS isolation,
  current_setting('TimeZone') AS session_timezone;
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls
FROM pg_roles WHERE rolname IN (current_user, 'authenticator', 'anon', 'authenticated',
  'service_role', 'pos_owner', 'pos_app', 'pos_scheduler');
SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
  has_schema_privilege(current_user, 'auth', 'USAGE') AS auth_schema_usage,
  has_table_privilege(current_user, 'auth.users', 'REFERENCES') AS can_reference_auth_users;
SELECT parent.rolname AS granted_role, child.rolname AS member_role,
  m.admin_option, pg_has_role(child.oid, parent.oid, 'USAGE') AS inherits_privileges
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
JOIN pg_roles child ON child.oid=m.member
WHERE parent.rolname IN ('pos_owner','pos_app','pos_scheduler','authenticated')
  OR child.rolname IN ('pos_owner','pos_app','pos_scheduler');
SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl
FROM pg_namespace WHERE nspname IN ('pos','auth');
COMMIT;
