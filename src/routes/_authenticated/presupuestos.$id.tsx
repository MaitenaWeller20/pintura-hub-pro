import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { fmtMoney, fmtDate } from "@/lib/format";
import { conIva } from "@/lib/fiscal/iva";
import { tablaDeItemsPresupuesto } from "@/lib/presupuesto-pdf";
import { toast } from "sonner";
import { ArrowLeft, Printer, AlertTriangle, Pencil } from "lucide-react";
import jsPDF from "jspdf";
import { dibujarEncabezado, traerLogo, SELECT_SUCURSAL_IMPRESA } from "@/lib/impresos/encabezado";
import autoTable from "jspdf-autotable";
import {
  DialogoConvertirPresupuesto,
  type PresupuestoConvertido,
} from "@/components/presupuestos/dialogo-convertir-presupuesto";
import { DialogoEmisionFiscal } from "@/components/fiscal/dialogo-emision-fiscal";
import { parseRespuestaConfirmacionFiscal } from "@/components/fiscal/dialogo-emision-contract";
import { listarReceptoresFiscales } from "@/lib/fiscal/cola.functions";
import { emitirComprobante, previsualizarEmisionFiscal } from "@/lib/fiscal.functions";
import { resultadoColaDespuesDeEmision } from "@/lib/ventas-ui";
import { CONDICION_IVA_CLIENTE } from "@/lib/fiscal/codigos";
import { mensajeCodigoErrorFiscalUsuario } from "@/lib/fiscal/error-usuario";
import {
  accionFiscalDespuesDeConvertirPresupuesto,
  destinoColaFiscalVentaConvertida,
} from "@/lib/presupuesto-ui";

export const Route = createFileRoute("/_authenticated/presupuestos/$id")({
  component: DetallePresupuesto,
});

function esMantenimiento(value: unknown): value is { estado: "MANTENIMIENTO"; mensaje: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).estado === "MANTENIMIENTO" &&
    typeof (value as Record<string, unknown>).mensaje === "string"
  );
}

