import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { fmtMoney, formaPagoLabel } from "@/lib/format";
import { Trash2, Plus, ArrowLeft, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearVenta } from "@/lib/ventas.functions";

export const Route = createFileRoute("/_authenticated/ventas/nueva")({
  component: NuevaVenta,
});

interface ItemRow {
  producto_id: string;
  codigo: string;
  descripcion: string;
  cantidad: number;
  precio_unitario_sin_iva: number;
  iva_porcentaje: number;
  descuento_porcentaje: number;
  stock_disponible?: number;
}
interface PagoRow {
  id: string;
  forma_pago: string;
  monto: number;
  detalle: Record<string, any>;
}

function NuevaVenta() {
  const { data: cu } = useCurrentUser();
  const navigate = useNavigate();
  const crear = useServerFn(crearVenta);

  // Sucursal — empleado fija, admin elige
  const [sucursalId, setSucursalId] = useState<string>("");
  const [clienteId, setClienteId] = useState<string>("");
  const [clienteQuery, setClienteQuery] = useState("");
  const [tipoComp, setTipoComp] = useState<"FACTURA_A"|"FACTURA_B"|"REMITO">("FACTURA_B");
  const [condVenta, setCondVenta] = useState<"CONTADO"|"CTA_CTE">("CONTADO");
  const [percepciones, setPercepciones] = useState(0);
  const [observaciones, setObservaciones] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [prodQuery, setProdQuery] = useState("");
  const [showCli, setShowCli] = useState(false);
  const [showProd, setShowProd] = useState(false);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  // Si empleado: bloquear sucursal
  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-search", clienteQuery],
    queryFn: async () => {
      let q = supabase.from("clientes").select("id,razon_social,cuit_dni,tipo").eq("activo", true).limit(15);
      if (clienteQuery) q = q.or(`razon_social.ilike.%${clienteQuery}%,cuit_dni.ilike.%${clienteQuery}%`);
      return (((await q).data) ?? []) as any[];
    },
  });
  const clienteSel = useMemo(() => clientes.find((c:any)=>c.id === clienteId), [clientes, clienteId]);

  const { data: productosBusqueda = [] } = useQuery({
    queryKey: ["prods-search", prodQuery, effSucursal],
    enabled: !!prodQuery && prodQuery.length >= 2,
    queryFn: async () => {
      const { data } = await supabase.from("productos")
        .select("id,codigo,nombre,precio_sin_iva,iva_porcentaje,stock_sucursal!inner(cantidad,sucursal_id)")
        .or(`codigo.ilike.%${prodQuery}%,nombre.ilike.%${prodQuery}%`).eq("activo", true).limit(10);
      return (data ?? []) as any[];
    },
  });

  const addProducto = (p: any) => {
    const stock = (p.stock_sucursal as any[])?.find((s) => s.sucursal_id === effSucursal)?.cantidad ?? 0;
    setItems(prev => [...prev, {
      producto_id: p.id, codigo: p.codigo, descripcion: p.nombre,
      cantidad: 1, precio_unitario_sin_iva: Number(p.precio_sin_iva),
      iva_porcentaje: Number(p.iva_porcentaje), descuento_porcentaje: 0,
      stock_disponible: Number(stock),
    }]);
    setProdQuery(""); setShowProd(false);
  };

  const updateItem = (i: number, k: keyof ItemRow, v: any) => {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, [k]: v } : it));
  };
  const removeItem = (i: number) => setItems(prev => prev.filter((_,idx)=>idx!==i));

  const totales = useMemo(() => {
    let sub = 0, iva = 0;
    items.forEach(it => {
      const base = it.precio_unitario_sin_iva * (1 - (it.descuento_porcentaje ?? 0)/100) * it.cantidad;
      sub += base; iva += base * (it.iva_porcentaje/100);
    });
    const total = sub + iva + Number(percepciones || 0);
    const pagado = pagos.reduce((a,p)=>a+Number(p.monto || 0), 0);
    return { sub, iva, total, pagado, saldo: total - pagado };
  }, [items, percepciones, pagos]);

  const addPago = () => setPagos(p => [...p, { id: crypto.randomUUID(), forma_pago: "EFECTIVO", monto: 0, detalle: {} }]);
  const updPago = (id: string, k: string, v: any) => setPagos(p => p.map(x => x.id === id ? { ...x, [k]: v } : x));
  const updPagoDet = (id: string, k: string, v: any) => setPagos(p => p.map(x => x.id === id ? { ...x, detalle: { ...x.detalle, [k]: v } } : x));
  const rmPago = (id: string) => setPagos(p => p.filter(x => x.id !== id));

  const m = useMutation({
    mutationFn: async () => crear({ data: {
      sucursal_id: effSucursal, cliente_id: clienteId,
      tipo_comprobante: tipoComp, condicion_venta: condVenta,
      percepciones: Number(percepciones || 0), observaciones,
      items: items.map(({ stock_disponible: _, ...rest }) => ({
        ...rest, cantidad: Number(rest.cantidad), precio_unitario_sin_iva: Number(rest.precio_unitario_sin_iva),
        iva_porcentaje: Number(rest.iva_porcentaje), descuento_porcentaje: Number(rest.descuento_porcentaje),
      })),
      pagos: pagos.map(p => ({ forma_pago: p.forma_pago as any, monto: Number(p.monto), detalle: p.detalle })),
    }}),
    onSuccess: (r) => { toast.success(`Venta ${r.numero} registrada`); navigate({ to: "/ventas" }); },
    onError: (e:any) => toast.error(e.message),
  });

  const canSave = effSucursal && clienteId && items.length > 0 && items.every(i => i.cantidad > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={()=>navigate({ to: "/ventas" })}><ArrowLeft className="h-4 w-4"/></Button>
          <h1 className="text-2xl font-bold">Nueva venta</h1>
        </div>
        <Button onClick={()=>m.mutate()} disabled={!canSave || m.isPending}>
          {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1"/>} Guardar venta
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 space-y-3 lg:col-span-2">
          <h3 className="font-semibold">Datos generales</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Sucursal *</Label>
              {cu?.isAdmin ? (
                <Select value={sucursalId} onValueChange={setSucursalId}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar…"/></SelectTrigger>
                  <SelectContent>{sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
                </Select>
              ) : <Input value={cu?.sucursal?.nombre ?? ""} disabled/>}
            </div>
            <div>
              <Label>Tipo comprobante *</Label>
              <Select value={tipoComp} onValueChange={(v)=>setTipoComp(v as any)}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FACTURA_A">Factura A</SelectItem>
                  <SelectItem value="FACTURA_B">Factura B</SelectItem>
                  <SelectItem value="REMITO">Remito</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Condición *</Label>
              <Select value={condVenta} onValueChange={(v)=>setCondVenta(v as any)}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE">Cuenta Corriente</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Cliente *</Label>
              <Popover open={showCli} onOpenChange={setShowCli}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start truncate">
                    {clienteSel ? clienteSel.razon_social : "Buscar cliente…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-2">
                  <Input placeholder="Nombre o CUIT…" value={clienteQuery} onChange={(e)=>setClienteQuery(e.target.value)} autoFocus/>
                  <div className="max-h-64 overflow-auto mt-2">
                    {clientes.map((c:any) => (
                      <button key={c.id} className="w-full text-left p-2 hover:bg-accent rounded text-sm" onClick={()=>{ setClienteId(c.id); setShowCli(false); }}>
                        <div className="font-medium">{c.razon_social}</div>
                        <div className="text-xs text-muted-foreground">{c.cuit_dni ?? "—"}</div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <h3 className="font-semibold">Totales</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span>Subtotal:</span><span className="font-mono">{fmtMoney(totales.sub)}</span></div>
            <div className="flex justify-between"><span>IVA:</span><span className="font-mono">{fmtMoney(totales.iva)}</span></div>
            <div className="flex justify-between items-center gap-2">
              <Label className="text-sm m-0">Percepciones:</Label>
              <Input type="number" step="0.01" value={percepciones} onChange={(e)=>setPercepciones(Number(e.target.value))} className="h-7 w-28 text-right"/>
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
              <span>TOTAL:</span><span className="font-mono">{fmtMoney(totales.total)}</span>
            </div>
            <div className="flex justify-between text-success"><span>Pagado:</span><span className="font-mono">{fmtMoney(totales.pagado)}</span></div>
            <div className={`flex justify-between font-semibold ${totales.saldo > 0.001 ? "text-destructive" : totales.saldo < -0.001 ? "text-warning" : "text-muted-foreground"}`}>
              <span>{totales.saldo < 0 ? "Vuelto:" : "Saldo:"}</span>
              <span className="font-mono">{fmtMoney(Math.abs(totales.saldo))}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Productos</h3>
          <Popover open={showProd} onOpenChange={setShowProd}>
            <PopoverTrigger asChild><Button size="sm" disabled={!effSucursal}><Plus className="h-4 w-4 mr-1"/> Agregar</Button></PopoverTrigger>
            <PopoverContent className="w-[450px] p-2">
              <Input placeholder="Código o nombre…" value={prodQuery} onChange={(e)=>setProdQuery(e.target.value)} autoFocus/>
              <div className="max-h-72 overflow-auto mt-2">
                {productosBusqueda.map((p:any) => {
                  const stock = (p.stock_sucursal as any[])?.find(s=>s.sucursal_id===effSucursal)?.cantidad ?? 0;
                  return (
                    <button key={p.id} className="w-full text-left p-2 hover:bg-accent rounded text-sm" onClick={()=>addProducto(p)}>
                      <div className="flex justify-between"><span className="font-medium">{p.codigo} — {p.nombre}</span><span className="text-xs">Stock: {stock}</span></div>
                      <div className="text-xs text-muted-foreground">{fmtMoney(p.precio_sin_iva)} s/IVA · IVA {p.iva_porcentaje}%</div>
                    </button>
                  );
                })}
                {prodQuery.length < 2 && <p className="text-xs text-muted-foreground p-2">Escribí al menos 2 caracteres…</p>}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {items.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">Agregá productos a la venta.</p> :
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Código</TableHead><TableHead>Descripción</TableHead>
                <TableHead>Cant.</TableHead><TableHead>P. unit s/IVA</TableHead>
                <TableHead>Desc. %</TableHead><TableHead>IVA</TableHead>
                <TableHead className="text-right">Subtotal</TableHead><TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {items.map((it, i) => {
                  const sub = it.precio_unitario_sin_iva * (1 - it.descuento_porcentaje/100) * it.cantidad * (1 + it.iva_porcentaje/100);
                  const stockWarn = it.stock_disponible !== undefined && it.cantidad > it.stock_disponible;
                  return (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{it.codigo}</TableCell>
                      <TableCell className="max-w-xs">
                        <div className="text-sm">{it.descripcion}</div>
                        {stockWarn && <Badge variant="outline" className="mt-1 text-[10px] border-warning text-warning"><AlertTriangle className="h-2.5 w-2.5 mr-1"/>Excede stock ({it.stock_disponible})</Badge>}
                      </TableCell>
                      <TableCell><Input type="number" step="0.01" className="h-8 w-20" value={it.cantidad} onChange={(e)=>updateItem(i,"cantidad",Number(e.target.value))}/></TableCell>
                      <TableCell><Input type="number" step="0.01" className="h-8 w-28" value={it.precio_unitario_sin_iva} onChange={(e)=>updateItem(i,"precio_unitario_sin_iva",Number(e.target.value))}/></TableCell>
                      <TableCell><Input type="number" step="0.01" className="h-8 w-20" value={it.descuento_porcentaje} onChange={(e)=>updateItem(i,"descuento_porcentaje",Number(e.target.value))}/></TableCell>
                      <TableCell className="text-xs">{it.iva_porcentaje}%</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(sub)}</TableCell>
                      <TableCell><Button size="sm" variant="ghost" onClick={()=>removeItem(i)}><Trash2 className="h-3.5 w-3.5 text-destructive"/></Button></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        }
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Formas de pago</h3>
          <Button size="sm" variant="outline" onClick={addPago}><Plus className="h-4 w-4 mr-1"/> Agregar pago</Button>
        </div>
        {pagos.length === 0 ? <p className="text-sm text-muted-foreground py-4 text-center">Sin pagos. Si no agregás ninguno, la venta queda pendiente.</p> :
          <div className="space-y-2">
            {pagos.map(p => (
              <div key={p.id} className="grid grid-cols-12 gap-2 items-end p-2 border border-border rounded">
                <div className="col-span-3">
                  <Label className="text-xs">Forma</Label>
                  <Select value={p.forma_pago} onValueChange={(v)=>updPago(p.id,"forma_pago",v)}>
                    <SelectTrigger className="h-9"><SelectValue/></SelectTrigger>
                    <SelectContent>
                      {Object.entries(formaPagoLabel).map(([k,l]) => (<SelectItem key={k} value={k}>{l}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2"><Label className="text-xs">Monto</Label>
                  <Input type="number" step="0.01" className="h-9" value={p.monto} onChange={(e)=>updPago(p.id,"monto",Number(e.target.value))}/>
                </div>
                <div className="col-span-6 grid grid-cols-2 gap-2">
                  {(p.forma_pago === "TRANSFERENCIA" || p.forma_pago === "CHEQUE") && (
                    <div><Label className="text-xs">Banco</Label><Input className="h-9" value={p.detalle.banco ?? ""} onChange={(e)=>updPagoDet(p.id,"banco",e.target.value)}/></div>
                  )}
                  {(p.forma_pago === "TARJETA_DEBITO" || p.forma_pago === "TARJETA_CREDITO") && (
                    <div><Label className="text-xs">Tarjeta</Label><Input className="h-9" placeholder="Visa, Naranja…" value={p.detalle.tarjeta ?? ""} onChange={(e)=>updPagoDet(p.id,"tarjeta",e.target.value)}/></div>
                  )}
                  {p.forma_pago === "CHEQUE" && (<>
                    <div><Label className="text-xs">Nro cheque</Label><Input className="h-9" value={p.detalle.numero ?? ""} onChange={(e)=>updPagoDet(p.id,"numero",e.target.value)}/></div>
                    <div className="col-span-2"><Label className="text-xs">Fecha cobro</Label><Input type="date" className="h-9" value={p.detalle.fecha_cobro ?? ""} onChange={(e)=>updPagoDet(p.id,"fecha_cobro",e.target.value)}/></div>
                  </>)}
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button size="sm" variant="ghost" onClick={()=>rmPago(p.id)}><Trash2 className="h-3.5 w-3.5 text-destructive"/></Button>
                </div>
              </div>
            ))}
          </div>
        }
      </Card>

      <Card className="p-4">
        <Label>Observaciones</Label>
        <Textarea value={observaciones} onChange={(e)=>setObservaciones(e.target.value)} rows={2}/>
      </Card>
    </div>
  );
}
