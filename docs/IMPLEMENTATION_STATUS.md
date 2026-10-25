# Implementación local y verificación

Fecha: **2026-10-25**, America/Mexico_City. Código implementado en ambos árboles de trabajo, sin commit/push/merge/deploy. No se crearon tipos, alimentos, usuarios ni medidas reales, no se alteraron servicios externos y no se inspeccionaron credenciales. Las pruebas emplean SQLite/datos/llaves sintéticos; los builds y la regresión final usan copias aisladas sin `.env`, backups ni datos privados.

## Autorización de publicación posterior

El 2026-10-25 el propietario autorizó crear commits, subir `feature/personalizacion-nutricion`, integrarla en `main` y publicar ambas ramas de producción sin force push. El estado «sin commit/push/merge/deploy» del registro anterior describe el cierre de implementación, antes de esta autorización. Esta publicación de código no configura Auth0 ni variables Railway y no demuestra por sí sola que el despliegue o la conexión ChatGPT hayan terminado. La comprobación de refs remotas y estado del proveedor se informa al finalizar la publicación.

## Ampliación OAuth de administración nutricional (2026-10-25)

Implementada después de la regresión completa original: OAuth admite las tres herramientas existentes de administración con `mcp:destroy`, flag adicional y confirmación. La validación JWT/identidad no se relaja. Editar/borrar relee el día del usuario autenticado dentro de la transacción, compara `expected_revision` con `items_revision` y verifica UUID preferido o índice legado; rechaza objetivos obsoletos/ambiguos. El nuevo contrato también exige revisión para PAT. Se conserva la fila del día, agua, notas y medidas corporales. Se generan tombstones para UUID eliminados y se fecha la edición para resolver replays offline.

Verificación de esta ampliación: **170 pruebas relevantes pasaron, 0 fallaron y 0 omitidas**, con Node 20.20.2, HTTP/SDK reales y SQLite temporal. Comando en copia aislada: `node --experimental-global-webcrypto --test scripts/mcp-*.test.js scripts/diary-merge.test.js scripts/diary-merge-echo.test.js scripts/public-api-v1-wiring.test.js scripts/body-source-client.test.js`. Incluye catálogo/metadata, scopes y RBAC sin elevación, flag apagado, confirmación, creación de alimento del dueño, UUID/índices/revisiones, otro usuario, días ausentes/borrados, legado, conservación corporal y replay por diario/sync. La prueba de replay detectó una discrepancia inicial en el nombre de `kind` del tombstone; se corrigió al contrato existente `item` y la regresión final pasó.

No se repitieron la suite completa ni los builds de UI: esta ampliación cambia código servidor/MCP y documentación. Los 928 tests y builds de la tabla siguiente corresponden a la implementación anterior. No se modificó Gym Log en esta ampliación, ni Auth0, variables reales o datos de producción. Sigue pendiente conceder el nuevo scope y reautorizar/refrescar ChatGPT según [la guía actualizada](chatgpt-mcp.md).

## Resultado funcional

**Gym Log:** notas existentes accesibles al crear/editar/consultar mediciones; al editar solo notas conserva unidad e instante originales. Preparación controlada e idempotente de cinco tipos BIA con `%` y kg; conserva IDs, detecta duplicados y unidades incompatibles y exige mapa explícito ante tipos genéricos ambiguos. No se añadieron fórmulas, entidades, almacenamiento ni autenticación nuevos. Google Sheets/Drive siguen a cargo de los servicios y protocolo originales.

**NutriTrace:** default `internal` mantiene upstream. Modo `gym-log` oculta y bloquea nuevas capturas corporales, preserva legado y nutrición y desactiva autoestimaciones con peso no canónico. Guardas comunes TEMP en la conexión SQLite cubren proveedores/importadores/sync sin una migración persistente. Se conservan pasos, sueño y recuperación, incluido Body Battery. Una carga mixta informa conflictos que el cliente retiene por servidor/cuenta y permite exportar; una respuesta tardía de otra cuenta no se muestra ni se guarda en la cuenta activa. El aviso se monta fuera de las ramas de login/setup para estar disponible en el uso normal.

