import { AlertTriangle } from "lucide-react";

const pasos = [
  "Abrí Facturación → Cola fiscal, entrá en «A revisar» y buscá el número de esta venta.",
  "Tocá «Corregir/reintentar». Leé el mensaje y revisá la letra de la factura, el CUIT, la razón social y la condición de IVA del receptor. Corregí sólo el dato que esté mal.",
  "Volvé a revisar los datos fiscales y confirmá la emisión de esta misma venta. No hagas otra venta ni vuelvas a cobrar.",
  "La factura está lista recién cuando el estado diga «Aprobado», tenga CAE y figure «Producción». Ahí sí podés abrir o imprimir el PDF de la factura.",
];

function ContenidoGuia({ ventaId }: { ventaId?: string }) {
  return (
    <>
      <p className="mt-1 text-sm">
        «Corregible» significa que la venta quedó guardada, pero todavía no tiene una factura
        autorizada por ARCA. Puede faltar un dato o haber un problema al emitirla.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
        {pasos.map((paso) => (
          <li key={paso}>{paso}</li>
        ))}
      </ol>
      <p className="mt-2 text-sm">
        Si el mensaje habla de certificado, punto de venta o conexión con ARCA, o si vuelve a
        fallar, avisá al encargado con el número de venta y el mensaje que apareció. No cambies
        datos para hacer pasar una factura que no corresponde.
      </p>
      {ventaId ? (
        <a
          className="mt-2 inline-block font-medium text-primary underline underline-offset-2"
          href={`/facturacion/cola?venta=${encodeURIComponent(ventaId)}`}
        >
          Ir a revisar esta venta
        </a>
      ) : null}
    </>
  );
}

export function GuiaEstadoCorregible({
  ventaId,
  compacta = false,
}: {
  ventaId?: string;
  compacta?: boolean;
}) {
  if (compacta) {
    return (
      <details className="mt-2 max-w-xs text-left text-xs">
        <summary className="cursor-pointer font-medium">
          Todavía no hay factura autorizada. Ver qué hacer
        </summary>
        <ContenidoGuia />
      </details>
    );
  }

  return (
    <div role="status" className="rounded-md border border-warning/40 bg-warning/5 p-3">
      <p className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        La factura de esta venta todavía no está autorizada
      </p>
      <ContenidoGuia ventaId={ventaId} />
    </div>
  );
}
