-- READ ONLY. Run manually in the intended Supabase project after authorization.
-- Catalogs only: no customer data, tokens, Auth passwords or table contents.
BEGIN TRANSACTION READ ONLY;
SELECT current_user, session_user, current_setting('server_version') AS version;

SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname IN ('pos_owner','pos_app','pos_scheduler','authenticated','anon','authenticator');

-- All memberships involving the owner or browser roles need review, including
-- indirect membership. authenticated/anon must never inherit/set pos_owner.
SELECT r.rolname AS browser_role,
  pg_has_role(r.oid, 'pos_owner', 'MEMBER') AS unsafe_owner_membership,
  has_schema_privilege(r.oid, 'pos', 'CREATE') AS unsafe_pos_create,
  has_schema_privilege(r.oid, 'public', 'CREATE') AS unsafe_public_create,
  has_table_privilege(r.oid, 'pos.profiles', 'SELECT') AS unsafe_profile_read,
  has_table_privilege(r.oid, 'pos.profiles', 'UPDATE') AS unsafe_profile_write
FROM pg_roles r WHERE r.rolname IN ('authenticated','anon','pos_app','pos_scheduler');

SELECT p.oid::regprocedure AS signature, pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer, p.provolatile, p.proconfig,
  pg_get_function_result(p.oid) AS result, p.proacl,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='cai_current_profile';
-- Expected: exactly one zero-argument RPC, owner pos_owner, stable, fixed path,
-- no arbitrary SQL, own active profile only, four allowed output fields.

SELECT r.rolname, has_function_privilege(r.oid,'public.cai_current_profile()','EXECUTE') AS can_execute
FROM pg_roles r WHERE r.rolname IN ('authenticated','anon','service_role','pos_app','pos_scheduler');
-- Only authenticated should be true (owner/admin privileges are separate).

-- Inventory every reachable SECURITY DEFINER in public; review each definition
-- in the dashboard, especially functions that accept SQL or set request claims.
SELECT p.oid::regprocedure AS signature, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.prokind='f';

-- pos contains legitimate staff RPC grants from migration 004. These must stay
-- outside the exposed Data API schemas; administrative helpers must not be executable.
SELECT p.oid::regprocedure AS signature, p.prosecdef, p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pos';
SELECT nspname, nspacl FROM pg_namespace WHERE nspname IN ('pos','public','auth');
SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname='pos';
SELECT has_schema_privilege('pos_owner','public','CREATE') AS unsafe_owner_create,
  has_function_privilege('pos_owner','auth.uid()','EXECUTE') AS auth_uid_available;
-- Private bridge: expected owner is migration administrator (normally postgres),
-- NOT pos_owner. SECURITY DEFINER, STABLE, fixed path, body only SELECT auth.uid().
SELECT pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig, proacl,
  pg_get_functiondef(oid) AS definition
FROM pg_proc WHERE oid='pos.current_profile_auth_uid()'::regprocedure;
SELECT r.rolname,
  has_function_privilege(r.oid,'pos.current_profile_auth_uid()','EXECUTE') AS bridge_execute
FROM pg_roles r WHERE r.rolname IN
  ('pos_owner','anon','authenticated','service_role','pos_app','pos_scheduler');
-- Only pos_owner true, excluding the bridge owner/admin's inherent privileges.
SELECT has_schema_privilege('pos_owner','pos','CREATE') AS unsafe_bridge_replacement;
SELECT schemaname, tablename, tableowner FROM pg_tables WHERE schemaname='pos';
COMMIT;
-- Data API exposed schemas are also a Supabase dashboard/service setting.
-- Catalog output alone cannot prove pos is unexposed. Verify that setting.
