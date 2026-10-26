# V1.1: verificación real de Cloudflare, 26/10/2026

Consulta de metadatos realizada aproximadamente a las 06:56 Colombia. Cuenta
`f2f2dcbac86bc1a805d13cc387c8a568`. No se publicaron Workers o Pages, no se
modificaron variables, secretos, dominios, reglas R2 ni datos de objetos.

## Estado comprobado

| Componente | Resultado de lectura real |
| --- | --- |
| Worker | `cai-market-api`, versión `84dea860-d785-4387-994b-9bac21126178` al 100 % |
| Deployment Worker | `e0c5538e-bd41-4b37-b375-ef3cbb1127fe` |
| Versión V1 para reversión | GET de la versión anterior a V1.1 devuelve 200; es la versión activa arriba indicada |
| Bindings | Exactamente `ALLOWED_ORIGIN`, `MEDIA`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL` |
| Supabase | Coincide con `https://sauoekefntzxhqxycdgo.supabase.co` |
| CORS del Worker | Origen configurado `https://project-market.pages.dev` |
| Clave Supabase | Formato publishable; no hay binding de service_role, contraseña o clave administrativa |
| MEDIA | Binding nativo `r2_bucket` → bucket existente `cai-market-media` |
| R2 | Bucket existente, región ENAM, almacenamiento Standard |
| Acceso público R2 | `r2.dev` deshabilitado; lista de dominios personalizados vacía |
| CORS del bucket | No configurado: GET devuelve 404, código 10059; confirmado como ausencia de configuración |
| Lifecycle | Una regla activa de cancelación de multipart incompleto; no se observó regla de eliminación de objetos ni transición de almacenamiento |
| Locks del bucket | Lista vacía |
| Pages | `cai-market`, dominio `project-market.pages.dev`, rama de producción `main` |
| Git Pages | `brysof22-ux/Project_Market`; despliegue automático de producción habilitado |
| Build Pages | `npm run build`, salida `dist`, raíz del repositorio |
| Variables VITE de producción | Exactamente las tres autorizadas; destinos de Supabase/API coinciden y clave publishable válida por formato |
| Pages publicado/reversión | Deployment `6885df5d-0e86-4c00-8a4b-bd5fa1d6ce77`, production/success; GET específico 200 |
| Commit publicado | `6ee1211bac5a9b6958994ea6cb2b4a7b3650426b`, rama `main` |

Las variables se compararon en memoria y sólo se registraron nombres, tipos y
booleanos de coincidencia. No se registraron sus valores ni credenciales.

La sesión OAuth local de Wrangler había caducado: las primeras lecturas devolvieron
401 y algunas 429. `wrangler whoami` renovó la sesión local de forma normal y
terminó con código 0, sin intervención ni despliegue. Se repitieron las lecturas
secuencialmente y se obtuvieron los resultados anteriores. Los logs privados del
CLI y el token permanecen fuera de Git; no forman parte de este informe.

## R2: capacidad del binding y límite de lo verificado