function DetallePresupuesto() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: cu } = useCurrentUser();
  const [abrirConv, setAbrirConv] = useState(false);
  const [ventaParaFacturar, setVentaParaFacturar] = useState<{
    id: string;
    clienteId: string;
  } | null>(null);
  const botonConvertirRef = useRef<HTMLButtonElement>(null);
  const navegacionFiscalRef = useRef(false);
  const listarFavoritos = useServerFn(listarReceptoresFiscales);
  const previsualizarFiscal = useServerFn(previsualizarEmisionFiscal);
  const emitirFiscal = useServerFn(emitirComprobante);

  const { data: p } = useQuery({
    queryKey: ["presupuesto", id],
    queryFn: async () =>
      (
        await supabase
          .from("presupuestos")
          .select(
            `*, cliente:clientes(razon_social, cuit_dni), sucursal:sucursales(${SELECT_SUCURSAL_IMPRESA})`,
          )
          .eq("id", id)
          .maybeSingle()
      ).data,
  });
  const { data: items = [] } = useQuery({
    queryKey: ["presupuesto-items", id],
    queryFn: async () =>
      ((await supabase.from("presupuesto_items").select("*").eq("presupuesto_id", id)).data ??
        []) as any[],
  });
  const { data: clienteFiscal } = useQuery({
    queryKey: ["cliente-fiscal-presupuesto", ventaParaFacturar?.clienteId],
    enabled: !!ventaParaFacturar,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clientes")
        .select("id,razon_social,cuit_dni,tipo")
        .eq("id", ventaParaFacturar!.clienteId)
        .maybeSingle();
      if (error || !data) throw new Error("No se pudo leer el comprador de la venta convertida.");
      return data;
    },
  });
  const { data: favoritosFiscales = [] } = useQuery({
    queryKey: ["receptores-fiscales", p?.sucursal_id ?? null],
    enabled: !!ventaParaFacturar && !!p?.sucursal_id,
    queryFn: () => listarFavoritos({ data: { sucursal_id: p!.sucursal_id } }),
  });

  const vencido =
    p?.estado === "ABIERTO" &&
    p?.validez_hasta &&
    new Date(p.validez_hasta) < new Date(new Date().toDateString());

  const imprimir = async () => {
    if (!p) return;
    // El logo se pide ACÁ y no con el resto: son hasta 100 KB de data URL y no
    // tienen por qué viajar cada vez que se abre un presupuesto.
    const logo = await traerLogo(supabase, p.sucursal?.emisor?.id);
    const sucursal = { ...p.sucursal, emisor: { ...p.sucursal?.emisor, logo } };
    const doc = new jsPDF();
    // El encabezado sale del emisor de la SUCURSAL, no de `fiscal_config`: son
    // dos razones sociales distintas y la config global está vacía, por eso el
    // presupuesto salía pelado. Devuelve la Y donde termina para que lo de abajo
    // no se le monte encima con un logo o una razón social larga.
    const y = dibujarEncabezado(doc, sucursal, { y: 16 });

    doc.setFontSize(18);
    doc.text("PRESUPUESTO", 14, y + 8);
    doc.setFontSize(10);
    doc.text(`N° ${p.numero}`, 14, y + 15);
    doc.text(`Fecha: ${fmtDate(p.fecha)}`, 90, y + 15);
    if (p.validez_hasta) doc.text(`Válido hasta: ${fmtDate(p.validez_hasta)}`, 140, y + 15);

    doc.text(`Cliente: ${p.cliente?.razon_social ?? p.nombre_cliente ?? "—"}`, 14, y + 22);

    const tablaItems = tablaDeItemsPresupuesto(items);
    autoTable(doc, {
      startY: y + 28,
      head: tablaItems.head,
      body: tablaItems.body,
      styles: { fontSize: 8 },
    });

    const fin = (doc as any).lastAutoTable?.finalY ?? y + 40;
    doc.setFontSize(12);
    doc.text(`TOTAL: ${fmtMoney(p.total)}`, 14, fin + 10);

    // Este sistema emite comprobantes fiscales de verdad. Un papel con precios
    // que se pueda confundir con una factura es un problema con AFIP.
    doc.setFontSize(8);
    doc.text(
      "PRESUPUESTO — No válido como factura. Los precios pueden cambiar sin previo aviso.",
      14,
      fin + 20,
    );
    if (p.observaciones) doc.text(String(p.observaciones), 14, fin + 26);

    doc.save(`presupuesto-${p.numero}.pdf`);
  };

  const anularM = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("anular_presupuesto", { p_presupuesto_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Presupuesto anulado");
      qc.invalidateQueries({ queryKey: ["presupuesto", id] });
      qc.invalidateQueries({ queryKey: ["presupuestos"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const navegarACola = (
    ventaId: string,
    resultado:
      | "venta_creada_factura_pendiente"
      | "venta_creada_requiere_revision"
      | "factura_aprobada",
  ) => {
    navegacionFiscalRef.current = true;
    window.location.assign(
      `/facturacion/cola?venta=${encodeURIComponent(ventaId)}&resultado=${resultado}`,
    );
  };

  if (!cu || !p) return null;

  const destinoColaVentaConvertida = p.venta_id
    ? destinoColaFiscalVentaConvertida(p.venta_id, cu)
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Presupuesto ${p.numero}`}
        subtitle={p.cliente?.razon_social ?? p.nombre_cliente ?? "Sin cliente asignado"}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/presupuestos" })}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button variant="outline" size="sm" onClick={imprimir}>
              <Printer className="h-4 w-4 mr-1" /> Imprimir PDF
            </Button>
            {p.estado === "ABIERTO" && (
              <>
                {/* Sólo con el presupuesto ABIERTO: uno convertido ya es una
                    venta y uno anulado está muerto. La RPC lo rechaza igual. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate({ to: "/presupuestos/editar/$id", params: { id: p.id } })}
                  data-testid="editar-presupuesto"
                >
                  <Pencil className="h-4 w-4 mr-1" /> Editar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => anularM.mutate()}
                  disabled={anularM.isPending}
                >
                  Anular
                </Button>
                <Button
                  ref={botonConvertirRef}
                  onClick={() => setAbrirConv(true)}
                  data-testid="convertir"
                >
                  Convertir en venta
                </Button>
              </>
            )}
          </>
        }
      />

      {p.estado === "CONVERTIDO" && (
        <SectionCard>
          <p className="text-sm">
            Este presupuesto ya se convirtió una vez. La venta vinculada es{" "}
            {p.venta_id && destinoColaVentaConvertida ? (
              <a href={destinoColaVentaConvertida} className="font-semibold text-primary underline">
                {p.venta_id}
              </a>
            ) : p.venta_id ? (
              <strong>{p.venta_id}</strong>
            ) : (
              <strong>no identificable; requiere revisión administrativa</strong>
            )}
            . No vuelvas a convertirlo ni busques otra venta por las observaciones.
          </p>
        </SectionCard>
      )}

      {vencido && (
        <SectionCard>
          <div className="flex gap-2 items-start text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
            <p>
              Este presupuesto venció el <strong>{fmtDate(p.validez_hasta)}</strong>. Se puede
              convertir igual —respetar un precio viejo es decisión del negocio— pero conviene
              revisar los precios antes.
            </p>
          </div>
        </SectionCard>
      )}

      <div className="rounded-2xl border border-border overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Cant.</TableHead>
                <TableHead className="text-right">Precio de lista</TableHead>
                <TableHead className="text-right">Desc.</TableHead>
                <TableHead className="text-right">Precio</TableHead>
                {/* Los precios van CON IVA: es el número que se le dice al
                    cliente. Mostrar el neto y el IVA por separado confundía, y
                    hay clientes a los que no se les quiere mostrar el desglose.
                    Lo guardado sigue siendo neto, que es lo que factura. */}
                <TableHead className="text-right">Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i: any) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.codigo}</TableCell>
                  <TableCell>{i.descripcion}</TableCell>
                  <TableCell className="text-right">{Number(i.cantidad)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmtMoney(conIva(i.precio_lista_sin_iva, i.iva_porcentaje))}
                  </TableCell>
                  <TableCell className="text-right">
                    {Number(i.descuento_porcentaje) > 0
                      ? `${Number(i.descuento_porcentaje)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtMoney(conIva(i.precio_sin_iva, i.iva_porcentaje))}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {fmtMoney(i.subtotal_con_iva)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <SectionCard>
        <div className="flex justify-between items-center">
          <div className="text-sm text-muted-foreground">
            {p.estado === "ABIERTO" && (
              <>
                <StatusPill tone="success">abierto</StatusPill>{" "}
                <span className="ml-2">
                  Los productos <strong>no salieron del stock</strong> y el monto{" "}
                  <strong>no está cobrado</strong>.
                </span>
              </>
            )}
          </div>
          <div className="text-right">
            <p className="text-xl font-bold font-mono">{fmtMoney(p.total)}</p>
            <p className="text-[11px] text-muted-foreground">IVA incluido</p>
          </div>
        </div>
      </SectionCard>

      <DialogoConvertirPresupuesto
        open={abrirConv}
        presupuesto={p}
        facturacionV2Habilitada={cu.facturacionV2Habilitada}
        facturacionLegacyHabilitada={cu.facturacionLegacyHabilitada}
        puedeFacturar={cu.puedeFacturar}
        returnFocusRef={botonConvertirRef}
        onOpenChange={setAbrirConv}
        onConvertida={(resultado: PresupuestoConvertido) => {
          toast.success("Venta creada una sola vez con los precios del presupuesto.");
          void qc.invalidateQueries({ queryKey: ["presupuesto", id] });
          void qc.invalidateQueries({ queryKey: ["presupuestos"] });
          setAbrirConv(false);
          const accion = accionFiscalDespuesDeConvertirPresupuesto(resultado, cu);
          if (accion === "FACTURAR_AHORA") {
            setVentaParaFacturar({ id: resultado.ventaId, clienteId: resultado.clienteId });
          } else if (accion === "ABRIR_COLA") {
            navegarACola(resultado.ventaId, "venta_creada_factura_pendiente");
          }
        }}
      />

      {ventaParaFacturar ? (
        <DialogoEmisionFiscal
          open
          contexto={{
            comprador: {
              razonSocial: clienteFiscal?.razon_social ?? "Cliente de la venta convertida",
              documento: clienteFiscal?.cuit_dni ?? null,
              condicionIva: CONDICION_IVA_CLIENTE[clienteFiscal?.tipo ?? ""] ?? null,
            },
            emisor: {
              razonSocial: p.sucursal?.emisor?.razon_social ?? "Emisor de la sucursal",
              cuit: p.sucursal?.emisor?.cuit ?? "a confirmar",
            },
            sucursal: {
              id: p.sucursal_id,
              nombre: p.sucursal?.nombre ?? "Sucursal del presupuesto",
              puntoVenta: null,
              modo: null,
            },
            tipoComprobante: "VENTA",
          }}
          favoritos={favoritosFiscales}
          puedeConfirmarVentaAntigua={cu.isAdmin}
          returnFocusRef={botonConvertirRef}
          onOpenChange={(open) => {
            if (open) return;
            setVentaParaFacturar(null);
            if (!navegacionFiscalRef.current) {
              navegarACola(ventaParaFacturar.id, "venta_creada_factura_pendiente");
            }
          }}
          onPrevisualizar={({ receptor, letraSolicitada }) =>
            previsualizarFiscal({
              data: {
                origen: "VENTA_EXISTENTE",
                venta_id: ventaParaFacturar.id,
                receptor,
                letra_solicitada: letraSolicitada,
              },
            }).then((respuesta) => {
              if (esMantenimiento(respuesta)) throw new Error(respuesta.mensaje);
              return respuesta;
            })
          }
          onConfirmar={async ({
            receptor,
            letraSolicitada,
            confirmaVentaAntigua,
            huellaConfirmacion,
          }) => {
            try {
              const respuesta = await emitirFiscal({
                data: {
                  venta_id: ventaParaFacturar.id,
                  receptor,
                  letra_solicitada: letraSolicitada,
                  confirma_venta_antigua: confirmaVentaAntigua,
                  huella_confirmacion: huellaConfirmacion,
                },
              });
              if (esMantenimiento(respuesta)) {
                return parseRespuestaConfirmacionFiscal({
                  estado: "ERROR_CORREGIBLE" as const,
                  codigo: "MANTENIMIENTO_POST_VENTA" as const,
                  mensaje: mensajeCodigoErrorFiscalUsuario("MANTENIMIENTO_POST_VENTA"),
                });
              }
              return parseRespuestaConfirmacionFiscal(respuesta);
            } catch {
              return parseRespuestaConfirmacionFiscal({
                estado: "RECONCILIAR" as const,
                mensaje:
                  "El presupuesto quedó convertido, pero no se pudo confirmar la respuesta fiscal. No repitas la conversión ni el cobro.",
              });
            }
          }}
          onCompletada={(resultado) => {
            const resultadoCola = resultadoColaDespuesDeEmision(resultado.estado);
            if (resultado.estado === "APROBADO") {
              toast.success(`Factura aprobada. CAE ${resultado.cae}.`);
            } else {
              toast.warning(
                "El presupuesto quedó convertido en la misma venta. No repitas la conversión ni el cobro.",
                { duration: 12_000 },
              );
            }
            navegarACola(ventaParaFacturar.id, resultadoCola);
          }}
        />
      ) : null}
    </div>
  );
}
