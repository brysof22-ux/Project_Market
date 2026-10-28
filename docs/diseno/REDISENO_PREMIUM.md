# CAI Market · Rediseño visual y UX/UI

## Alcance y diagnóstico

Trabajo realizado sobre la aplicación existente, con React 19, TypeScript, Vite, Tailwind CSS 4, Radix Dialog, Lucide y Recharts. No se instalaron dependencias ni se reconstruyó la arquitectura.

Se inspeccionaron las nueve vistas reales mediante Playwright, autenticación de pruebas y el Worker existente conectado a PostgreSQL/PGlite aislado. Las imágenes y registros de ese entorno son exclusivamente de pruebas. No se incorporaron datos ficticios al bundle publicado.

Problemas observados antes de implementar:

- Configuración colocaba siete tarjetas grandes antes del contenido y obligaba a recorrer una página extensa para encontrar los campos.
- Inventario repetía nombres completos en todas las acciones, ensanchando innecesariamente la tabla.
- Las reglas responsive reducían etiquetas, tablas e indicadores a tamaños difíciles de leer.
- Contabilidad desbordaba horizontalmente a 360 px por el ancho de las acciones.
- POS presentaba el carrito como una lista sin estructura y los pagos como un formulario largo con poca jerarquía.
- Estadísticas repetía «Datos registrados COP», mostraba numerosos gráficos simultáneos y utilizaba el mismo icono para todos los indicadores.
- La navegación móvil no gestionaba explícitamente el foco; algunos diálogos carecían de retorno al control que los abrió.
- El reinicio necesitaba una advertencia visual clara y un botón destructivo, conservando su lógica protegida.

## Sistema visual

`src/styles/interface.css` reúne los tokens y las reglas de presentación del rediseño. Se mantienen los estilos estructurales existentes de `src/index.css`.

- Verde profundo como identidad y navegación, superficies neutras y estados semánticos en ambos temas.
- Escala de espaciado de 4, 8, 12, 16, 24 y 32 px; radios de 8, 12 y 16 px.
- Texto de lectura a 13–14 px y campos de 16 px en móvil para evitar el zoom de entrada. Números financieros tabulares.
- Controles de 40–44 px, bordes discretos, sombras suaves y foco visible.
- Microinteracciones de 180 ms, estados de carga con skeleton y respeto de `prefers-reduced-motion`.
- No se añaden fuentes externas, imágenes decorativas, bibliotecas de animación ni dependencias.

## Mejoras por módulo

| Módulo | Implementación |
| --- | --- |
| Estructura general | Sidebar con identidad verde, opción de contraer en escritorio con nombres accesibles y tooltips; menú móvil con foco contenido, Escape y retorno al disparador. Header y búsqueda integrados; se retiró la franja repetida de texto operativo y el punto de notificaciones sin conteo real. |
| Configuración | Navegación secundaria lateral en escritorio y cuadrícula compacta en móvil. Encabezado contextual, metadatos del negocio, apariencia, mensajes de guardado y advertencia de cambios pendientes. Se conservan los siete grupos y el guard existente. |
| Punto de venta | Catálogo y carrito diferenciados, precios destacados, cantidades ± que usan el control existente, subtotales, total y botón principal. Pagos en dos columnas cuando caben; confirmación manual y QR intactos. |
| Inventario | Acciones compactas con iconos y nombres accesibles completos; estados Agotado/Stock bajo/Disponible, imágenes proporcionadas, búsqueda clara y columnas numéricas. |
| Estadísticas | Cuatro indicadores principales, detalle financiero secundario compacto, iconos relevantes y explicaciones reales. Se elimina la repetición de COP en cada tarjeta. Gráficas adicionales en un panel desplegable, sin suprimir información ni modificar cálculos. |
| Contabilidad | Estado de caja mediante texto y badge, pestañas adaptables, importes alineados y dirección de movimiento mediante flechas y etiquetas. Historial, arqueo, sesiones y exportaciones conservados. |
| Clientes y proveedores | Búsqueda visible, acciones compactas, estados y tablas con desplazamiento controlado. Formularios y validaciones existentes. |
| Deudas | Badges, resumen visual e importes tabulares; detalle, abonos, identidad de la persona, QR y reglas de crédito conservados. |
| Auditoría | Encabezado de actividad, acciones mediante badges, identificadores legibles, estado vacío y paginación. Misma consulta y resultados. |
| WhatsApp | Únicamente presentación de conexión, conteos y eventos existentes. No se activa, conecta ni modifica la integración. |
| Reiniciar operación | Zona de peligro, advertencia, resumen de alcance y confirmaciones ordenadas. Botón final rojo. Reautenticación, frase, motivo, casilla, intención temporal, concurrencia y llamadas originales se conservan. |

