-- Read-only metadata for Worker V1 preparation. No RPC/business operation runs.
-- Intended for the Management API read-only endpoint or a read-only session.
WITH required(signature) AS (VALUES
  ('public.cai_current_profile()'), ('public.cai_catalog(text,jsonb,text)'),
  ('public.cai_operations(text,jsonb,text)'), ('public.cai_report(jsonb)')
), rpc AS (
  SELECT r.signature, p.oid IS NOT NULL AS present,
    pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
    p.proargnames AS argument_names, p.proconfig AS settings,
    md5(pg_get_functiondef(p.oid)) AS definition_md5,
    has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_execute,
    EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
  FROM required r LEFT JOIN pg_proc p ON p.oid=to_regprocedure(r.signature)
)
SELECT jsonb_build_object(
  'checked_at', clock_timestamp(),
  'read_only', current_setting('transaction_read_only'),
  'database', current_database(),
  'rpc', (SELECT jsonb_agg(to_jsonb(rpc) ORDER BY signature) FROM rpc),
  'history', (SELECT jsonb_agg(jsonb_build_object('version',version,'name',name) ORDER BY version)
    FROM supabase_migrations.schema_migrations),
  'required_tables', (SELECT jsonb_object_agg(signature,to_regclass(signature) IS NOT NULL)
    FROM (VALUES ('pos.suppliers'),('pos.inventory_adjustments'),('pos.cash_adjustments'),
      ('pos.sale_returns'),('pos.cash_closings'),('pos.store_settings')) t(signature)),
  'unsafe_pos_tables', (SELECT count(*) FROM pg_tables
    WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)),
  'owner_pos_create', has_schema_privilege('pos_owner','pos','CREATE'),
  'owner_public_create', has_schema_privilege('pos_owner','public','CREATE')
) AS worker_v1_readiness;
