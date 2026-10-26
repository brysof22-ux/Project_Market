-- READ ONLY. Project identity sauoekefntzxhqxycdgo and TLS verify-full must be
-- checked by the connecting client; current_database()='postgres' proves neither.
-- No DDL/DML, privilege repair, migration registration or business RPC is run.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog,pg_temp;

DO $$ DECLARE v text; n integer; BEGIN
  IF current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'STOP_READ_ONLY_REQUIRED'; END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN RAISE EXCEPTION 'STOP_HISTORY_MISSING'; END IF;
  FOREACH v IN ARRAY ARRAY['20261023000100','20261023000200','20261023000300','20261023000400',
    '20261023000500','20261023000600','20261023000700','20261023000800'] LOOP
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text=$1' INTO n USING v;
    IF n<>1 THEN RAISE EXCEPTION 'STOP_HISTORY_REQUIRED_%',v; END IF;
  END LOOP;
  EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text>=$1'
    INTO n USING '20261025000900';
  IF n<>0 THEN RAISE EXCEPTION 'STOP_009_OR_LATER_RECORDED'; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner') OR EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'STOP_UNSAFE_POS_OWNER';
  END IF;
  IF EXISTS(SELECT FROM pg_auth_members m WHERE m.member='pos_owner'::regrole) THEN RAISE EXCEPTION 'STOP_POS_OWNER_INHERITS_ROLE'; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','pos_app','pos_scheduler')
    AND pg_has_role(oid,'pos_owner','MEMBER')) THEN RAISE EXCEPTION 'STOP_APPLICATION_OWNER_MEMBERSHIP'; END IF;
  FOREACH v IN ARRAY ARRAY['pos','public'] LOOP
    IF has_schema_privilege('pos_owner',v,'CREATE') THEN RAISE EXCEPTION 'STOP_RESIDUAL_OWNER_CREATE_%',v; END IF;
    IF NOT has_schema_privilege(current_user,v,'CREATE WITH GRANT OPTION') THEN RAISE EXCEPTION 'STOP_MIGRATOR_CANNOT_GRANT_CREATE_%',v; END IF;
  END LOOP;
  IF NOT pg_has_role(current_user,'pos_owner','SET') THEN RAISE EXCEPTION 'STOP_MIGRATOR_CANNOT_SET_OWNER'; END IF;
  FOREACH v IN ARRAY ARRAY['public.cai_current_profile()','public.cai_catalog(text,jsonb,text)',
    'public.cai_operations(text,jsonb,text)','public.cai_report(jsonb)',
    'pos.current_profile_auth_uid()','pos.require_staff(uuid)','pos.require_read_committed()',
    'pos.begin_request(uuid,text,text,jsonb)','pos.prevent_financial_mutation()',
    'pos.confirm_sale(uuid,uuid,uuid,jsonb,jsonb,boolean,text)',
    'pos.authorize_credit_limit(uuid,uuid,numeric,text,text)',
    'pos.record_credit_receipt(uuid,uuid,uuid,numeric,uuid,text,text)',
    'pos.capture_sale_cost()','pos.business_now()'] LOOP
    IF to_regprocedure(v) IS NULL THEN RAISE EXCEPTION 'STOP_DEPENDENCY_MISSING_%',v; END IF;
    IF NOT has_function_privilege('pos_owner',v,'EXECUTE') THEN RAISE EXCEPTION 'STOP_DEPENDENCY_EXECUTE_%',v; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure('pos.current_profile_auth_uid()')
      AND (a.grantee NOT IN (p.proowner,'pos_owner'::regrole) OR (a.grantee='pos_owner'::regrole AND a.is_grantable))) THEN
    RAISE EXCEPTION 'STOP_UNSAFE_AUTH_BRIDGE_ACL';
  END IF;
  -- Detect every family of new 009 objects, including manually executed fragments.
  IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='pos'
    AND p.proname IN ('current_period','read_period','operation_guard','guard_write','check_period_links',
      'require_period','catalog_v1','operations_v1','report_v1','confirm_sale_v11','valid_credit_phone',
      'debt_row','period_snapshot','require_recent_auth','assert_sale_authorization')) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_009_FUNCTIONS';
  END IF;
  FOREACH v IN ARRAY ARRAY['pos.operating_periods','pos.operation_state','pos.product_media','pos.reset_intents',
    'pos.one_active_operating_period'] LOOP
    IF to_regclass(v) IS NOT NULL THEN RAISE EXCEPTION 'STOP_PARTIAL_009_RELATION_%',v; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND a.attnum>0 AND NOT a.attisdropped AND
      (a.attname='operating_period_id' OR (c.relname='products' AND a.attname='image_id')
        OR (c.relname='sales' AND a.attname='buyer_name')
        OR (c.relname='credit_limit_authorizations' AND a.attname IN ('scope','sale_id','financed_amount')))) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_009_COLUMNS';
  END IF;
  IF EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND t.tgname IN ('v11_write_gate','v11_period_links','v11_sale_authorization'))
    OR EXISTS(SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='pos' AND p.polname IN ('active_period_read','active_period_insert','active_period_update')) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_009_TRIGGER_OR_POLICY';
  END IF;
  IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname IN ('pos','public')
    AND p.proname IN ('require_staff','authorize_credit_limit','cai_catalog','cai_operations','cai_report',
      'enqueue_credit_reminders','preflight_credit_reminder','record_reminder_delivery','claim_credit_reminder','finish_credit_reminder')
    AND (position('operation_guard' IN pg_get_functiondef(p.oid))>0 OR position('catalog_v1' IN pg_get_functiondef(p.oid))>0
      OR position('operations_v1' IN pg_get_functiondef(p.oid))>0 OR position('report_v1' IN pg_get_functiondef(p.oid))>0)) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_009_REPLACED_FUNCTION';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='pos.credit_charges'::regclass AND conname='credit_charges_due_policy'
    AND position('credit_due_date' IN pg_get_constraintdef(oid))>0)
    OR NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='pos.credit_charges'::regclass AND attname='due_on' AND attnotnull) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_OR_INCOMPATIBLE_DUE_POLICY';
  END IF;
  IF EXISTS(SELECT FROM pg_tables WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)) THEN RAISE EXCEPTION 'STOP_TABLE_OWNER_OR_RLS'; END IF;
  IF EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND (NOT i.indisvalid OR NOT i.indisready)) THEN RAISE EXCEPTION 'STOP_INVALID_INDEX'; END IF;
  IF EXISTS(SELECT FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND NOT k.convalidated) THEN RAISE EXCEPTION 'STOP_UNVALIDATED_CONSTRAINT'; END IF;
  IF EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND t.tgenabled='D') THEN RAISE EXCEPTION 'STOP_DISABLED_TRIGGER'; END IF;
