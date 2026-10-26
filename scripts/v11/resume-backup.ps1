param([Parameter(Mandatory=$true)][string]$BackupDirectory)
$ErrorActionPreference='Stop'
try {
  if (-not ([IO.Path]::GetFullPath($BackupDirectory)).StartsWith('E:\CAI_Market_Backups\')) { throw 'Backup path rejected' }
  $caiSession=Get-Content -LiteralPath (Join-Path $BackupDirectory 'session.dpapi.json') -Raw | ConvertFrom-Json
  if ($caiSession.project -ne 'sauoekefntzxhqxycdgo' -or $caiSession.role -ne 'cli_login_postgres' -or $caiSession.purpose -ne 'explicitly_authorized_v11_backup_read_only' -or ([datetimeoffset]$caiSession.expiresAt).UtcDateTime -le [datetime]::UtcNow.AddSeconds(20)) { throw 'Credential scope or expiry rejected' }
  $caiCredential=[pscredential]::new('backup',($caiSession.encryptedPassword | ConvertTo-SecureString))
  $env:PGPASSWORD=$caiCredential.GetNetworkCredential().Password
  $env:CAI_BACKUP_DIRECTORY=$BackupDirectory
  $env:PGHOST='aws-0-us-east-2.pooler.supabase.com'; $env:PGPORT='5432'; $env:PGDATABASE='postgres'
  $env:PGUSER=$caiSession.role+'.'+$caiSession.project
  $env:PGSSLMODE='verify-full'; $env:PGSSLROOTCERT='/backup/prod-ca-2021.crt'; $env:PGCONNECT_TIMEOUT='15'
  $env:PGOPTIONS='-c default_transaction_read_only=on'
  & node (Join-Path $PSScriptRoot 'capture-production.mjs')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Set-Content -LiteralPath (Join-Path $PSScriptRoot '../../.cache/v11-backup-directory.txt') -Value $BackupDirectory
} catch {
  @{phase='resume_backup';status='STOPPED';exceptionType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress
  exit 1
} finally {
  foreach ($caiName in @('CAI_BACKUP_DIRECTORY','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGOPTIONS')) { [Environment]::SetEnvironmentVariable($caiName,$null,'Process') }
  $caiSession=$null; $caiCredential=$null
}