**MCP/OAuth:** transporte existente `/api/mcp`, PAT compatible, discovery raíz y sufijo incluso con BASE_URL, JWT/JWKS, identidad/cliente/audience y exp/iat estrictos, mapping explícito a cuenta existente, scopes por tool, challenges y CORS/Origin. La ampliación posterior permite `create_food`, `edit_diary_entry` y `delete_diary_entry` con `mcp:destroy`, flag y confirmación; en modo Gym tampoco obtiene herramientas corporales. Se reutilizan alimentos/comidas/agua y lecturas. Nueva `set_nutrition_goals` exige permiso específico, confirmación y comparación esperada en transacción; conserva campos no modificados. No hay integración servidor-servidor ni otro historial corporal.

## Pruebas ejecutadas realmente

| Verificación | Resultado |
|---|---|
| NutriTrace, regresión completa `npm test` con Node **20.20.2**, DB temporal y secreto sintético | **928 pasaron; 0 fallaron; 0 omitidas** |
| Gym Log, `npm test` / Vitest en copia aislada | **142 pasaron en 16 archivos** |
| Suite focalizada OAuth/body/client/recetas/Docker COPY | **23 pasaron**, sin omisiones |
| Última comprobación OAuth/client, incluida indisponibilidad de adaptive con peso legado | **15 pasaron**, sin omisiones; subconjunto de las suites anteriores |
| NutriTrace, `npm run build` con Node 20, Svelte/Vite + generación PWA | **Pasó**; también se comprobó con Node 24 |
| Gym Log, `npm run build`, Next 16.2.10/Turbopack y TypeScript | **Pasó**, incluida generación de rutas estáticas/dinámicas |
| Compilación individual de componentes Svelte modificados y `git diff --check` en ambos repos | **Pasaron** |
| Build de imagen Docker | **No ejecutable:** Docker no está disponible en esta distro WSL |
| Auth0, refresh/revocar grant real e instalación/registro real desde ChatGPT | **No ejecutados:** requieren configuración externa y despliegue autorizados |
| UI en teléfono real/PWA offline en Android y APK/trabajadores nativos en dispositivo | **No ejecutados en dispositivo**; JS/sync/offline se probaron con fixtures y build PWA |

La suite nueva usa Express y SDK MCP reales sobre HTTP local, SQLite real temporal y firmas RSA sintéticas. Cubre initialize/list/call, comida/alimento/agua y lectura posterior, scopes negativos, dueño/cliente/audience/exp/iat, token alterado/algoritmo incorrecto, PAT revocado, metadata con Host manipulado y BASE_URL, JWKS simulado por HTTPS sin consultar Auth0, flags, Origin/preflight/405, permisos de metas y conflictos, registros corporales denegados, datos nutricionales mixtos, legado y Body Battery. Los tests existentes ejercitan API, recetas, sincronización nativa, offline, identidades y cambios concurrentes. Las pruebas Gym usan el repositorio/protocolo simulado, no Google real.

Las pruebas de refresh usan nuevas credenciales emitidas/sintéticas y rechazo por tiempo/corte; **no prueban** que Auth0 entregue refresh tokens a ChatGPT en la cuenta real. Los JWT existentes siguen siendo válidos hasta expirar salvo corte operativo; no se promete revocación instantánea por logout.

Los builds se efectuaron en `/tmp/nutritrace-verify` y `/tmp/gym-log-verify`, sin cargar entornos personales. Node 20 se instaló temporalmente para el binding existente de better-sqlite3. No se cambió Node del sistema. La compilación frontend conserva advertencias previas de accesibilidad/chunks: no equivalen a una prueba manual de UX ni bloquearon el build.

## Hallazgos corregidos durante implementación y autorrevisión

- PAT write/destroy podía descubrir/ejecutar lecturas sin `mcp:read`: ahora hay registro filtrado y guarda efectiva por llamada.
- Fechas PAT inválidas podían no caducar: alta rechaza fechas inválidas/pasadas y lookup rechaza expiración malformada.
- REPLACE del diario destruía la fila previa: importación usa upsert y la política conserva los campos corporales legados.
- Diferencia entre hidratación bebida y agua corporal: agua en ml sigue siendo nutricional; composición va a Gym.
- Un filtro amplio `body_` habría bloqueado Body Battery: se restringió a métricas corporales y se probó conservación de recuperación.
- Se protege el destino de conflictos al cambiar cuenta durante HTTP; no se descartan silenciosamente cambios corporales pendientes.
- Se conserva instante/unidad al editar solo notas de una medición Gym; no se relabela un histórico por cambios de catálogo.
- SQLite 9 no compilaba con el Node 24 del entorno: se verificó con Node 20, igual que el Dockerfile existente.
- La primera regresión detectó conexiones keep-alive caducadas en el helper de alta de cuentas del entorno de pruebas y bindings faltantes en dos fixtures VM de recetas. Se corrigieron los fixtures y se repitió la regresión completa hasta quedar sin fallos. No se añadieron reintentos automáticos a las escrituras MCP del producto.

