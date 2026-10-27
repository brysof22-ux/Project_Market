$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
& docker info --format '{{.ServerVersion}}'
if($LASTEXITCODE -ne 0){throw 'Docker Engine is unavailable. Start or repair Docker Desktop, then retry. Existing containers were not changed.'}
if(-not (Test-Path -LiteralPath (Join-Path $root '.env'))){throw 'Copy .env.example to .env and configure secure local credentials first.'}
& docker compose --project-directory $root config --quiet
if($LASTEXITCODE -ne 0){throw 'Compose configuration rejected'}
& docker compose --project-directory $root up -d postgres redis evolution
if($LASTEXITCODE -ne 0){throw 'WhatsApp stack failed to start; inspect only cai-market-whatsapp services'}
Write-Output 'Open http://localhost:18080/manager. Create cai-market using WHATSAPP-BAILEYS. The owner must scan the linking QR.'
