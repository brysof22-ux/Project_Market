# Rama release/cai-market-v1

**Preparación de Pages definitiva, 25/10/2026:** Worker y SQL ya publicados; frontend V1 probado con variables de producción y CSP. No se creó commit ni se integró main. Procedimiento vigente y límites: [PREPARACION_PAGES_V1_20261025](PREPARACION_PAGES_V1_20261025.md). El informe histórico siguiente no autoriza una Preview.

Actualización 24/10/2026: el destino solicitado ahora es producción desde main y el Supabase original, sin Preview. El plan vigente es [PRODUCCION_V1.md](PRODUCCION_V1.md). El bloqueo de esta rama sigue evitando publicaciones automáticas ajenas a main y no afecta al build de producción. El texto siguiente documenta la decisión anterior.

Esta rama guarda CAI Market V1 para revisión en GitHub. No autoriza aplicar migraciones ni desplegar el Worker de producción.

Durante la preparación se consultó Pages en modo lectura: proyecto cai-market, dominio project-market.pages.dev, despliegue de producción desde main. La configuración descargada solo mostró variables de producción; no se verificó un entorno de Preview con Supabase y API aislados. El archivo de configuración descargado permanece en .cache, ignorado por Git, y no se publicó.

Por eso vite.config.ts rechaza la compilación cuando CF_PAGES_BRANCH=release/cai-market-v1. Un push puede iniciar un build de Pages automáticamente: este guard impide que ese build publique la nueva interfaz. La compilación local y main conservan su comportamiento. No basta una URL de Pages diferente para aislar las escrituras de la base de datos.

Para habilitar una prueba funcional faltan:

1. Proyecto Supabase de pruebas independiente y API de pruebas que apunte exclusivamente a ese proyecto, con cuentas/datos de prueba.
2. Esquema requerido por V1 validado allí mediante un procedimiento autorizado; no usar las migraciones pendientes para modificar producción.
3. Variables de Preview específicas VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY y VITE_API_URL. No heredar endpoints/secretos de producción ni introducir service_role en frontend.
4. CORS de la API de pruebas y CSP del frontend coherentes con el dominio Preview. Ningún cambio al Worker de producción.
5. Una vez verificado ese aislamiento, sustituir el bloqueo de esta rama por una comprobación del entorno aislado y publicar explícitamente una Preview. Nunca usar main ni promoverla a producción durante esa prueba.

Los archivos .env.local y .dev.vars no forman parte del commit. .env.example y .dev.vars.example solo contienen marcadores ficticios. Los respaldos, caches, configuración descargada, dist y artefactos de pruebas se excluyen. Las migraciones SQL se versionan como código; no fueron ejecutadas remotamente por esta publicación.
