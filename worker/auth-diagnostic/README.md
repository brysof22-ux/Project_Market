# Worker aislado: diagnóstico de Supabase Auth

Este directorio es independiente de `worker/api`; no importa ni modifica `/api/me`, RPC, autenticación, CORS o permisos de CAI Market. Sin rutas de producción, bindings de producción ni publicación workers.dev. No ejecutar deploy. No utiliza JWT reales: el único Authorization saliente es el literal ficticio `Bearer aaa.bbb.ccc`.

## Hallazgo reproducido

Cloudflare solo implementa redirect `follow` y `manual`. `redirect: 'error'` lanza TypeError al construir Request, incluso dentro de fetch y antes de la red. El código de workerd lo confirma. Node sí acepta error: los mocks y constructores de Node no descubren esta incompatibilidad.

Se ejecutó Wrangler **4.152.0 local**, sin variables Supabase ni tráfico hacia Supabase:

| Prueba | Fase | Excepción | Red |
| --- | --- | --- | --- |
| construct-manual | request | null | ninguna |
| construct-error | request | TypeError | ninguna |
| construct-timeout | request | null | ninguna |

El tercer caso crea AbortSignal.timeout(10000) dentro del manejador y lo adjunta a un Request manual. La diferencia reproduce una causa concreta compatible con AUTH_UNAVAILABLE. No confirma el estado del despliegue, conectividad o credenciales remotas. No se aplicó ninguna corrección a CAI Market durante la creación de este harness.

Otras causas posibles: URL inválida/esquema/ruta/proyecto equivocados; secreto con CR/LF, caracteres no representables en ByteString o tipo incorrecto; AbortSignal.timeout no disponible en otro runtime/contexto; fallos de transporte. El harness separa config, signal, headers, request y fetch. El Worker original valida la URL antes de auth_fetch, por lo que una URL que falla esa validación produce SERVICE_UNAVAILABLE; errores al materializar opciones/cabeceras pueden aparecer durante fetch. Un proyecto equivocado con URL válida normalmente genera HTTP, no necesariamente TypeError. No concluir que duration_ms=0 demuestra por sí solo qué instrucción falló.

## Archivos y pruebas

- `src/index.ts`: harness, ocho pruebas seleccionables, puerta de acceso independiente.
- `wrangler.jsonc`: nombre distinto, misma fecha de compatibilidad, workers_dev y preview_urls desactivados.
- `.dev.vars.example`: nombres de variables; ninguna credencial real incluida.
- `tests/probes.spec.ts`, `playwright.config.ts`, `tsconfig.json`: pruebas/configuración independientes.

Desde la raíz del repositorio:

```powershell
node node_modules/@playwright/test/cli.js test -c worker/auth-diagnostic/playwright.config.ts
node node_modules/typescript/bin/tsc -p worker/auth-diagnostic/tsconfig.json
```

Resultado inicial: **23/23 pruebas locales correctas**, comprobación TypeScript correcta y las tres pruebas de construcción verificadas además en workerd real local. Los mocks validan controles/saneamiento; no certifican la red de Cloudflare.

## Ejecución independiente

No requiere instalar dependencias del proyecto ni modificar package.json. Wrangler puede descargarse a la caché de npx si no está disponible. Nunca usar la configuración de worker/api para este diagnóstico.

1. Crear el archivo local solo si no existe:

```powershell
Set-Location E:\Project_CAI_Market
if (-not (Test-Path worker/auth-diagnostic/.dev.vars)) {
  Copy-Item worker/auth-diagnostic/.dev.vars.example worker/auth-diagnostic/.dev.vars
}
```

Editar ese archivo local ignorado por Git. Reemplazar DIAGNOSTIC_ACCESS_KEY por una clave aleatoria independiente de al menos 32 caracteres (sin comillas). Las pruebas construct-* no requieren configurar SUPABASE_URL ni SUPABASE_PUBLISHABLE_KEY. Para las pruebas de conectividad usar la URL raíz HTTPS del proyecto Supabase alojado y solo su clave **publishable**. No copiar JWT, service_role ni contraseñas. No incluir variables en comandos, capturas ni commits. El host saliente está limitado a un subdominio de supabase.co sin credenciales, puerto, query ni ruta arbitraria; dominios personalizados se rechazan deliberadamente.

2. Ejecutar localmente (terminal A):

```powershell
npx wrangler@4.152.0 dev --config worker/auth-diagnostic/wrangler.jsonc --local --ip 127.0.0.1 --port 8791
```

3. En terminal B, cargar únicamente la clave del operador en memoria, sin imprimirla, y ejecutar una prueba:

