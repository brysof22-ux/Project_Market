// PREPARES FILES ONLY. No database client, fetch, deployment or Git mutation.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const [backupArg,rehearsalArg,outputArg]=process.argv.slice(2)
const backup=path.resolve(backupArg??''),rehearsal=path.resolve(rehearsalArg??''),output=path.resolve(outputArg??'')
assert(backup.startsWith('E:\\CAI_Market_Backups\\')&&rehearsal.startsWith('E:\\CAI_Market_Rehearsals\\')&&output.startsWith('E:\\CAI_Market_Preflight\\'),'PRIVATE_PATHS_REQUIRED')
assert(fs.existsSync(output),'EXISTING_PRIVATE_OUTPUT_DIRECTORY_REQUIRED')
const source=JSON.parse(fs.readFileSync(path.join(backup,'source-state.json')))
const proof=JSON.parse(fs.readFileSync(path.join(rehearsal,'result.json')))
const digest=contents=>crypto.createHash('sha256').update(contents).digest('hex')
const migration='20261025000900_v11_periods_permissions.sql'
const sqlBytes=fs.readFileSync(path.join('supabase/migrations',migration))
const expected='6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810'
assert(digest(sqlBytes)===expected&&proof.migrationSha256===expected&&proof.passed&&proof.restorationVerified&&proof.maintenance.restored,'VERIFIED_REHEARSAL_REQUIRED')
assert(source.project==='sauoekefntzxhqxycdgo'&&source.history.length===8,'SOURCE_SCOPE_REQUIRED')
const q=value=>"'"+String(value).replaceAll("'","''")+"'"
const qi=value=>'"'+value.replaceAll('"','""')+'"'
const inventory=proof.maintenance.original
assert(inventory.length===29&&inventory.every(row=>row.owner==='pos_owner'&&row.acl==='{pos_owner=arwdDxtm/pos_owner}'),'REVIEW_NONSTANDARD_SOURCE_ACL')
const refs=inventory.map(row=>'pos.'+qi(row.name)).join(',')
const expectedValues=inventory.map(row=>`(${q(row.name)},${q(row.owner)},${q(row.acl)})`).join(',')
const compareAcl=`DO $check$ BEGIN IF EXISTS(SELECT FROM (VALUES ${expectedValues}) x(name,owner,acl)
 LEFT JOIN pg_class c ON c.oid=to_regclass('pos.'||quote_ident(x.name))
 WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner)<>x.owner OR c.relacl::text IS DISTINCT FROM x.acl)
 THEN RAISE EXCEPTION 'STOP_ORIGINAL_ACL_MISMATCH'; END IF; END $check$;`
const quiet=`DO $quiet$ BEGIN
 IF EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
  AND backend_type='client backend' AND xact_start IS NOT NULL)
  OR EXISTS(SELECT FROM pg_prepared_xacts WHERE database=current_database()) THEN RAISE EXCEPTION 'STOP_INCOMPATIBLE_TRANSACTIONS'; END IF;
 IF EXISTS(SELECT FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace s ON s.oid=c.relnamespace
  WHERE s.nspname='pos' AND l.pid<>pg_backend_pid() AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN RAISE EXCEPTION 'STOP_UNEXPECTED_POS_LOCKS'; END IF;
 END $quiet$;`
const header='-- PREPARED ONLY. Production writes require separate explicit authorization.\nSET ROLE postgres;\n'
const generated={}
generated['maintenance_on.prepared.sql']=header+`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';
${quiet}
${compareAcl}
SET LOCAL ROLE pos_owner;
LOCK TABLE ${refs} IN ACCESS EXCLUSIVE MODE NOWAIT;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} FROM pos_owner;
REVOKE SELECT ON pos.idempotency_requests FROM pos_owner;
COMMIT;\n`
generated['quiet_readonly.prepared.sql']=header+`BEGIN READ ONLY; ${quiet} SELECT 'QUIET_PASS' AS result; ROLLBACK;\n`
generated['maintenance_closed_readonly.prepared.sql']=header+`BEGIN READ ONLY; DO $closed$ BEGIN
IF EXISTS(SELECT FROM pg_tables WHERE schemaname='pos' AND tablename IN (${inventory.map(row=>q(row.name)).join(',')}) AND has_table_privilege('pos_owner','pos.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE'))
OR has_table_privilege('pos_owner','pos.idempotency_requests','SELECT') THEN RAISE EXCEPTION 'STOP_WRITE_FENCE_NOT_CLOSED'; END IF; END $closed$;
SELECT 'MAINTENANCE_CLOSED_PASS' AS result; ROLLBACK;\n`
generated['maintenance_restore.prepared.sql']=header+`-- Open only after compatible Worker/Pages and identity/integrity checks pass.
BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL ROLE pos_owner;
GRANT INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} TO pos_owner;
GRANT SELECT ON pos.idempotency_requests TO pos_owner;
${compareAcl}
COMMIT;\n`
const audit=fs.readFileSync('supabase/checks/v11_postmigration_integrity.sql','utf8')
assert(audit.includes(",'20261025000900'"),'POSTAUDIT_HISTORY_LIST_CHANGED')
generated['validate_009_before_history.prepared.sql']=audit.replace(",'20261025000900'",'')
const checks=source.tables.map(table=>`SELECT ${q(table.schema+'.'+table.name)} AS name,x.rows,x.digest,${q(table.rows)} AS expected_rows,${q(table.digest)} AS expected_digest FROM (${table.hashSql}) x`).join(' UNION ALL ')
generated['original_data_readonly.prepared.sql']=`-- All fields are hashed; no row contents are returned. Read-only Management API compatible.
SELECT jsonb_build_object('read_only',current_setting('transaction_read_only'),'source_captured_at',${q(source.capturedAt)},
'tables_unchanged',NOT EXISTS(SELECT FROM (${checks}) x WHERE rows<>expected_rows OR digest<>expected_digest),
'differences',coalesce((SELECT jsonb_agg(jsonb_build_object('table',name,'before_rows',expected_rows,'current_rows',rows)) FROM (${checks}) x WHERE rows<>expected_rows OR digest<>expected_digest),'[]'::jsonb)) AS comparison;\n`
for(const [name,contents]of Object.entries(generated)){assert(!fs.existsSync(path.join(output,name)),'REFUSE_PREPARED_OVERWRITE');fs.writeFileSync(path.join(output,name),contents)}
const register=fs.readFileSync(path.join(rehearsal,'register_20261025000900.prepared.sql'))
assert(digest(register)==='502a2d75df132db8e8f95011e4175eb68db31319915410efac7fd32e2874a53b','OFFICIAL_CLI_REGISTRATION_CHANGED')
fs.copyFileSync(path.join(rehearsal,'register_20261025000900.prepared.sql'),path.join(output,'register_20261025000900.prepared.sql'))
fs.writeFileSync(path.join(output,migration),sqlBytes)
const files=[...Object.keys(generated),'register_20261025000900.prepared.sql',migration].map(name=>({name,sha256:digest(fs.readFileSync(path.join(output,name)))}))
fs.writeFileSync(path.join(output,'prepared-sql-manifest.json'),JSON.stringify({project:source.project,sourceCapturedAt:source.capturedAt,sqlSha256:expected,preparedOnly:true,productionExecuted:false,files},null,2))
console.log(JSON.stringify({status:'PREPARED_NOT_EXECUTED',directory:output,files:files.length,sqlSha256:expected}))
