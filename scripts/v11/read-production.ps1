param(
 [Parameter(Mandatory=$true)][string]$BackupDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
try {
 if (-not ([IO.Path]::GetFullPath($BackupDirectory)).StartsWith('E:\CAI_Market_Backups\') -or -not ([IO.Path]::GetFullPath($OutputDirectory)).StartsWith('E:\CAI_Market_Preflight\')) { throw 'Private scope rejected' }
 $caiSession=Get-Content -LiteralPath (Join-Path $BackupDirectory 'session.dpapi.json') -Raw | ConvertFrom-Json
 if ($caiSession.project -ne 'sauoekefntzxhqxycdgo' -or $caiSession.role -ne 'cli_login_postgres' -or ([datetimeoffset]$caiSession.expiresAt).UtcDateTime -le [datetime]::UtcNow.AddSeconds(20)) { throw 'Credential scope or expiry rejected' }
 $caiQuery=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../supabase/checks/v11_production_preflight.sql'))
 if (-not $caiQuery.Contains('BEGIN TRANSACTION READ ONLY;') -or $caiQuery -match '(?im)^\s*(CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s') { throw 'Read-only query verification failed' }
 $caiQuery=$caiQuery.Replace('BEGIN TRANSACTION READ ONLY;','BEGIN TRANSACTION READ ONLY; SET LOCAL ROLE postgres;')
 [IO.File]::WriteAllText((Join-Path $OutputDirectory 'v11_preflight_authenticated.sql'),$caiQuery)
 $caiCredential=[pscredential]::new('backup',($caiSession.encryptedPassword|ConvertTo-SecureString))
 $env:PGPASSWORD=$caiCredential.GetNetworkCredential().Password
 $env:PGHOST='aws-0-us-east-2.pooler.supabase.com'; $env:PGPORT='5432'; $env:PGDATABASE='postgres'; $env:PGUSER=$caiSession.role+'.'+$caiSession.project
 $env:PGSSLMODE='verify-full'; $env:PGSSLROOTCERT='/backup/prod-ca-2021.crt'; $env:PGCONNECT_TIMEOUT='15'; $env:PGOPTIONS='-c default_transaction_read_only=on'
 & docker run --rm --env PGHOST --env PGPORT --env PGDATABASE --env PGUSER --env PGPASSWORD --env PGSSLMODE --env PGSSLROOTCERT --env PGCONNECT_TIMEOUT --env PGOPTIONS --mount "type=bind,source=$BackupDirectory,target=/backup,readonly" --mount "type=bind,source=$OutputDirectory,target=/audit" $caiSession.image psql -X -w -qAt -v ON_ERROR_STOP=1 -f /audit/v11_preflight_authenticated.sql -o /audit/v11_preflight_authenticated.out 1> (Join-Path $OutputDirectory 'v11_preflight_authenticated.stdout.log') 2> (Join-Path $OutputDirectory 'v11_preflight_authenticated.stderr.log')
 if ($LASTEXITCODE -ne 0) { throw 'Authenticated read-only preflight failed' }
 Get-Content -LiteralPath (Join-Path $OutputDirectory 'v11_preflight_authenticated.out')
} catch {
 @{phase='authenticated_read_only_preflight';status='STOPPED';exceptionType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress
 exit 1
} finally {
 foreach($caiName in @('PGPASSWORD','PGHOST','PGPORT','PGDATABASE','PGUSER','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGOPTIONS')) { [Environment]::SetEnvironmentVariable($caiName,$null,'Process') }
 $caiSession=$null; $caiCredential=$null
}
