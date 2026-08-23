# Task 14: inventario de smoke de producción

Este inventario es **sólo lectura** y se ejecuta únicamente después de recibir autoridad explícita
para inspeccionar el deployment. No autoriza desplegar, autenticarse con credenciales ajenas,
cambiar configuración, crear una venta/remito, emitir, conciliar ni llamar ARCA.

## Smoke automatizado sin sesión

`BASE_URL=https://… PW_DIR=… node scripts/smoke-prod.mjs` abre estas rutas y comprueba respuesta
HTTP, bundle hidratado y redirección al login:

| Ruta                         | Resultado esperado sin sesión   | Escritura |
| ---------------------------- | ------------------------------- | --------- |
| `/auth`                      | formulario **Ingresar** visible | ninguna   |
| `/presupuestos`              | login, no 404/pantalla vacía    | ninguna   |
| `/presupuestos/nuevo`        | login, no 404/pantalla vacía    | ninguna   |
| `/pagos-proveedores`         | login, no 404/pantalla vacía    | ninguna   |
| `/facturacion`               | login, no 404/pantalla vacía    | ninguna   |
| `/facturacion/cola`          | login, no 404/pantalla vacía    | ninguna   |
| `/facturacion/configuracion` | login, no 404/pantalla vacía    | ninguna   |

No se ingresan usuarios ni secretos en el script. No se sigue ningún CTA operativo.

## Verificación humana autenticada, también sólo lectura

Registrar operador, deployment ID y hora. No guardar cookies, tokens ni capturas con certificados.

- [ ] Admin abre `/facturacion/configuracion`; ve las empresas correctas y no aparece un error de
      carga. No toca **Generar CSR**, carga de certificado, enchufe, habilitación, PV ni evidencia A.
- [ ] Con `v2=false`, admin abre `/facturacion`; la navegación respeta el modo de mantenimiento o la
      configuración esperada.
- [ ] Cuando el gate futuro habilite v2 sólo para admins, admin abre `/facturacion/cola`; filtros,
      conteos y paginación cargan sin mutar filas.
- [ ] Empleado sin capacidad fiscal no puede abrir `/facturacion/cola` ni configuración.
- [ ] Empleado con capacidad fiscal, sólo después del gate futuro, puede leer únicamente la cola de
      su sucursal y nunca configuración.
- [ ] La consola no muestra errores nuevos y los logs no exponen claves, certificados, tickets,
      tokens, payloads de receptor ni SOAP/XML crudo.

## Acciones expresamente fuera del smoke

- Emitir o reintentar una factura/NC/ND.
- **Verificar con ARCA**, **Liberar**, **Bloquear**, **Habilitar producción** o probar el enchufe.
- Crear/cobrar/anular una venta, convertir un presupuesto o crear/aprobar un remito.
- Ejecutar `backfill_cola_fiscal`, editar flags o escribir el ledger de migraciones.
- Usar `INVOICING_MOCK_MODE=true` como protección del deployment.

El mock sólo existe con `NODE_ENV=test` + runner local + flag. Un deployment normal configurado en
homologación contacta ARCA homologación real; uno configurado en producción contacta ARCA
producción. Por eso este smoke no pulsa ninguna acción que llegue al servicio fiscal.

## Criterio de abort

Abortar ante status inesperado, 404, loop de auth, error de hidratación, ruta fiscal expuesta sin
permiso, datos de otra sucursal, secretos en consola/logs o cualquier request a ARCA. Conservar la
evidencia y establecer ambas banderas en `false` mediante el procedimiento autorizado; no reactivar
el escritor legado ni reenviar operaciones inciertas a ciegas.
