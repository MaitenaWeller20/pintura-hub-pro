/**
 * La antigua "Rendición de caja" (reporte por fecha) se unificó con el Arqueo en
 * una sola pantalla /arqueo ("Rendición de caja"), que opera sobre la sesión: la
 * caja se abre sola con la primera venta, el fondo se hereda del cierre anterior y
 * el conteo/diferencia/cierre viven ahí. Esta ruta redirige para no romper links.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/caja")({
  beforeLoad: () => {
    throw redirect({ to: "/arqueo" });
  },
});
