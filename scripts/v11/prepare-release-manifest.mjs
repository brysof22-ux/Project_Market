// Local review artifact only. Never stages, commits, pushes, deploys or runs SQL.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const base='6ee1211bac5a9b6958994ea6cb2b4a7b3650426b'
const sqlSha='6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810'
const git=args=>{
  const output=spawnSync('git',args,{encoding:'utf8',windowsHide:true})
  assert(output.status===0,'GIT_READ_FAILED')
  return output.stdout
}
assert.equal(git(['branch','--show-current']).trim(),'feature/cai-market-v1.1','WRONG_DEVELOPMENT_BRANCH')
assert.equal(git(['rev-parse','main']).trim(),base,'MAIN_CHANGED_REVIEW_REQUIRED')
assert.equal(git(['diff','--cached','--name-only']).trim(),'','UNEXPECTED_STAGED_CHANGES')
const candidates=[...new Set([
  ...git(['diff','--name-only','-z',base]).split('\0'),
  ...git(['ls-files','--others','--exclude-standard','-z']).split('\0'),
].filter(Boolean))].sort()
assert(candidates.length>0,'NO_RELEASE_CHANGES')
const approved=/^(?:package\.json|vite\.config\.ts|(?:shared|src|tests|supabase\/migrations|supabase\/checks|worker\/api\/src|scripts\/v11|docs\/integracion)\/|worker\/api\/wrangler\.local\.jsonc$)/
const privatePattern=/sb_secret_[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/
const files=candidates.map(name=>{
  assert(approved.test(name),'UNEXPECTED_CHANGED_PATH: '+name)
  assert(!/(?:^|\/)(?:\.env(?:\.|$)|\.dev\.vars(?:\.|$)|backups?|respaldos?|\.cache|node_modules)(?:\/|$)/i.test(name),'PRIVATE_OR_GENERATED_PATH: '+name)
  assert(!/\.(?:dump|backup|bak|pem|key|sql\.gz)$/i.test(name),'BACKUP_OR_PRIVATE_KEY_PATH: '+name)
  const absolute=path.resolve(name)
  assert(fs.existsSync(absolute)&&fs.statSync(absolute).isFile(),'DELETION_REQUIRES_SEPARATE_REVIEW: '+name)
  const content=fs.readFileSync(absolute)
  assert(!privatePattern.test(content.toString()),'PRIVATE_CREDENTIAL_PATTERN: '+name)
  return {path:name,bytes:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')}
})
assert.equal(files.find(file=>file.path==='supabase/migrations/20261025000900_v11_periods_permissions.sql')?.sha256,sqlSha,'SQL_NOT_THE_REHEARSED_VERSION')
assert.equal(git(['diff','--name-only',base,'--','supabase/migrations/2026102300*']).trim(),'','APPLIED_MIGRATION_EDITED')
assert.equal(git(['diff','--name-only',base,'--','worker/api/wrangler.jsonc','public/_headers']).trim(),'','PRODUCTION_CONFIGURATION_EDITED')
const directory='.cache/v11-prepared-release'
fs.mkdirSync(directory,{recursive:true})
const result={preparedAt:new Date().toISOString(),branch:'feature/cai-market-v1.1',base,sqlSha,files,staged:false,committed:false,pushed:false,deployed:false}
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(result,null,2))
fs.writeFileSync(path.join(directory,'paths.nul'),Buffer.from(files.map(file=>file.path).join('\0')+'\0'))
console.log(JSON.stringify({status:'PREPARED_ONLY',files:files.length,base,sqlSha,manifest:path.join(directory,'manifest.json')}))