## Pasos manuales restantes, en orden

1. Revisar el diff y este reporte. Construir la imagen desde la raíz del fork en un entorno con Docker: `docker build -t nutritrace-personal:review .`. No se afirma verificado ese artefacto hasta ejecutar el comando y su smoke test aislado.
2. Preparar los tipos BIA con [el script y la guía Gym](../../gym-log/docs/body-bia-catalog.md), desde una lista real completa revisada. Aplicar solo las llamadas necesarias con autorización sobre datos de producción. No cambiar IDs/unidades históricas; reactivar un tipo archivado expresamente si corresponde.
3. Respaldar consistentemente DB/WAL/uploads y probar restauración aislada. Exportar/resolver outboxes corporales y actualizar clientes antes del modo Gym. No se realizó backup ni restauración de producción aquí.
4. Crear API/audience y cliente NutriTrace en Auth0, dueño y scopes separados de Gym, callback exacta de ChatGPT, PKCE S256 y refresh/TTL según la guía. No cambiar toggles globales del tenant a ciegas.
5. Provisionar variables privadas en Railway: `BODY_MEASUREMENTS_SOURCE=gym-log`, flags MCP/OAuth y `MCP_OAUTH_RESOURCE_URL`, `MCP_OAUTH_ISSUER`, `MCP_OAUTH_OWNER_SUB`, `MCP_OAUTH_USER_ID`, `MCP_OAUTH_CLIENT_ID`; corte opcional `MCP_OAUTH_VALID_AFTER`. Habilitar `MCP_DESTROY_ENABLED=1` y conceder `mcp:destroy` para la administración nutricional aprobada. No poner valores reales en Git o frontend. Ver [tabla completa](chatgpt-mcp.md).
6. Tras autorización de producción, desplegar exclusivamente el fork y verificar HTTPS, metadata, challenge anónimo, PAT/PWA y volumen persistente. Instalar OAuth en la misma cuenta ChatGPT donde Gym funciona; consentir lectura/escritura, metas y `mcp:destroy` según los permisos aprobados.
7. Ensayar lectura y registros nutricionales con fecha/valores acordados, verificar en PWA y probar metas, revocación/refresh y uso conjunto de ambas apps. Peso debe registrarse exclusivamente en Gym. Completar prueba de teclado, porciones, 360/390 px y offline en el teléfono real.

No se debe declarar completado el criterio de conexión real con ChatGPT con base en mocks. No es necesario contratar un backend, base, sincronizador ni una API de modelos nuevos.

## Operación y rollback

Guías: [OAuth, Auth0, instalación y revocación](chatgpt-mcp.md), [nutrición personal, offline y conflictos](PERSONAL_NUTRITION.md), [Railway, backup y rollback](../DEPLOY.md), [plan actualizado](INTEGRATION_PLAN.md).

Para desactivar solo OAuth, apagar su flag y reiniciar conserva PAT/PWA y la política Gym. Para cortar JWT antiguos al reactivar, revocar grant/refresh en el proveedor y fijar `MCP_OAUTH_VALID_AFTER`. Un JWT ya emitido puede vivir hasta expirar; la revocación del grant sola no lo invalida inmediatamente. No hay cambios de esquema que revertir. Revertir toda la imagen a upstream sin la política reabre captura/importación corporal: detener escritores/clientes y revisar antes de hacerlo. No borrar historial ni restaurar una DB de forma automática para revertir código.

Los append nutricionales siguen sin idempotencia persistente: ante resultado ambiguo, leer y resolver con el usuario, sin repetir a ciegas. Las correcciones de cantidades y recetas originales se conservan en UI; la ampliación OAuth aprobada exige confirmación, scope específico y revisión previa para corregir/borrar una entrada. Estas limitaciones se documentaron y probaron, no se ocultaron como funcionalidades completas.

