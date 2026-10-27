-- Compatibility fix only. Defines the protected reset; NEVER invokes it.
-- Do not disable safeupdate or apply changes to historical migrations.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';
SELECT set_config('cai.reset_fix_role',current_user,true);
DO $$ BEGIN
 IF to_regprocedure('pos.operations_v13(text,jsonb,text)') IS NULL THEN RAISE EXCEPTION 'MIGRATION_012_REQUIRED'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') THEN RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES'; END IF;
END $$;
GRANT CREATE ON SCHEMA pos TO pos_owner;
SET LOCAL ROLE pos_owner;
SELECT period_id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;
CREATE OR REPLACE FUNCTION pos.purge_operation(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE session uuid; intent pos.reset_intents; snapshot jsonb; new_period uuid; seq text; name text; identifier text;
BEGIN
 IF pos.require_staff(p_actor)<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 session:=pos.require_recent_auth();
 IF p_data->>'confirmation' IS DISTINCT FROM 'ELIMINAR OPERACION' OR length(btrim(coalesce(p_data->>'reason',''))) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'RESET_CONFIRMATION_REQUIRED'; END IF;
 BEGIN PERFORM id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPERATION_IN_PROGRESS' USING ERRCODE='55P03'; END;
 SELECT * INTO intent FROM pos.reset_intents WHERE id=(p_data->>'intent_id')::uuid FOR UPDATE;
 IF NOT FOUND OR intent.actor_id<>p_actor OR intent.session_id<>session OR intent.period_id<>pos.current_period() OR intent.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'RESET_INTENT_INVALID'; END IF;
 IF intent.expires_at<clock_timestamp() THEN RAISE EXCEPTION 'RESET_INTENT_EXPIRED'; END IF;
 snapshot:=pos.reset_snapshot_v13();
 IF snapshot IS DISTINCT FROM intent.snapshot THEN RAISE EXCEPTION 'RESET_PREVIEW_CHANGED'; END IF;
 IF EXISTS(SELECT FROM pos.notification_jobs WHERE status='sending' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'NOTIFICATIONS_IN_PROGRESS'; END IF;
 -- Locks and all deletes, period change and identity restart roll back together.
 PERFORM set_config('cai.reset_read','on',true);
 PERFORM set_config('cai.destructive_reset','on',true);
 SET CONSTRAINTS ALL DEFERRED;
 FOREACH name IN ARRAY ARRAY['reminder_delivery_events','reminder_attempts','credit_reminders','notification_jobs','cash_closings','cash_adjustments','sale_returns','cash_entries','inventory_movements','payments','sale_items','credit_allocations','credit_receipts','credit_charges','credit_limit_authorizations','credit_accounts','sales','cash_sessions','inventory_adjustments','inventory_purchases','inventory_balances','audit_events','idempotency_requests'] LOOP
  -- Explicit non-null key predicate: compatible with authenticator's safeupdate.
  -- The validated intent, exclusive lock and reset-only RLS remain mandatory.
  identifier:=CASE name WHEN 'inventory_balances' THEN 'product_id' WHEN 'idempotency_requests' THEN 'actor_id' ELSE 'id' END;
  EXECUTE format('DELETE FROM pos.%I WHERE %I IS NOT NULL',name,identifier);
 END LOOP;
 DELETE FROM pos.reset_intents WHERE id IS NOT NULL;
 UPDATE pos.operating_periods SET closed_at=pos.business_now(),closed_by=p_actor,reason=btrim(p_data->>'reason'),closing_snapshot=NULL WHERE id=pos.current_period();
 INSERT INTO pos.operating_periods DEFAULT VALUES RETURNING id INTO new_period;
 UPDATE pos.operation_state SET period_id=new_period,revision=revision+1 WHERE id;
 DELETE FROM pos.operating_periods WHERE id<>new_period;
 INSERT INTO pos.inventory_balances(product_id,quantity) SELECT id,0 FROM pos.products;
 seq:=pg_get_serial_sequence('pos.sales','number'); EXECUTE format('ALTER SEQUENCE %s RESTART WITH 1',seq::regclass);
 PERFORM set_config('cai.destructive_reset','',true); PERFORM set_config('cai.reset_read','',true);
 INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(p_actor,'operation.destructive_reset',new_period);
 RETURN jsonb_build_object('period_id',new_period,'destructive',true);
END $$;
REVOKE ALL ON FUNCTION pos.purge_operation(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.reset_fix_role')); END $$;
REVOKE CREATE ON SCHEMA pos FROM pos_owner;
COMMIT;