La [API de R2 para Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
proporciona lectura, escritura, listado y eliminación mediante el binding. No
requiere entregar credenciales S3 al frontend. La configuración real encontrada es
compatible con `MEDIA.get()` y `MEDIA.put()` utilizados por V1.1.

No se realizó una prueba de escritura o recuperación de un objeto remoto: el
Worker V1 publicado todavía no tiene el endpoint de imágenes V1.1. Publicar un
Worker de diagnóstico para probarlo excedería esta fase. Tampoco se enumeraron ni
descargaron fotografías comerciales. Por tanto, este informe acredita existencia,
vinculación y privacidad del bucket; no presenta un PUT/GET remoto como ejecutado.

El navegador de V1.1 habla con el Worker autenticado; el Worker accede a R2 a través
del binding. La ausencia de [CORS del bucket](https://developers.cloudflare.com/r2/buckets/cors/)
no impide ese flujo. No hace falta abrir el bucket ni añadir URLs con JWT. El
Worker aplica su propia lista de orígenes y cabeceras de preflight. R2 público
puede habilitarse mediante `r2.dev` o dominios propios de forma independiente;
ambas vías se verificaron deshabilitadas/ausentes según la [documentación oficial](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Una prueba remota futura debe estar autorizada e incluir un producto de prueba
identificado, una imagen raster generada sin contenido comercial y el endpoint
V1.1 autenticado como administrador. Debe verificar: POST con CAS y período
esperado, GET con Authorization, igualdad del contenido sanitizado, no-store,
nosniff, rechazo de acceso anónimo y rechazo de carga por cajero. No reutilizar una
foto, producto o identificador comercial; cualquier alta o limpieza sobre la base
de producción necesita autorización específica. Mientras no se autorice, ejecutar
estas pruebas contra PostgreSQL/R2 local y mantener pendiente el ensayo real.

## No utilizar Preview

La política existente de Pages para ramas no productivas es `all`. No se cambió.
El build de `feature/cai-market-v1.1` está bloqueado localmente; no se debe subir esa
rama para provocar intentos Preview. La publicación futura debe hacerse mediante
el flujo autorizado de commit e integración local, comprobación de `main` remoto,
fast-forward y push de `main`, sin crear proyectos o entornos adicionales.

## Orden y recuperación de Cloudflare

El dry-run local de Wrangler 4.152.0 terminó con código 0, sin publicación. Artefacto
generado: 31.697 bytes; SHA-256
`5885aa0854f23abe0f01bdd80ec9748e0d2827376dc56d75398d1455c2d51cfa`, registrado en
`.cache/v11-cloudflare/worker-dry-run.json`. El escaneo del bundle no detectó los
patrones de credenciales privadas comprobados. No se verificó un PUT/GET remoto
mediante ese dry-run, que sólo compila y muestra los bindings preparados.

Antes de publicar: respaldo restaurado y ensayo de 009 aprobados, hash SQL y
artefactos fijados, ventana sin escritores, perfiles Supervisor identificados y
cuenta de prueba autorizada. Mantener la ventana hasta completar los tres
componentes: Supabase 009 → Worker V1.1 → Pages V1.1.

Comando Worker preparado, **no ejecutado**:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = 'f2f2dcbac86bc1a805d13cc387c8a568'
$env:CLOUDFLARE_SEND_METRICS = 'false'
$env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
node .cache/npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js deploy --config worker/api/wrangler.jsonc --keep-vars --message 'CAI Market V1.1: periodos, permisos y fotografias privadas'
```

Conservar los cuatro bindings, variables/secretos y bucket existentes. El comando
publica inmediatamente y sólo debe ejecutarse después de autorización explícita y
de la validación de 009. Guardar el nuevo version ID y verificar health, CORS,
JWT ficticio rechazado, rutas protegidas y sesión autorizada sin ventas reales.

Reversión técnica de Worker preparada, **no ejecutada**:

```powershell
node .cache/npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js rollback 84dea860-d785-4387-994b-9bac21126178 --config worker/api/wrangler.jsonc --name cai-market-api --message 'Reversion controlada V1.1; mantener operacion detenida'
```

Cloudflare permite [rollback de versiones del Worker](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
pero no revierte su base de datos, R2 o datos ya escritos. Para Pages, el destino
técnico anterior a V1.1 es `6885df5d-0e86-4c00-8a4b-bd5fa1d6ce77`; el [rollback de Pages](https://developers.cloudflare.com/pages/configuration/rollbacks/)
se prepara con `POST /accounts/{account}/pages/projects/cai-market/deployments/6885df5d-0e86-4c00-8a4b-bd5fa1d6ce77/rollback`,
seguido de GET del proyecto para confirmar el deployment canónico. No se ejecutó
esa solicitud POST ni se generó una nueva publicación.

**Límite crítico:** después de 009, volver únicamente a Worker/Pages V1 no recupera
las escrituras. V1 no envía `expected_period` ni `expected_total` y las funciones
V1.1 los rechazan deliberadamente. La recuperación debe conservar la operación
detenida y usar una corrección compatible con V1.1 ensayada; una restauración de
Supabase requiere otra autorización y evaluación de operaciones posteriores al
respaldo. No hay una reversión automática segura de toda la operación comercial.

## Evidencia reproducible

`node scripts/v11/verify-cloudflare-readonly.mjs` consulta sólo endpoints GET
fijados a la infraestructura autorizada y escribe un informe saneado en
`.cache/v11-cloudflare/read-report.json`. No acepta SQL, no consulta objetos R2 y
no contiene una rama de despliegue o cambio de configuración. Requiere una sesión
Wrangler local ya autenticada y no muestra el token.

Evidencia local adicional, ignorada por Git: `.cache/v11-cloudflare/`.