## Inventario de archivos modificados y nuevos

### nutritrace (58 archivos)

- `.dockerignore`
- `.env.example`
- `DEPLOY.md`
- `Dockerfile`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/INTEGRATION_PLAN.md`
- `docs/PERSONAL_NUTRITION.md`
- `docs/chatgpt-mcp.md`
- `docs/public-api.md`
- `scripts/android-sync.test.js`
- `scripts/body-source-client.test.js`
- `scripts/mcp-oauth-body.test.js`
- `scripts/recipe-image-sync.test.js`
- `scripts/recipe-servings-sync.test.js`
- `server/db.js`
- `server/email.js`
- `server/index.js`
- `server/lib/adaptive-tdee.js`
- `server/lib/api-tokens.js`
- `server/lib/body-source-policy.js`
- `server/lib/mcp/auth-policy.js`
- `server/lib/mcp/oauth-auth.js`
- `server/lib/mcp/oauth-config.js`
- `server/lib/mcp/server.js`
- `server/lib/mcp/tools/goals.js`
- `server/lib/mcp/tools/index.js`
- `server/lib/mcp/tools/log-body-stat.js`
- `server/lib/mcp/tools/set-nutrition-goals.js`
- `server/lib/scheduler.js`
- `server/middleware/body-write-policy.js`
- `server/middleware/mcp-auth.js`
- `server/package-lock.json`
- `server/package.json`
- `server/routes/app-config.js`
- `server/routes/data.js`
- `server/routes/mcp-metadata.js`
- `server/routes/mcp.js`
- `src/App.svelte`
- `src/components/ai/Trace.svelte`
- `src/components/diary/AddActivitySheet.svelte`
- `src/components/settings/SettingsNotifications.svelte`
- `src/lib/adaptive-tdee-local.js`
- `src/lib/api.js`
- `src/lib/body-source.js`
- `src/lib/db-native.js`
- `src/lib/notifications.js`
- `src/lib/offline-api.js`
- `src/lib/sync.js`
- `src/routes/Diary.svelte`
- `src/routes/Goals.svelte`
- `src/routes/Settings.svelte`
- `src/routes/Statistics.svelte`
- `src/routes/Wellness.svelte`
- `src/routes/Wizard.svelte`
- `src/routes/settings/BodyStats.svelte`
- `src/routes/settings/Diary.svelte`
- `src/stores/diary.js`
- `src/stores/settings.js`


### gym-log (5 archivos)

- `docs/body-bia-catalog.md`
- `scripts/prepare-body-catalog.mjs`
- `src/app/page.tsx`
- `src/lib/body-catalog.test.ts`
- `src/server/tools/services.test.ts`



## Corrección de discovery y diagnóstico de producción (2026-10-25)

El propietario confirmó instalación y login OAuth, pero Refresh tools falla. Los logs reales compartidos muestran POST 403 antes del catálogo; no contienen todavía el motivo de rechazo. No se atribuye ese 403 a esquemas o a versiones sin evidencia.

Se reprodujo con el cliente MCP oficial que SDK 1.30 descarta el descriptor principal `securitySchemes`; se corrigió en el transporte manteniendo el espejo `_meta`. La prueba falló antes y pasó después. El cliente real negoció 2025-11-25, recibió 19 tools estables en modo Gym, incluidas las seis requeridas, y validó todos sus esquemas con JSON Schema. Se añadieron logs de campos permitidos para correlacionar método/versión/estado/request_id, scopes efectivos y motivos de rechazo sin credenciales, claims personales ni argumentos.

Regresión focalizada final: **135 pruebas pasaron, 0 fallaron, 0 omitidas**, con `node --experimental-global-webcrypto --test scripts/mcp-*.test.js scripts/public-api-v1-wiring.test.js scripts/body-source-client.test.js`, Node 20.20.2 y copia aislada. No se repitieron la suite completa ni los builds UI. No se alteraron datos reales, Auth0 ni Gym Log. La validación autenticada final en ChatGPT/Railway requiere volver a refrescar y comprobar la línea nueva de diagnóstico; no se declara resuelta la conexión real solo por los tests locales. Ver [procedimiento](chatgpt-mcp.md#diagnóstico-de-authentication-succeeded-action-discovery-failed).