END $$;

-- Counts only: no names, email addresses, phone numbers, UUIDs or JWTs.
SET LOCAL ROLE pos_owner;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pos.profiles WHERE active AND role='admin') THEN RAISE EXCEPTION 'STOP_NO_ACTIVE_ADMIN'; END IF;
  IF EXISTS(SELECT FROM pos.products p LEFT JOIN pos.inventory_balances b ON b.product_id=p.id WHERE b.product_id IS NULL) THEN
    RAISE EXCEPTION 'STOP_PRODUCT_WITHOUT_STOCK_BALANCE'; END IF;
END $$;
SELECT 'V11_STRUCTURE_PREFLIGHT_PASS' AS structure_result,
  (SELECT count(*) FROM pos.profiles WHERE active AND role='admin') AS active_administrators,
  (SELECT count(*) FROM pos.profiles WHERE active AND role='cashier') AS active_cashiers,
  (SELECT count(*) FROM pos.profiles WHERE active AND role='cashier' AND NOT can_credit) AS cashiers_new_credit_capability,
  (SELECT count(*) FROM pos.profiles WHERE active AND role='supervisor') AS active_supervisors_requiring_explicit_reclassification,
  (SELECT count(*) FROM pos.cash_sessions WHERE closed_at IS NULL) AS open_cash_sessions,
  (SELECT count(*) FROM pos.products) AS products,
  (SELECT count(*) FROM pos.customers) AS customers;
-- This is a structural preflight, not permission to run DDL. Open cash sessions
-- and Supervisor users must be handled explicitly before the maintenance window.
ROLLBACK;
