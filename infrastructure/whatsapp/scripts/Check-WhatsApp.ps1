$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$values=@{}
Get-Content -LiteralPath (Join-Path $root '.env') | ForEach-Object {if($_ -match '^([A-Z_]+)=(.*)$'){$values[$Matches[1]]=$Matches[2]}}
try {
 $status=Invoke-RestMethod -Uri "http://127.0.0.1:$($values.EVOLUTION_PORT)/instance/connectionState/cai-market" -Headers @{apikey=$values.EVOLUTION_API_KEY} -TimeoutSec 10
 @{instance='cai-market';state=$status.instance.state}|ConvertTo-Json -Compress
} catch {Write-Output 'EVOLUTION_UNAVAILABLE_OR_INSTANCE_NOT_CREATED';exit 1}
finally {$values.Clear()}
