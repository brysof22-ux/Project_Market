# WhatsApp local — CAI Market V1.3

Proyecto Compose independiente `cai-market-whatsapp`: Evolution API oficial v2.3.7, PostgreSQL 15.15 y Redis 7.4.5. No usa Supabase para sesiones internas. Solo Evolution publica `127.0.0.1:18080`; PostgreSQL y Redis no publican puertos. Los volúmenes son persistentes.

## Estado comprobado

Docker Desktop 29.8.0 y Compose 5.5.1 están instalados; WSL2 está disponible. Docker Engine devuelve `502 Bad Gateway` en el named pipe `dockerDesktopLinuxEngine`. No fue posible levantar ni verificar Evolution, PostgreSQL o Redis; no se modificaron otros contenedores. WhatsApp permanece desactivado.

## Puesta en marcha

1. Reparar o iniciar Docker Desktop y comprobar `docker info`. Copiar `.env.example` a `.env` y asignar secretos aleatorios robustos a `EVOLUTION_API_KEY`, `POSTGRES_PASSWORD` y `REDIS_PASSWORD`. Para la contraseña PostgreSQL usar caracteres seguros para URI o codificarlos. No reutilizar credenciales de Supabase ni publicar la `.env`.
2. Ejecutar `scripts/Start-WhatsApp.ps1`. Solo arranca los servicios de este proyecto; conserva los volúmenes.
3. Abrir http://localhost:18080/manager, autenticar con la API key local y crear la instancia `cai-market` con integración `WHATSAPP-BAILEYS`. Solicitar el QR y escanearlo desde WhatsApp del propietario. La vinculación exige su intervención. No guardar el QR de vinculación en Git.
4. Ejecutar `scripts/Check-WhatsApp.ps1`. Debe informar `open`; una instancia creada o un contenedor activo no prueban que WhatsApp esté conectado. Reconectar desde el manager si hace falta.
5. Crear un túnel persistente en una zona DNS propia de Cloudflare. Ejemplo ilustrativo: `evolution.sudominio.com` → `http://evolution:8080` para el conector Docker. Configurar `TUNNEL_TOKEN` en `.env` y arrancar el perfil `tunnel`. La API key de Evolution sigue siendo obligatoria. Proteger el hostname con Cloudflare Access si está disponible y usar un service token en el Worker. No abrir puertos del router ni exponer el manager innecesariamente.
6. Configurar secretos del Worker `EVOLUTION_API_URL` (HTTPS persistente) y `EVOLUTION_API_KEY`; instancia `EVOLUTION_INSTANCE=cai-market`. El secreto interno `WHATSAPP_DISPATCH_SECRET` debe coincidir con el SHA-256 guardado en `pos.whatsapp_settings.worker_hash`. Para Cloudflare Access se admiten `CF_ACCESS_CLIENT_ID` y `CF_ACCESS_CLIENT_SECRET`. Nunca poner estos valores en React.
7. En Configuración → WhatsApp, registrar consentimiento explícito para el teléfono del cliente, comprobar conexión y activar avisos. La venta a crédito también permite registrar consentimiento expreso. Un consentimiento antiguo exclusivo para recordatorios no autoriza los nuevos avisos.
8. El mensaje de prueba exige seleccionar un contacto autorizado y confirmar específicamente ese envío. No se enviaron mensajes a clientes durante el desarrollo o despliegue.

`project-market.pages.dev` no es una zona DNS propia para crear el hostname del túnel. Si no hay un dominio compatible, debe proporcionarse uno. Un Quick Tunnel puede servir para ensayos manuales; el adaptador lo rechaza como endpoint definitivo.

Docker Desktop → Settings → General → Start Docker Desktop when you sign in habilita el arranque al iniciar Windows. Cuando el equipo se apaga, suspende o pierde internet, Evolution deja de estar disponible. La cola persistente de Supabase conserva trabajos; las ventas no dependen de la red de WhatsApp.

## Entrega, reintentos y restricciones

El adaptador distingue aceptación, rechazo definitivo, rechazo reintentable y resultado incierto. Un timeout después de un POST puede ocurrir después de la aceptación; no se reintenta ciegamente. Los resultados inciertos requieren revisión, evitando duplicados. La aceptación de Evolution no acredita entrega o lectura por el cliente. Los recordatorios se revalidan contra saldo, fecha y consentimiento antes del envío.

Baileys es una conexión no oficial y puede sufrir desconexiones o restricciones. No se garantiza disponibilidad permanente.

Fuentes: [Compose oficial](https://github.com/evolution-foundation/evolution-api/blob/main/docker-compose.yaml), [versión estable 2.3.7](https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7), [contrato oficial de mensajes](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts), [Cron de Cloudflare en UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