## Componentes y archivos

Componentes compartidos modificados:

- `src/components/layout.tsx`
- `src/components/common.tsx`
- `src/components/charts.tsx`
- `src/components/metric-tooltip.tsx`
- `src/components/ui/dialog.tsx`
- `src/features/catalog/common.tsx`

Módulos modificados:

- `src/features/catalog/directory.tsx`
- `src/features/inventory.tsx`
- `src/features/operations/pos.tsx`
- `src/features/operations/own-cash.tsx`
- `src/features/operations/cash.tsx`
- `src/features/operations/credits.tsx`
- `src/features/operations/sales.tsx`
- `src/features/operations/today-sales.tsx`
- `src/features/operations/financial-report.tsx`
- `src/features/operations/settings.tsx`
- `src/features/operations/reset.tsx`
- `src/features/operations/whatsapp-settings.tsx`

Se añade `src/styles/interface.css`, importado desde `src/main.tsx`. Las pruebas nuevas están en `tests/premium-ui.spec.ts` y `tests/premium-accessibility.spec.ts`. `tests/admin.spec.ts` abre el panel financiero antes de verificar sus gráficos; conserva todas sus comprobaciones.

## Verificación y capturas

Las capturas iniciales están en `.cache/premium/before/` y las finales en `.cache/premium/after/`. No contienen información de producción. La galería local `.cache/premium/comparacion.html` permite comparar los módulos y resoluciones. Los archivos generados permanecen fuera de Git.

La matriz principal recorre POS, inventario, estadísticas, contabilidad, clientes, proveedores, deudas, auditoría y configuración a **360, 834, 1280 y 1440 px**, verificando ausencia de desbordamiento de página y errores de consola. También se inspeccionan los siete grupos de Configuración, las cuatro áreas contables, ambos QR, formulario de producto y análisis financiero desplegado a 390 y 1440 px.

Las pruebas de accesibilidad comprueban navegación por teclado, foco móvil, sidebar compacto, búsqueda, tooltips mediante toque y puntero, Escape, retorno del foco del modal, cancelación sin guardar, tablas desplazables por teclado, movimiento reducido y contraste de textos/superficies/botón principal en ambos temas. La referencia es [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/); estas comprobaciones no equivalen a una certificación integral.

Durante el refinamiento se corrigió un contraste transitorio bajo al cambiar de tema: se eliminó la transición del fondo de los botones y se conservaron las transiciones de borde y sombra. También se corrigió la ayuda que quedaba detrás del menú móvil y se permitió mantener un tooltip abierto al mover el puntero a su contenido.

Comandos reproducibles:

```powershell
npm run build
npm run lint
npm run check:api
npm run check:credit
npm run test:api -- --workers=1
node --max-old-space-size=768 --wasm-num-compilation-tasks=1 --liftoff-only node_modules/@playwright/test/cli.js test --grep-invert 'reinicio|reiniciar|reset' --workers=1
node --max-old-space-size=768 --wasm-num-compilation-tasks=1 --liftoff-only node_modules/@playwright/test/cli.js test -c playwright.credit.config.ts tests/credit/reports.spec.ts tests/credit/catalog.spec.ts --workers=1
node scripts/check-v1-build.mjs
```

El recorrido final de navegador excluye las pruebas que confirman un reinicio. El rediseño inspecciona la presentación de esa zona sin pulsar verificación ni confirmación. Las operaciones comerciales de las pruebas utilizan únicamente la base aislada, nunca ventas reales.

## Publicación y límites

El despliegue se limita a GitHub `main` → Cloudflare Pages `cai-market`, siguiendo la integración existente. No requiere migraciones, actualización del Worker, modificación de secretos ni datos comerciales. La comprobación pública verifica el commit servido, sus assets, el login, rutas antiguas, diseño móvil y las protecciones de acceso sin autenticar.

Los recorridos autenticados completos se verifican localmente contra el Worker real y SQL aislado. En producción no se crean ventas, abonos, productos, sesiones ni reinicios para probar estilos.

Se conserva el aviso previo de Vite sobre el bundle principal mayor de 500 kB. Recharts continúa separado y las vistas conservan carga diferida. Una futura reducción del bundle y una auditoría manual con lector de pantalla completo pueden realizarse como tareas separadas; no se cambian contratos ni arquitectura para este rediseño.

Los resultados finales, commit y despliegue se entregan junto con el informe al completar las verificaciones.
