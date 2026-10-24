-- READ ONLY catalogs. Run manually in the intended project before authorizing V1.
-- No user rows, JWTs, Auth keys, passwords or financial data are selected.
BEGIN TRANSACTION READ ONLY;
SELECT current_database(),current_user,session_user,current_setting('server_version');
DO $$ BEGIN
  IF to_regclass('pos.profiles') IS NULL THEN RAISE EXCEPTION 'FOUNDATION_MISSING'; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND
    (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'UNSAFE_POS_OWNER';
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','pos_app','pos_scheduler')
    AND pg_has_role(oid,'pos_owner','MEMBER')) THEN RAISE EXCEPTION 'UNSAFE_OWNER_MEMBERSHIP'; END IF;
  IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN
    RAISE EXCEPTION 'UNSAFE_OWNER_CREATE';
  END IF;
END $$;
SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls
FROM pg_roles WHERE rolname IN ('pos_owner','authenticated','anon','pos_app','pos_scheduler','authenticator');
SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl FROM pg_namespace WHERE nspname IN ('pos','public','auth');
SELECT schemaname,tablename,tableowner,rowsecurity FROM pg_tables WHERE schemaname='pos' ORDER BY tablename;
SELECT r.rolname,c.oid::regclass AS relation,
  has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS unsafe_direct_access
FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE r.rolname IN ('anon','authenticated','pos_app','pos_scheduler') AND n.nspname='pos' AND c.relkind IN ('r','v');
SELECT p.oid::regprocedure AS signature,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE (n.nspname='public' AND p.proname IN ('cai_current_profile','cai_catalog','cai_operations','cai_report'))
  OR (n.nspname='pos' AND p.proname='current_profile_auth_uid');
DO $$ DECLARE v_version text; v_applied boolean; BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE NOTICE 'NO_MIGRATION_HISTORY_TABLE: inspect objects and manual execution history';
  ELSE
    FOREACH v_version IN ARRAY ARRAY['20261023000100','20261023000200','20261023000300','20261023000400',
      '20261023000500','20261023000600','20261023000700','20261023000800'] LOOP
      EXECUTE 'SELECT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version=$1)' INTO v_applied USING v_version;
      RAISE NOTICE 'Version %, recorded %',v_version,v_applied;
    END LOOP;
  END IF;
END $$;
COMMIT;
-- Exposed schemas are an external Data API setting: verify public and exclude pos.
-- Absence of migration history does not prove absence of prior SQL Editor changes.
