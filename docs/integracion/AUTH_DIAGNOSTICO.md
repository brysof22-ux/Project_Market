# Diagnóstico de AUTH_UNAVAILABLE antes de publicar

**Actualización V1:** el diagnóstico aislado reprodujo que workerd rechaza `redirect:error` al construir Request. La implementación local posterior utiliza `manual` tanto en Auth como en RPC y rechaza 3xx. No se desplegó ni se certificó el resultado remoto. Ver [diagnóstico reproducible](../../worker/auth-diagnostic/README.md) y [entrega V1](../ENTREGA_V1.md). El análisis que sigue documenta el estado investigado previamente.

Revisión local del 23/10/2026. Se implementó instrumentación temporal autorizada, conservando autenticación, CORS, timeout, caché y códigos/respuestas HTTP públicos. No se ejecutaron peticiones remotas, SQL, Wrangler remoto, despliegues ni commits; no se cambiaron variables ni configuración de Supabase. La causa concreta en Cloudflare todavía requiere observación desde su runtime.

## Hallazgo comprobado

En `worker/api/src/index.ts`, AUTH_UNAVAILABLE solo sale de dos ramas de la llamada a `/auth/v1/user`:

1. El bloque que crea AbortSignal.timeout y llama a fetch lanza una excepción.
2. Se recibe un estado fuera de 200–299, 400, 401 y 403.

Un 403 real, incluido `x-sb-error-code: bad_jwt`, se convierte en 401 UNAUTHORIZED antes de interpretar el cuerpo y nunca consulta la RPC. Supabase documenta bad_jwt como JWT inválido: es un resultado esperado para aaa.bbb.ccc. La prueba de PowerShell solo demuestra la respuesta desde ese cliente, con su configuración y red; no demuestra la respuesta desde Cloudflare.

La ausencia de token se rechaza antes de configuration/fetch; su 401 no prueba conectividad ni variables correctas. Configuración que no supera URL/clave produce SERVICE_UNAVAILABLE, no AUTH_UNAVAILABLE. Una URL de otro proyecto o endpoint equivocado puede superar esa validación sintáctica. El fallo de la migración/RPC produciría PROFILE_UNAVAILABLE, no AUTH_UNAVAILABLE.

## Hipótesis a distinguir

| Evidencia interna | Interpretación y siguiente paso |
| --- | --- |
| No Response y señal propia vencida / TimeoutError | Presupuesto de 10 s agotado; comprobar duración y si llegaron cabeceras. |
| No Response, señal no vencida, TypeError/Error | Transporte o runtime: DNS, TLS, red, redirección rechazada por redirect:error, opción no soportada. El nombre de excepción solo no distingue esas causas. |
| Response 429 | Límite de peticiones; observar Retry-After saneado y Auth logs; no reintentar tokens inválidos. |
| Response 5xx | Indisponibilidad del upstream o intermediario; correlacionar con Supabase. |
| Response 404/422/u otro estado | URL/ruta equivocada, gateway u otro contrato HTTP. |
| Response 403 bad_jwt y salida 401 | Comportamiento correcto. |
| Response 403 registrado pero salida AUTH_UNAVAILABLE | Verificar versión/ruta/entorno y correlación: no coincide con este código local. |

Los mocks de Node no reproducen DNS, TLS, gateway ni diferencias de workerd. `cache: no-store` está soportado por Workers por defecto desde 2024-11-11; el archivo local usa compatibility_date 2026-10-23, sin flag de desactivación. No es una incompatibilidad demostrada. Comparar la fecha/flags de la versión realmente activa antes de atribuirle el error o retirar la protección de caché.

Las variables de producción no certifican las de la sesión de desarrollo. Wrangler maneja archivos `.dev.vars` y variantes de entorno; revisar las fuentes efectivas del entorno concreto, no asumir que dev --remote hereda los secretos publicados. No imprimir valores: comprobar presencia, validez sintáctica y correspondencia con el proyecto previsto mediante comparación local.

## Instrumentación temporal implementada localmente

`worker/api/src/index.ts` emite JSON mediante `console.log` al completar o fallar el fetch de Auth, y al completar o fallar la lectura JSON de una respuesta exitosa. No devuelve detalles internos al cliente. Las únicas propiedades son:

- `event`: constante `auth_diagnostic`.
- `phase`: `auth_fetch` o `auth_body`.
- `duration_ms`: duración de esa fase, en milisegundos enteros no negativos.
- `upstream_status`: estado HTTP recibido de Supabase, o null si fetch no devolvió Response.
- `exception_type`: null si no hubo excepción; TypeError, TimeoutError, AbortError, SyntaxError, Error o UnknownError. Los nombres arbitrarios se descartan.
- `timeout`: true si la señal propia venció o la excepción normalizada es TimeoutError.

La señal propia conserva el presupuesto de 10000 ms. AbortError sin señal propia vencida no se marca como timeout. No se leen ni clasifican mensajes originales. TypeError/Error sin timeout siguen sin distinguir DNS, TLS, redirecciones u opciones del runtime: estos registros no demuestran por sí solos la causa concreta.

Ejemplos (duraciones ilustrativas):

