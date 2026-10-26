// Executes the EXACT prepared production SQL files only in a new offline clone.
// No URL, remote PostgreSQL credential, deployment or live-service API is accepted.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const [backupArg,proofArg,preparedArg,workArg]=process.argv.slice(2)
const backup=path.resolve(backupArg??''),proof=path.resolve(proofArg??''),prepared=path.resolve(preparedArg??''),work=path.resolve(workArg??'')
assert(backup.startsWith('E:\\CAI_Market_Backups\\')&&proof.startsWith('E:\\CAI_Market_Rehearsals\\')&&prepared.startsWith('E:\\CAI_Market_Preflight\\')&&work.startsWith('E:\\CAI_Market_Rehearsals\\'),'PRIVATE_PATHS_REQUIRED')
assert(fs.existsSync(work)&&fs.readdirSync(work).length===0,'EMPTY_PRIVATE_WORK_REQUIRED')
const recovery=JSON.parse(fs.readFileSync(path.join(proof,'restoration-result.json')))
const manifest=JSON.parse(fs.readFileSync(path.join(prepared,'prepared-sql-manifest.json')))
const source=JSON.parse(fs.readFileSync(path.join(backup,'source-state.json')))
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
assert(recovery.restorationVerified&&source.project==='sauoekefntzxhqxycdgo'&&manifest.project===source.project&&manifest.preparedOnly&&manifest.productionExecuted===false,'VERIFIED_LOCAL_SCOPE_REQUIRED')
assert(manifest.files.length===8&&manifest.sqlSha256==='6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810','EXACT_PREPARED_MANIFEST_REQUIRED')
const suffix=path.basename(work).split('_').at(-1)
assert(/^[a-f0-9]{8}$/.test(suffix),'WORK_SUFFIX_REQUIRED')
const container='cai-v11-prepared-'+suffix
const image='public.ecr.aws/supabase/postgres@sha256:7374d196da7e301512cc5329e18040e0f7bb856287b323777cdadecccbc6c7e4'
const qi=name=>'"'+name.replaceAll('"','""')+'"'
const result={project:source.project,sqlSha256:manifest.sqlSha256,preparedFiles:manifest.files,productionExecuted:false,steps:[],passed:false,container,restorationPoint:recovery.containers.restore}
let phase='local_setup',running=false,fence=false
function run(label,args,input) {
  phase=label
  const response=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:30000000})
  fs.writeFileSync(path.join(work,label+'.stdout.log'),response.stdout??'')
  fs.writeFileSync(path.join(work,label+'.stderr.log'),response.stderr??'')
  assert(!response.error&&response.status===0,label+'_FAILED')
  assert(!(response.stderr??'').includes('WARNING:'),label+'_WARNING')
  return response.stdout.trim()
}
function sql(label,statement) {
  return run(label,['exec','-i',container,'psql','-h','/tmp','-U','supabase_admin','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],
    `SET ROLE postgres; SET TIME ZONE 'UTC'; SET search_path=public; SET extra_float_digits=3;\n${statement}`)
}
function executeFile(name,label,readOnly=false) {
  const output=sql(label,`${readOnly?'BEGIN READ ONLY;\n':''}\\i /work/${name}\n${readOnly?'ROLLBACK;':''}`)
  result.steps.push({name,label,pass:true})
  return output
}
try {
  for(const file of manifest.files) {
    const content=fs.readFileSync(path.join(prepared,file.name))
    assert.equal(digest(content),file.sha256,'PREPARED_SQL_HASH_MISMATCH')
    fs.writeFileSync(path.join(work,file.name),content)
  }
  fs.copyFileSync('supabase/checks/v11_postmigration_integrity.sql',path.join(work,'v11_postmigration_integrity.sql'))
  const stopped=JSON.parse(run('recovery_state',['inspect','--format','{{json .State}}',recovery.containers.restore]))
  assert(stopped.Running===false,'RECOVERY_MUST_REMAIN_STOPPED')
  run('volume_create',['volume','create','--label','cai.purpose=v11-prepared-production-sql-proof',container+'-data'])
  run('volume_clone',['run','--rm','--network','none','--mount',`type=volume,source=${recovery.containers.restore}-data,target=/source,readonly`,'--mount',`type=volume,source=${container}-data,target=/target`,'--entrypoint','/bin/sh',image,'-c','set -eu; test -z "$(ls -A /target)"; cp -a /source/. /target/'])
  run('start_clone',['run','-d','--name',container,'--network','none','--user','100:101','--mount',`type=volume,source=${container}-data,target=/var/lib/postgresql/data`,'--mount',`type=bind,source=${work},target=/work,readonly`,'--entrypoint','postgres',image,'-D','/var/lib/postgresql/data','-c','listen_addresses=','-c','unix_socket_directories=/tmp','-c','shared_preload_libraries=pg_stat_statements'])
  running=true
  for(let attempt=0;attempt<40;attempt++) {
    const ready=spawnSync('docker',['exec',container,'pg_isready','-h','/tmp','-U','supabase_admin','-d','postgres'],{windowsHide:true})
    if(ready.status===0)break
    if(attempt===39)throw new Error('CLONE_NOT_READY')
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  const isolation=JSON.parse(run('isolation',['inspect','--format','{{json .HostConfig}}',container]))
  assert(isolation.NetworkMode==='none'&&Object.keys(isolation.PortBindings??{}).length===0,'ISOLATION_REQUIRED')
  const migratedRole=JSON.parse(sql('non_superuser_migrator',"SELECT json_build_object('role',current_user,'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user));"))
  assert(migratedRole.role==='postgres'&&migratedRole.superuser===false,'NON_SUPERUSER_MIGRATOR_REQUIRED')
  result.migrator=migratedRole
  const expected=source.catalog.relationPermissions.filter(row=>row.schema==='pos'&&row.kind==='r')
  assert(expected.length===29&&expected.every(row=>row.owner==='pos_owner'&&row.acl==='{pos_owner=arwdDxtm/pos_owner}'),'STANDARD_SOURCE_OWNER_ACL_REQUIRED')
  sql('materialize_source_acl',`BEGIN; SET LOCAL ROLE pos_owner; GRANT ALL PRIVILEGES ON ${expected.map(row=>'pos.'+qi(row.name)).join(',')} TO pos_owner; COMMIT;`)
  executeFile('quiet_readonly.prepared.sql','quiet_before_cut')
  executeFile('maintenance_on.prepared.sql','maintenance_on')
  fence=true
  executeFile('maintenance_closed_readonly.prepared.sql','maintenance_closed')
  executeFile('quiet_readonly.prepared.sql','quiet_before_009')
  executeFile('20261025000900_v11_periods_permissions.sql','migration_009')
  executeFile('maintenance_closed_readonly.prepared.sql','maintenance_still_closed_after_009')
  executeFile('quiet_readonly.prepared.sql','quiet_after_009')
  executeFile('validate_009_before_history.prepared.sql','validate_before_history')
  const original=JSON.parse(executeFile('original_data_readonly.prepared.sql','all_original_data',true))
  assert(original.read_only==='on'&&original.tables_unchanged===true&&original.differences.length===0,'ORIGINAL_DATA_CHANGED')
  result.originalData=original
  executeFile('register_20261025000900.prepared.sql','register_official_009')
  executeFile('v11_postmigration_integrity.sql','audit_while_closed')
  executeFile('maintenance_restore.prepared.sql','restore_exact_acl')
  fence=false
  executeFile('v11_postmigration_integrity.sql','audit_after_restore')
  executeFile('quiet_readonly.prepared.sql','quiet_final')
  const history=JSON.parse(sql('history_final',"SELECT json_agg(t ORDER BY version) FROM (SELECT version,name,coalesce(array_length(statements,1),0) AS statements FROM supabase_migrations.schema_migrations) t;"))
  assert(history.length===9&&history.at(-1).version==='20261025000900'&&history.at(-1).statements===58,'FINAL_HISTORY_MISMATCH')
  result.history=history
  for(const file of manifest.files) assert.equal(digest(fs.readFileSync(path.join(prepared,file.name))),file.sha256,'PREPARED_SQL_CHANGED_DURING_PROOF')
  result.passed=true
} catch(error) {
  result.failure=error.message;result.phase=phase;process.exitCode=1
} finally {
  if(fence&&running) {
    try { executeFile('maintenance_restore.prepared.sql','recover_exact_acl_after_error');fence=false } catch { result.aclRecoveryFailed=true;process.exitCode=1 }
  }
  result.fenceActive=fence
  if(running) { try { run('stop_clone',['stop',container]);result.cloneStopped=true } catch { result.cloneStopped=false;process.exitCode=1 } }
  fs.writeFileSync(path.join(work,'prepared-proof-result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({status:result.passed?'PASS':'STOPPED',phase:result.phase??'complete',failure:result.failure,steps:result.steps.length,sourceRowsUnchanged:result.originalData?.tables_unchanged??false,maintenanceRestored:!fence,cloneStopped:result.cloneStopped,work}))
}