```powershell
$diagnosticKeyLine = Get-Content worker/auth-diagnostic/.dev.vars |
  Where-Object { $_ -match '^DIAGNOSTIC_ACCESS_KEY=' } | Select-Object -First 1
$diagnosticKey = $diagnosticKeyLine -replace '^DIAGNOSTIC_ACCESS_KEY=', ''
$diagnosticHeaders = @{ 'X-Diagnostic-Key' = $diagnosticKey }
Invoke-RestMethod -Uri http://127.0.0.1:8791/probe/construct-manual -Method Post -Headers $diagnosticHeaders
Invoke-RestMethod -Uri http://127.0.0.1:8791/probe/construct-error -Method Post -Headers $diagnosticHeaders
Invoke-RestMethod -Uri http://127.0.0.1:8791/probe/construct-timeout -Method Post -Headers $diagnosticHeaders
```

Las ocho rutas válidas son:

| Sufijo de /probe/ | Qué compara |
| --- | --- |
| construct-manual | Construcción manual sin red ni Supabase. |
| construct-error | Construcción error sin red: debe reproducir TypeError en workerd. |
| construct-timeout | Construcción manual + AbortSignal.timeout, sin red. |
| baseline | GET /auth/v1/user, sin encabezados de autenticación, manual, AbortController con límite 10 s. |
| headers-object | Misma petición, objeto de encabezados con publishable + JWT ficticio. |
| headers-instance | Igual que headers-object, usando instancia Headers. |
| timeout-signal | Igual que headers-object, sustituyendo el temporizador AbortController por AbortSignal.timeout. |
| redirect-error | Igual que timeout-signal con redirect:error: debe fallar antes de la red. |

Para probar conectividad, cambiar únicamente el sufijo de Invoke-RestMethod por baseline y después headers-object, headers-instance y timeout-signal. Un HTTP de Supabase (incluso 401/403 por el token ficticio) demuestra que se obtuvo respuesta; un 3xx se devuelve sin seguirlo y sin leer Location. No repetir masivamente ni interpretar un 200 del harness como éxito de autenticación: su JSON contiene el estado real del upstream. El harness devuelve 200 cuando ha ejecutado la prueba, incluso si esta encontró una excepción.

Para una futura comparación en el runtime remoto de Cloudflare, el comando del operador sería:

```powershell
npx wrangler@4.152.0 dev --config worker/auth-diagnostic/wrangler.jsonc --remote --ip 127.0.0.1 --port 8791
```

No se ejecutó ese comando. **Sube código y variables a una sesión preview temporal de Cloudflare**, aunque no publique CAI Market; requiere una cuenta y revisión del entorno elegido. Los valores de dev proceden del archivo separado, no se asume herencia de secretos de producción. Mantener la puerta X-Diagnostic-Key también en preview y detener la sesión al terminar. No ejecutar deploy ni secrets put. Ctrl+C detiene el servidor local; borrar el archivo .dev.vars del harness al dejar de necesitarlo.

## Seguridad e interpretación

Sin DIAGNOSTIC_ACCESS_KEY válida se devuelve 403; Origin está prohibido, no hay CORS, solo POST y rutas fijas sin parámetros, ningún target enviado por el cliente se utiliza. Nunca se reenvían sus encabezados o cuerpo. Las consultas de red están limitadas a 10 s y no siguen redirecciones. No se leen cuerpos de Supabase, ni siquiera para extraer errores; se cancela el stream. No se invoca la RPC.

Los únicos datos emitidos mediante console.log y devueltos son event/probe/phase fijos, duration_ms, upstream_status, exception_type normalizado y timeout. Sin URL, claves, Authorization, cuerpos, datos de usuario, nombres arbitrarios de errores, mensajes originales ni trazas. Los logs del runtime/herramientas son una superficie separada: no activar dumps, -v, impresión de bindings ni capturas de archivos locales. Las respuestas HTTP locales siempre llevan Cache-Control:no-store.

Si falla config, revisar las variables sin imprimirlas. Si falla headers, comprobar valores pegados/CRLF/caracteres no válidos. Si falla signal, comprobar runtime/contexto. Si construct-error falla pero construct-manual y construct-timeout pasan, se aísla redirect:error independientemente de la red. Si solo fetch falla tras construir Request, investigar transporte; un TypeError sin mensaje original no identifica por sí solo DNS frente a TLS. No convertir esto en una corrección definitiva ni cambiar políticas de redirección del API sin revisar ambas llamadas Auth/RPC.

Fuentes primarias consultadas:

- [Cloudflare Request: redirect error no implementado](https://developers.cloudflare.com/workers/runtime-apis/request/).
- [Código de workerd: tryParseRedirect y construcción Request](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B).
- [Cloudflare: AbortSignal.timeout requiere contexto de solicitud](https://developers.cloudflare.com/changelog/post/2026-08-19-abort-signal-global-scope/).
- [Fetch Standard: encabezados y valores byte-sequence](https://fetch.spec.whatwg.org/).
- [Cloudflare: variables de desarrollo](https://developers.cloudflare.com/workers/local-development/environment-variables/).