```json
{"event":"auth_diagnostic","phase":"auth_fetch","duration_ms":143,"upstream_status":403,"exception_type":null,"timeout":false}
{"event":"auth_diagnostic","phase":"auth_fetch","duration_ms":10001,"upstream_status":null,"exception_type":"TimeoutError","timeout":true}
```

Un fetch HTTP 403/429/5xx genera un registro fetch y mantiene su mapeo público anterior. Auth 2xx con JSON leído genera fetch y body; los fallos de lectura generan body con excepción y conservan 502. Health, falta de token, rechazo CORS y fallo previo de configuración no generan registros Auth. Las llamadas a la RPC no se instrumentan. La instrumentación es de mejor esfuerzo: un fallo del logger no altera las respuestas públicas. Retirar `authException`, `logAuthDiagnostic` y sus llamadas al terminar el diagnóstico, restaurando el uso de `readJson(verified)` para el cuerpo Auth.

Mantener la observación del cuerpo separada: fetch puede resolver al recibir cabeceras y response.json() fallar después. Actualmente readJson transforma también esos fallos en 502 INVALID_UPSTREAM_RESPONSE. Por eso conviene registrar fase y señal, sin interpretar todo error de JSON como una respuesta HTTP inesperada.

No se registran Authorization, apikey, env, URLs, Request/Response completos, tokens completos o parciales, hashes del token, claims, correo, cuerpos de Auth, encabezados de respuesta, error.message ni stack. No se añade endpoint público de diagnóstico. Limitar duración/acceso/retención de los logs y evitar pruebas masivas de rechazo. No habilitar logging de cabeceras/cuerpos en la plataforma. Los cambios locales aún no están desplegados y no producen estos registros en el Worker publicado.

## Procedimiento desde Cloudflare

1. Identificar versión activa, ruta y entorno en Dashboard/deployments; comparar con el código inspeccionado. Revisar configuración y compatibilidad efectivas, incluidos valores de dev por separado. La existencia de bindings no garantiza correspondencia URL/clave.
2. Revisar la instrumentación local antes de ejecutarla en Cloudflare. La versión anterior captura la excepción sin loguearla: abrir tail sobre esa versión no recupera el error oculto. La ejecución de la versión instrumentada en Cloudflare queda pendiente; no se desplegó en esta tarea.
3. Una vez disponible la instrumentación, abrir logs privados de la versión de prueba. Para el Worker publicado:

```powershell
npx wrangler@4 deployments list --config worker/api/wrangler.jsonc --name cai-market-api
npx wrangler@4 tail cai-market-api --config worker/api/wrangler.jsonc --format pretty
```

No usar filtro de errores de ejecución: una respuesta 503 manejada puede tener outcome de invocación correcto. Tail del Worker publicado no sustituye los logs de una sesión preview/dev.

4. En otra terminal, una única petición con token ficticio (sin secretos reales):

```powershell
curl.exe -sS -i --max-time 15 -H "Authorization: Bearer aaa.bbb.ccc" https://cai-market-api.brysof22.workers.dev/api/me
```

Para preview, usar la URL/puerto de esa sesión. Seleccionar la invocación por hora en las herramientas privadas de Cloudflare y contrastar con Auth; el registro no añade identificadores. No usar -v ni exportar dumps de solicitudes con tokens reales. Si no aparece solicitud en Auth y el registro tiene excepción sin estado HTTP, investigar runtime/transporte; la ausencia en logs por sí sola también puede deberse a muestreo/retención.

5. Resolver según la rama observada. Solo después probar una sesión real, conservando JWT y clave publishable del mismo proyecto; nunca usar service_role ni saltarse Auth para probar la RPC. Aaa.bbb.ccc con 401 certifica ese rechazo, no el flujo válido /api/me ni el acceso a perfil.

## Compatibilidad de errores

No se encontró incompatibilidad para el 403 bad_jwt observado. Sí hay pérdida de detalle: todo 400/401/403 se trata como sesión inválida, aun cuando pueda proceder de una clave/gateway o WAF, y 429/5xx se agrupan como indisponibilidad. Después de obtener evidencia, se puede refinar la clasificación utilizando status y códigos conocidos. No convertir genéricamente todos los fallos en 401 ni interpretar cualquier 403 como bad_jwt.

## Validación local y fuentes

`npm run check:api` correcto. `npm run test:api`: **66/66** correctas. Se conservan las 46 pruebas previas y se añaden 20 en `tests/api/auth-diagnostics.spec.ts`: esquema cerrado de logs, ausencia de secretos/datos de usuario/cuerpos/mensajes/trazas, normalización de excepciones, HTTP 400/401/403/429/500/503, timeout propio incluso con TypeError, lectura de cuerpo, respuesta exitosa, logger averiado y rutas sin diagnóstico. Los timeouts se simulan; no se esperaron 10 s ni se validó workerd/red real.

- [Supabase Auth: códigos de error](https://supabase.com/docs/guides/auth/debugging/error-codes).
- [Cloudflare: compatibilidad de cache no-store](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-cache-no-store-http-standard-api).
- [Cloudflare: Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
- [Cloudflare: desarrollo local y remoto](https://developers.cloudflare.com/workers/local-development/).
- [Cloudflare: variables de desarrollo](https://developers.cloudflare.com/workers/local-development/environment-variables/).
- [Cloudflare: comandos Workers y tail](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
