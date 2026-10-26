param([switch]$AuthorizedTemporaryAccess,[string]$ReadOnlyPreflightDirectory,[switch]$RenewOnly)
$ErrorActionPreference = 'Stop'
# This switch is a mechanical safeguard, never a substitute for human approval.
if (-not $AuthorizedTemporaryAccess) { throw 'Explicit authorization for temporary access is required.' }
$caiProject = 'sauoekefntzxhqxycdgo'
$caiImage = 'postgres@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'
$caiDirectory = Join-Path 'E:\CAI_Market_Backups' ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '_' + $caiProject + '_v11_' + [guid]::NewGuid().ToString('N').Substring(0,8))
$caiPhase = 'local_preconditions'
try {
  & docker image inspect $caiImage --format '{{.Id}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Approved PostgreSQL client image unavailable' }
  New-Item -ItemType Directory -Path $caiDirectory | Out-Null
  $caiSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

  & icacls.exe $caiDirectory /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot disable directory inheritance' }

  & icacls.exe $caiDirectory /grant:r "*${caiSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot apply private directory permissions' }

  $caiAcl = Get-Acl -LiteralPath $caiDirectory
  if (-not $caiAcl.AreAccessRulesProtected) {
    throw 'Private directory inheritance is still enabled'
  }

  $caiAllowed = @($caiSid, 'S-1-5-18')

  foreach ($caiRule in $caiAcl.Access) {
    $caiRuleSid = $caiRule.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value

    if ($caiRuleSid -notin $caiAllowed) {
      throw 'Unexpected directory permission detected'
    }
  }
  $caiCaPath = Join-Path $PSScriptRoot 'certs/prod-ca-2021.crt'
  $caiCaPem = [IO.File]::ReadAllText($caiCaPath)
  $caiCa = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String(($caiCaPem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s','')))
  if ($caiCa.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ne '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA') { throw 'Official CA pin mismatch' }
  Copy-Item -LiteralPath $caiCaPath -Destination (Join-Path $caiDirectory 'prod-ca-2021.crt')
  Add-Type @'
using System; using System.Runtime.InteropServices;
public static class CaiV11BackupCredential {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct C {public uint Flags;public uint Type;public string Target;public string Comment;public System.Runtime.InteropServices.ComTypes.FILETIME Written;public uint Size;public IntPtr Blob;public uint Persist;public uint Count;public IntPtr Attributes;public string Alias;public string User;}
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Read(string target,int type,int flags,out IntPtr value);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static string Load(){IntPtr p;if(!Read("Supabase CLI:supabase",1,0,out p))throw new Exception("Saved CLI credential unavailable");try{var c=Marshal.PtrToStructure<C>(p);var b=new byte[c.Size];Marshal.Copy(c.Blob,b,0,b.Length);try{return System.Text.Encoding.UTF8.GetString(b).TrimEnd('\0');}finally{Array.Clear(b,0,b.Length);}}finally{CredFree(p);}}
}
'@
  $caiToken = [CaiV11BackupCredential]::Load()
  if ($caiToken.StartsWith('go-keyring-base64:')) { $caiToken=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($caiToken.Substring(18))) }
  if ($caiToken -notmatch '^sbp_[A-Za-z0-9_-]+$') { throw 'Saved credential format rejected' }
  $caiPhase = 'authorized_temporary_access_renewal'
  $caiClient = [Net.Http.HttpClient]::new(); $caiClient.Timeout=[TimeSpan]::FromSeconds(25)
  $caiRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,"https://api.supabase.com/v1/projects/$caiProject/cli/login-role")
  $caiRequest.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$caiToken)
  $caiRequest.Content = [Net.Http.StringContent]::new('{"read_only":false}',[Text.Encoding]::UTF8,'application/json')
  $caiResponse=$caiClient.SendAsync($caiRequest).GetAwaiter().GetResult()
  if (-not $caiResponse.IsSuccessStatusCode) { throw 'Temporary credential renewal rejected' }
  $caiSession=$caiResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
  if ($caiSession.role -ne 'cli_login_postgres' -or -not $caiSession.password -or $caiSession.ttl_seconds -lt 60) { throw 'Temporary credential scope rejected' }
  $caiEncrypted=ConvertTo-SecureString -String $caiSession.password -AsPlainText -Force | ConvertFrom-SecureString
  @{project=$caiProject;role=$caiSession.role;encryptedPassword=$caiEncrypted;expiresAt=[DateTime]::UtcNow.AddSeconds([int]$caiSession.ttl_seconds).ToString('o');image=$caiImage;purpose='explicitly_authorized_v11_backup_read_only'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caiDirectory 'session.dpapi.json') -Encoding utf8
  $caiToken=$null
  if ($RenewOnly) {
    @{phase='authorized_temporary_access_renewal';status='PASS';temporarySessionDirectory=$caiDirectory;backupExported=$false;sqlExecuted=$false} | ConvertTo-Json -Compress
    return
  }
  if ($ReadOnlyPreflightDirectory) {
    $caiPhase='authenticated_read_only_preflight'
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'read-production.ps1') -BackupDirectory $caiDirectory -OutputDirectory $ReadOnlyPreflightDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated preflight failed; no migrations attempted' }
    @{phase=$caiPhase;status='PASS';temporarySessionDirectory=$caiDirectory;backupExported=$false} | ConvertTo-Json -Compress
    return
  }
  $env:CAI_BACKUP_DIRECTORY=$caiDirectory
  $env:PGHOST='aws-0-us-east-2.pooler.supabase.com'; $env:PGPORT='5432'; $env:PGDATABASE='postgres'
  $env:PGUSER=$caiSession.role+'.'+$caiProject; $env:PGPASSWORD=$caiSession.password
  $env:PGSSLMODE='verify-full'; $env:PGSSLROOTCERT='/backup/prod-ca-2021.crt'; $env:PGCONNECT_TIMEOUT='15'
  $env:PGOPTIONS='-c default_transaction_read_only=on'
  $caiPhase='read_only_snapshot_and_dump'
  & node (Join-Path $PSScriptRoot 'capture-production.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Backup capture failed; stop and inspect private diagnostics' }
  Set-Content -LiteralPath (Join-Path $PSScriptRoot '../../.cache/v11-backup-directory.txt') -Value $caiDirectory
  @{phase='backup_export';status='PASS';directory=$caiDirectory;restorationVerified=$false} | ConvertTo-Json -Compress
} catch {
  @{phase=$caiPhase;status='STOPPED';exceptionType=$_.Exception.GetType().Name;directory=$caiDirectory} | ConvertTo-Json -Compress
  exit 1
} finally {
  foreach ($caiName in @('CAI_BACKUP_DIRECTORY','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGOPTIONS')) { [Environment]::SetEnvironmentVariable($caiName,$null,'Process') }
  if ($caiRequest) { $caiRequest.Dispose() }; if ($caiResponse) { $caiResponse.Dispose() }; if ($caiClient) { $caiClient.Dispose() }
  $caiSession=$null; $caiToken=$null; $caiEncrypted=$null
}
