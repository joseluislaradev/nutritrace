# NutriTrace nutricional y Gym como fuente corporal

`BODY_MEASUREMENTS_SOURCE=internal` conserva el comportamiento upstream. `gym-log` aplica la capacidad en backend y frontend; no modifica esquemas ni migra el historial.

En modo Gym se ocultan captura del diario/widget, pasos antropométricos del Wizard, campos corporales de Goals/Statistics/Wellness y recordatorios de pesaje. El Wizard permite metas explícitas de calorías/agua. Los cálculos TDEE adaptativo y MET basados en pesos legados no se usan; registro de alimentos, recetas, agua y metas fijas sigue disponible. No se crea otra serie ni un servicio de último peso.

La defensa de persistencia se instala al abrir la conexión SQLite mediante triggers **TEMP** y funciones de política, sin triggers persistentes ni cambio de versión de esquema. Cubre los escritores que comparten la conexión: diario, sync, importación y proveedores. Conserva valores corporales previos y descarta cambios nuevos, sin bloquear comidas/agua/notas. Protege también wellness corporal y ajustes antropométricos. Los endpoints corporales explícitos responden 403; MCP no registra las tools corporales. Las importaciones de diario usan upsert para no borrar el cuerpo legado mediante REPLACE. Los borrados de wellness corporal por refresco de proveedor se ignoran en este modo.

Una carga mixta informa `body_measurements_source`, `body_policy_notice` y `body_conflicts`. Los clientes actualizados conservan conflictos en almacenamiento por cuenta y servidor y ofrecen exportarlos desde un aviso visible. No se reenvían a Gym automáticamente. Exportar/revisar y resolver antes de descartar; no borrar la cola ni el almacenamiento del navegador para ocultar el problema. No hay límite que silenciosamente trunque conflictos no resueltos. Si no puede persistirse el conflicto, el cliente no debe darlo por resuelto. Los clientes antiguos no conocen esta interfaz: resolver sus outboxes antes de activar el modo y actualizar/reabrir la PWA.

Los datos corporales existentes permanecen como legado y son exportables. Restaurar un backup completo se bloquea por la API en modo Gym porque reemplaza datos/cuentas: una recuperación administrativa debe hacerse de manera aislada y revisada, antes de volver al modo personal. Las funciones internas originales siguen en el repositorio. No conectar básculas a NutriTrace para crear otro historial; conservar proveedores mixtos solo por pasos/sueño/actividad. Nunca interpretar ocultación de una métrica como eliminación de sus datos.

## Configuración nutricional existente

No se duplicaron diario, edición de cantidades, comidas frecuentes, favoritos, recientes, recetas/porciones, copia de comidas, scanner ni modo offline. Son funciones originales:

1. Ajustar idioma español y unidades métricas en Regional; seleccionar nutrientes relevantes y nombres de comidas.
2. Guardar desayunos/comidas habituales en la biblioteca. Registrar una copia/porción en el diario; un snack o dulce va como entrada individual, sin modificar la comida guardada.
3. Corregir la cantidad de la entrada del diario cuando sea necesario; comparar los totales diarios con las metas fijas explícitas.
4. Para comida mexicana, capturar productos/etiquetas reales y gramos por pieza o porción personal. Separar crudo/cocido, aceites y rendimiento de recetas. No asumir que todas las tortillas/tacos/tazas pesan igual ni que micronutriente ausente significa cero.
5. OFF/USDA y filtros de país/idioma ya existen. No se añadió catálogo masivo ni espejo local OFF. Crear contenido real queda en manos del usuario: no se escribieron alimentos ni ajustes de producción.
6. En Android, instalar la **PWA** desde el navegador y probar registro offline y reconciliación tras recuperar red. Se conserva el motor original; no se creó otra app móvil.

La política se propaga a la sesión y se cachea para offline. También hay guardas JS para el cliente nativo conectado y cancelación del pesaje al recibir la capacidad; el APK y sus trabajadores nativos en un dispositivo real no se compilaron ni validaron en esta tarea. No seguir usando un APK antiguo para introducir medidas NutriTrace. La aceptación móvil real incluye teclado, 360/390 px, porciones, cierre/reapertura y outbox; la compilación PWA no sustituye esas pruebas de dispositivo.

Antes de activar el modo en producción: exportar/resolver cambios corporales pendientes de cada cliente, actualizar los clientes, respaldar y comprobar el modo en una copia aislada. Nunca borrar ni fusionar historiales automáticamente. Las medidas nuevas se registran en Gym, con método/dispositivo en notas.
