export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      afip_ta: {
        Row: {
          cuit: string
          expires_at: string
          production: boolean
          service_name: string
          ticket_enc: string
          updated_at: string
        }
        Insert: {
          cuit: string
          expires_at: string
          production: boolean
          service_name: string
          ticket_enc: string
          updated_at?: string
        }
        Update: {
          cuit?: string
          expires_at?: string
          production?: boolean
          service_name?: string
          ticket_enc?: string
          updated_at?: string
        }
        Relationships: []
      }
      caja_cierre_correcciones: {
        Row: {
          caja_sesion_id: string
          campos_modificados: string[]
          corregida_en: string
          corregida_por: string
          id: number
          motivo: string
          valores_anteriores: Json
          valores_nuevos: Json
          version_anterior: number
          version_nueva: number
        }
        Insert: {
          caja_sesion_id: string
          campos_modificados: string[]
          corregida_en?: string
          corregida_por: string
          id?: never
          motivo: string
          valores_anteriores: Json
          valores_nuevos: Json
          version_anterior: number
          version_nueva: number
        }
        Update: {
          caja_sesion_id?: string
          campos_modificados?: string[]
          corregida_en?: string
          corregida_por?: string
          id?: never
          motivo?: string
          valores_anteriores?: Json
          valores_nuevos?: Json
          version_anterior?: number
          version_nueva?: number
        }
        Relationships: [
          {
            foreignKeyName: "caja_cierre_correcciones_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "caja_cierre_correcciones_corregida_por_fkey"
            columns: ["corregida_por"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      caja_movimientos: {
        Row: {
          caja_sesion_id: string
          created_at: string
          descripcion: string
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id: string
          monto: number
          tipo: Database["public"]["Enums"]["caja_mov_tipo"]
          usuario_id: string | null
        }
        Insert: {
          caja_sesion_id: string
          created_at?: string
          descripcion: string
          forma_pago?: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto: number
          tipo: Database["public"]["Enums"]["caja_mov_tipo"]
          usuario_id?: string | null
        }
        Update: {
          caja_sesion_id?: string
          created_at?: string
          descripcion?: string
          forma_pago?: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto?: number
          tipo?: Database["public"]["Enums"]["caja_mov_tipo"]
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "caja_movimientos_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
        ]
      }
      caja_sesiones: {
        Row: {
          abierta_en: string
          abierta_por: string
          cerrada_en: string | null
          cerrada_por: string | null
          contado: Json | null
          correccion_version: number
          created_at: string
          diferencia: Json | null
          efectivo_dejado: number | null
          esperado: Json | null
          estado: Database["public"]["Enums"]["caja_sesion_estado"]
          fondo_inicial: number
          id: string
          notas: string | null
          sucursal_id: string
          total_contado: number | null
          total_diferencia: number | null
          total_esperado: number | null
          updated_at: string
        }
        Insert: {
          abierta_en?: string
          abierta_por: string
          cerrada_en?: string | null
          cerrada_por?: string | null
          contado?: Json | null
          correccion_version?: number
          created_at?: string
          diferencia?: Json | null
          efectivo_dejado?: number | null
          esperado?: Json | null
          estado?: Database["public"]["Enums"]["caja_sesion_estado"]
          fondo_inicial?: number
          id?: string
          notas?: string | null
          sucursal_id: string
          total_contado?: number | null
          total_diferencia?: number | null
          total_esperado?: number | null
          updated_at?: string
        }
        Update: {
          abierta_en?: string
          abierta_por?: string
          cerrada_en?: string | null
          cerrada_por?: string | null
          contado?: Json | null
          correccion_version?: number
          created_at?: string
          diferencia?: Json | null
          efectivo_dejado?: number | null
          esperado?: Json | null
          estado?: Database["public"]["Enums"]["caja_sesion_estado"]
          fondo_inicial?: number
          id?: string
          notas?: string | null
          sucursal_id?: string
          total_contado?: number | null
          total_diferencia?: number | null
          total_esperado?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "caja_sesiones_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "caja_sesiones_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      categorias: {
        Row: {
          created_at: string
          id: string
          nombre: string
        }
        Insert: {
          created_at?: string
          id?: string
          nombre: string
        }
        Update: {
          created_at?: string
          id?: string
          nombre?: string
        }
        Relationships: []
      }
      clientes: {
        Row: {
          activo: boolean
          condicion_cta_cte: boolean
          created_at: string
          cuit_dni: string | null
          direccion: string | null
          email: string | null
          es_generico: boolean
          es_obra: boolean
          id: string
          limite_credito: number | null
          razon_social: string
          sucursal_habitual_id: string | null
          telefono: string | null
          tipo: Database["public"]["Enums"]["tipo_cliente"]
          updated_at: string
        }
        Insert: {
          activo?: boolean
          condicion_cta_cte?: boolean
          created_at?: string
          cuit_dni?: string | null
          direccion?: string | null
          email?: string | null
          es_generico?: boolean
          es_obra?: boolean
          id?: string
          limite_credito?: number | null
          razon_social: string
          sucursal_habitual_id?: string | null
          telefono?: string | null
          tipo?: Database["public"]["Enums"]["tipo_cliente"]
          updated_at?: string
        }
        Update: {
          activo?: boolean
          condicion_cta_cte?: boolean
          created_at?: string
          cuit_dni?: string | null
          direccion?: string | null
          email?: string | null
          es_generico?: boolean
          es_obra?: boolean
          id?: string
          limite_credito?: number | null
          razon_social?: string
          sucursal_habitual_id?: string | null
          telefono?: string | null
          tipo?: Database["public"]["Enums"]["tipo_cliente"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clientes_sucursal_habitual_id_fkey"
            columns: ["sucursal_habitual_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "clientes_sucursal_habitual_id_fkey"
            columns: ["sucursal_habitual_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      cobranzas_cta_cte: {
        Row: {
          caja_sesion_id: string | null
          cliente_id: string
          created_at: string
          detalle: Json
          fecha: string
          forma_pago: string
          id: string
          monto: number
          observaciones: string | null
          sucursal_id: string
          updated_at: string
          usuario_id: string
        }
        Insert: {
          caja_sesion_id?: string | null
          cliente_id: string
          created_at?: string
          detalle?: Json
          fecha?: string
          forma_pago: string
          id?: string
          monto: number
          observaciones?: string | null
          sucursal_id: string
          updated_at?: string
          usuario_id: string
        }
        Update: {
          caja_sesion_id?: string | null
          cliente_id?: string
          created_at?: string
          detalle?: Json
          fecha?: string
          forma_pago?: string
          id?: string
          monto?: number
          observaciones?: string | null
          sucursal_id?: string
          updated_at?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cobranzas_cta_cte_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobranzas_cta_cte_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cobranzas_cta_cte_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "cobranzas_cta_cte_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "cobranzas_cta_cte_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      compra_items: {
        Row: {
          cantidad: number
          codigo: string
          compra_id: string
          costo_unitario_sin_iva: number
          descripcion: string
          id: string
          iva_monto: number
          iva_porcentaje: number
          producto_id: string
          subtotal_con_iva: number
          subtotal_sin_iva: number
        }
        Insert: {
          cantidad: number
          codigo: string
          compra_id: string
          costo_unitario_sin_iva: number
          descripcion: string
          id?: string
          iva_monto: number
          iva_porcentaje: number
          producto_id: string
          subtotal_con_iva: number
          subtotal_sin_iva: number
        }
        Update: {
          cantidad?: number
          codigo?: string
          compra_id?: string
          costo_unitario_sin_iva?: number
          descripcion?: string
          id?: string
          iva_monto?: number
          iva_porcentaje?: number
          producto_id?: string
          subtotal_con_iva?: number
          subtotal_sin_iva?: number
        }
        Relationships: [
          {
            foreignKeyName: "compra_items_compra_id_fkey"
            columns: ["compra_id"]
            isOneToOne: false
            referencedRelation: "compras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compra_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compra_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
        ]
      }
      compras: {
        Row: {
          caja_sesion_id: string | null
          condicion: string
          created_at: string
          estado: string
          fecha_carga: string
          fecha_comprobante: string
          fecha_vencimiento: string | null
          id: string
          iva_total: number
          numero_comprobante: string
          observaciones: string | null
          percepciones: number
          proveedor_id: string
          subtotal_sin_iva: number
          sucursal_id: string
          tipo_comprobante: string
          total: number
          usuario_id: string
        }
        Insert: {
          caja_sesion_id?: string | null
          condicion: string
          created_at?: string
          estado?: string
          fecha_carga?: string
          fecha_comprobante: string
          fecha_vencimiento?: string | null
          id?: string
          iva_total?: number
          numero_comprobante: string
          observaciones?: string | null
          percepciones?: number
          proveedor_id: string
          subtotal_sin_iva?: number
          sucursal_id: string
          tipo_comprobante?: string
          total?: number
          usuario_id: string
        }
        Update: {
          caja_sesion_id?: string | null
          condicion?: string
          created_at?: string
          estado?: string
          fecha_carga?: string
          fecha_comprobante?: string
          fecha_vencimiento?: string | null
          id?: string
          iva_total?: number
          numero_comprobante?: string
          observaciones?: string | null
          percepciones?: number
          proveedor_id?: string
          subtotal_sin_iva?: number
          sucursal_id?: string
          tipo_comprobante?: string
          total?: number
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compras_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compras_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "compras_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compras_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "compras_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      comprobante_secuencias: {
        Row: {
          id: string
          sucursal_id: string
          tipo: Database["public"]["Enums"]["tipo_comprobante"]
          ultimo_numero: number
        }
        Insert: {
          id?: string
          sucursal_id: string
          tipo: Database["public"]["Enums"]["tipo_comprobante"]
          ultimo_numero?: number
        }
        Update: {
          id?: string
          sucursal_id?: string
          tipo?: Database["public"]["Enums"]["tipo_comprobante"]
          ultimo_numero?: number
        }
        Relationships: [
          {
            foreignKeyName: "comprobante_secuencias_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "comprobante_secuencias_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      credenciales_arca: {
        Row: {
          ambiente: string
          arca_cert_enc: string | null
          arca_key_enc: string | null
          cert_alias: string | null
          cert_vence_at: string | null
          created_at: string
          emisor_id: string
          habilitada: boolean
          id: string
          padron_probado_at: string | null
          padron_ultimo_error_at: string | null
          padron_ultimo_error_codigo: string | null
          padron_validacion_activa: boolean
          probada_at: string | null
          updated_at: string
        }
        Insert: {
          ambiente: string
          arca_cert_enc?: string | null
          arca_key_enc?: string | null
          cert_alias?: string | null
          cert_vence_at?: string | null
          created_at?: string
          emisor_id: string
          habilitada?: boolean
          id?: string
          padron_probado_at?: string | null
          padron_ultimo_error_at?: string | null
          padron_ultimo_error_codigo?: string | null
          padron_validacion_activa?: boolean
          probada_at?: string | null
          updated_at?: string
        }
        Update: {
          ambiente?: string
          arca_cert_enc?: string | null
          arca_key_enc?: string | null
          cert_alias?: string | null
          cert_vence_at?: string | null
          created_at?: string
          emisor_id?: string
          habilitada?: boolean
          id?: string
          padron_probado_at?: string | null
          padron_ultimo_error_at?: string | null
          padron_ultimo_error_codigo?: string | null
          padron_validacion_activa?: boolean
          probada_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credenciales_arca_emisor_id_fkey"
            columns: ["emisor_id"]
            isOneToOne: false
            referencedRelation: "emisores"
            referencedColumns: ["id"]
          },
        ]
      }
      cuenta_corriente_movimientos: {
        Row: {
          cliente_id: string
          cobranza_id: string | null
          created_at: string
          descripcion: string | null
          estado: Database["public"]["Enums"]["cc_mov_estado"]
          forma_pago: string | null
          id: string
          monto: number
          sucursal_id: string
          tipo: Database["public"]["Enums"]["cc_mov_tipo"]
          usuario_id: string | null
          venta_id: string | null
        }
        Insert: {
          cliente_id: string
          cobranza_id?: string | null
          created_at?: string
          descripcion?: string | null
          estado?: Database["public"]["Enums"]["cc_mov_estado"]
          forma_pago?: string | null
          id?: string
          monto: number
          sucursal_id: string
          tipo: Database["public"]["Enums"]["cc_mov_tipo"]
          usuario_id?: string | null
          venta_id?: string | null
        }
        Update: {
          cliente_id?: string
          cobranza_id?: string | null
          created_at?: string
          descripcion?: string | null
          estado?: Database["public"]["Enums"]["cc_mov_estado"]
          forma_pago?: string | null
          id?: string
          monto?: number
          sucursal_id?: string
          tipo?: Database["public"]["Enums"]["cc_mov_tipo"]
          usuario_id?: string | null
          venta_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cuenta_corriente_movimientos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_cobranza_id_fkey"
            columns: ["cobranza_id"]
            isOneToOne: true
            referencedRelation: "cobranzas_cta_cte"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: true
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuenta_corriente_movimientos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: true
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      documento_secuencias: {
        Row: {
          sucursal_id: string
          tipo: string
          ultimo_numero: number
        }
        Insert: {
          sucursal_id: string
          tipo: string
          ultimo_numero?: number
        }
        Update: {
          sucursal_id?: string
          tipo?: string
          ultimo_numero?: number
        }
        Relationships: [
          {
            foreignKeyName: "documento_secuencias_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "documento_secuencias_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      emision_fiscal_intentos: {
        Row: {
          claim_token: string
          created_at: string
          error_clase: string | null
          error_codigo: string | null
          fase: string
          id: string
          numero_reservado: number | null
          payload_hash: string
          respuesta_resumen: Json
          resultado: string | null
          snapshot_version: number
          updated_at: string
          venta_id: string
        }
        Insert: {
          claim_token: string
          created_at?: string
          error_clase?: string | null
          error_codigo?: string | null
          fase: string
          id?: string
          numero_reservado?: number | null
          payload_hash: string
          respuesta_resumen?: Json
          resultado?: string | null
          snapshot_version: number
          updated_at?: string
          venta_id: string
        }
        Update: {
          claim_token?: string
          created_at?: string
          error_clase?: string | null
          error_codigo?: string | null
          fase?: string
          id?: string
          numero_reservado?: number | null
          payload_hash?: string
          respuesta_resumen?: Json
          resultado?: string | null
          snapshot_version?: number
          updated_at?: string
          venta_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emision_fiscal_intentos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emision_fiscal_intentos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      emisores: {
        Row: {
          activo: boolean
          condicion_iva: string | null
          created_at: string
          cuit: string | null
          domicilio_fiscal: string | null
          factura_a_confirmada_at: string | null
          factura_a_confirmada_por: string | null
          factura_a_evidencia: string | null
          factura_a_modalidad: string
          factura_a_revalidar_at: string | null
          id: string
          ingresos_brutos: string | null
          inicio_actividades: string | null
          logo: string | null
          nombre_fantasia: string | null
          razon_social: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          condicion_iva?: string | null
          created_at?: string
          cuit?: string | null
          domicilio_fiscal?: string | null
          factura_a_confirmada_at?: string | null
          factura_a_confirmada_por?: string | null
          factura_a_evidencia?: string | null
          factura_a_modalidad?: string
          factura_a_revalidar_at?: string | null
          id?: string
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          logo?: string | null
          nombre_fantasia?: string | null
          razon_social: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          condicion_iva?: string | null
          created_at?: string
          cuit?: string | null
          domicilio_fiscal?: string | null
          factura_a_confirmada_at?: string | null
          factura_a_confirmada_por?: string | null
          factura_a_evidencia?: string | null
          factura_a_modalidad?: string
          factura_a_revalidar_at?: string | null
          id?: string
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          logo?: string | null
          nombre_fantasia?: string | null
          razon_social?: string
          updated_at?: string
        }
        Relationships: []
      }
      fiscal_config: {
        Row: {
          arca_cert_enc: string | null
          arca_key_enc: string | null
          cert_alias: string | null
          cert_vence_at: string | null
          condicion_iva: string
          cuit: string | null
          domicilio_fiscal: string | null
          habilitada: boolean
          id: boolean
          ingresos_brutos: string | null
          inicio_actividades: string | null
          nombre_fantasia: string | null
          razon_social: string | null
          updated_at: string
        }
        Insert: {
          arca_cert_enc?: string | null
          arca_key_enc?: string | null
          cert_alias?: string | null
          cert_vence_at?: string | null
          condicion_iva?: string
          cuit?: string | null
          domicilio_fiscal?: string | null
          habilitada?: boolean
          id?: boolean
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          updated_at?: string
        }
        Update: {
          arca_cert_enc?: string | null
          arca_key_enc?: string | null
          cert_alias?: string | null
          cert_vence_at?: string | null
          condicion_iva?: string
          cuit?: string | null
          domicilio_fiscal?: string | null
          habilitada?: boolean
          id?: boolean
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ingreso_mercaderia_correccion_items: {
        Row: {
          cantidad_anterior: number
          cantidad_nueva: number
          codigo: string | null
          correccion_id: string
          created_at: string
          descripcion: string
          diferencia: number
          id: string
          ingreso_item_id: string
          producto_id: string
          stock_movimiento_id: string
        }
        Insert: {
          cantidad_anterior: number
          cantidad_nueva: number
          codigo?: string | null
          correccion_id: string
          created_at?: string
          descripcion: string
          diferencia: number
          id?: string
          ingreso_item_id: string
          producto_id: string
          stock_movimiento_id: string
        }
        Update: {
          cantidad_anterior?: number
          cantidad_nueva?: number
          codigo?: string | null
          correccion_id?: string
          created_at?: string
          descripcion?: string
          diferencia?: number
          id?: string
          ingreso_item_id?: string
          producto_id?: string
          stock_movimiento_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_correccion_id_fkey"
            columns: ["correccion_id"]
            isOneToOne: false
            referencedRelation: "ingreso_mercaderia_correcciones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_ingreso_item_id_fkey"
            columns: ["ingreso_item_id"]
            isOneToOne: false
            referencedRelation: "ingreso_mercaderia_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_stock_movimiento_id_fkey"
            columns: ["stock_movimiento_id"]
            isOneToOne: false
            referencedRelation: "seguimiento_producto"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_correccion_items_stock_movimiento_id_fkey"
            columns: ["stock_movimiento_id"]
            isOneToOne: false
            referencedRelation: "stock_movimientos"
            referencedColumns: ["id"]
          },
        ]
      }
      ingreso_mercaderia_correcciones: {
        Row: {
          created_at: string
          id: string
          idempotency_key: string
          ingreso_id: string
          motivo: string
          request_payload: Json
          usuario_id: string
          usuario_nombre: string
        }
        Insert: {
          created_at?: string
          id?: string
          idempotency_key: string
          ingreso_id: string
          motivo: string
          request_payload: Json
          usuario_id: string
          usuario_nombre: string
        }
        Update: {
          created_at?: string
          id?: string
          idempotency_key?: string
          ingreso_id?: string
          motivo?: string
          request_payload?: Json
          usuario_id?: string
          usuario_nombre?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingreso_mercaderia_correcciones_ingreso_id_fkey"
            columns: ["ingreso_id"]
            isOneToOne: false
            referencedRelation: "ingresos_mercaderia"
            referencedColumns: ["id"]
          },
        ]
      }
      ingreso_mercaderia_items: {
        Row: {
          advertencia: string | null
          aprender: boolean
          cantidad: number | null
          cantidad_raw: string | null
          codigo: string | null
          codigo_proveedor: string | null
          confianza: string | null
          descripcion: string | null
          descripcion_proveedor: string | null
          descripcion_raw: string | null
          id: string
          ingreso_id: string
          linea: number
          origen_match: string
          pagina: number | null
          pisar_equivalencia: boolean
          producto_id: string | null
        }
        Insert: {
          advertencia?: string | null
          aprender?: boolean
          cantidad?: number | null
          cantidad_raw?: string | null
          codigo?: string | null
          codigo_proveedor?: string | null
          confianza?: string | null
          descripcion?: string | null
          descripcion_proveedor?: string | null
          descripcion_raw?: string | null
          id?: string
          ingreso_id: string
          linea: number
          origen_match?: string
          pagina?: number | null
          pisar_equivalencia?: boolean
          producto_id?: string | null
        }
        Update: {
          advertencia?: string | null
          aprender?: boolean
          cantidad?: number | null
          cantidad_raw?: string | null
          codigo?: string | null
          codigo_proveedor?: string | null
          confianza?: string | null
          descripcion?: string | null
          descripcion_proveedor?: string | null
          descripcion_raw?: string | null
          id?: string
          ingreso_id?: string
          linea?: number
          origen_match?: string
          pagina?: number | null
          pisar_equivalencia?: boolean
          producto_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingreso_mercaderia_items_ingreso_id_fkey"
            columns: ["ingreso_id"]
            isOneToOne: false
            referencedRelation: "ingresos_mercaderia"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingreso_mercaderia_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
        ]
      }
      ingresos_mercaderia: {
        Row: {
          archivo_path: string | null
          bloqueo_confirmacion: string | null
          created_at: string
          estado: string
          extraccion: Json | null
          extraccion_error: string | null
          extraccion_estado: string
          fecha_carga: string
          fecha_confirmacion: string | null
          fecha_remito: string | null
          id: string
          idempotency_key: string | null
          motivo_anulacion: string | null
          numero_normalizado: string | null
          numero_remito_proveedor: string | null
          observaciones: string | null
          proveedor_id: string
          sucursal_id: string
          updated_at: string
          uso_tokens: Json | null
          usuario_id: string
        }
        Insert: {
          archivo_path?: string | null
          bloqueo_confirmacion?: string | null
          created_at?: string
          estado?: string
          extraccion?: Json | null
          extraccion_error?: string | null
          extraccion_estado?: string
          fecha_carga?: string
          fecha_confirmacion?: string | null
          fecha_remito?: string | null
          id?: string
          idempotency_key?: string | null
          motivo_anulacion?: string | null
          numero_normalizado?: string | null
          numero_remito_proveedor?: string | null
          observaciones?: string | null
          proveedor_id: string
          sucursal_id: string
          updated_at?: string
          uso_tokens?: Json | null
          usuario_id: string
        }
        Update: {
          archivo_path?: string | null
          bloqueo_confirmacion?: string | null
          created_at?: string
          estado?: string
          extraccion?: Json | null
          extraccion_error?: string | null
          extraccion_estado?: string
          fecha_carga?: string
          fecha_confirmacion?: string | null
          fecha_remito?: string | null
          id?: string
          idempotency_key?: string | null
          motivo_anulacion?: string | null
          numero_normalizado?: string | null
          numero_remito_proveedor?: string | null
          observaciones?: string | null
          proveedor_id?: string
          sucursal_id?: string
          updated_at?: string
          uso_tokens?: Json | null
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingresos_mercaderia_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "ingresos_mercaderia_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingresos_mercaderia_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "ingresos_mercaderia_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      marcas: {
        Row: {
          created_at: string
          id: string
          nombre: string
        }
        Insert: {
          created_at?: string
          id?: string
          nombre: string
        }
        Update: {
          created_at?: string
          id?: string
          nombre?: string
        }
        Relationships: []
      }
      nota_credito_periodo_reintegros: {
        Row: {
          created_at: string
          detalle: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id: string
          monto: number
          orden: number
          venta_id: string
        }
        Insert: {
          created_at?: string
          detalle?: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto: number
          orden: number
          venta_id: string
        }
        Update: {
          created_at?: string
          detalle?: Json
          forma_pago?: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto?: number
          orden?: number
          venta_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nota_credito_periodo_reintegros_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nota_credito_periodo_reintegros_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      precio_operaciones: {
        Row: {
          created_at: string
          idempotency_key: string
          operacion: string
          porcentaje: number
          productos: number
          usuario_id: string
        }
        Insert: {
          created_at?: string
          idempotency_key: string
          operacion: string
          porcentaje: number
          productos: number
          usuario_id: string
        }
        Update: {
          created_at?: string
          idempotency_key?: string
          operacion?: string
          porcentaje?: number
          productos?: number
          usuario_id?: string
        }
        Relationships: []
      }
      presupuesto_items: {
        Row: {
          cantidad: number
          codigo: string
          descripcion: string
          descuento_porcentaje: number
          id: string
          iva_monto: number
          iva_porcentaje: number
          precio_lista_sin_iva: number
          precio_sin_iva: number
          presupuesto_id: string
          producto_id: string
          subtotal_con_iva: number
          subtotal_sin_iva: number
        }
        Insert: {
          cantidad: number
          codigo: string
          descripcion: string
          descuento_porcentaje?: number
          id?: string
          iva_monto: number
          iva_porcentaje: number
          precio_lista_sin_iva: number
          precio_sin_iva: number
          presupuesto_id: string
          producto_id: string
          subtotal_con_iva: number
          subtotal_sin_iva: number
        }
        Update: {
          cantidad?: number
          codigo?: string
          descripcion?: string
          descuento_porcentaje?: number
          id?: string
          iva_monto?: number
          iva_porcentaje?: number
          precio_lista_sin_iva?: number
          precio_sin_iva?: number
          presupuesto_id?: string
          producto_id?: string
          subtotal_con_iva?: number
          subtotal_sin_iva?: number
        }
        Relationships: [
          {
            foreignKeyName: "presupuesto_items_presupuesto_id_fkey"
            columns: ["presupuesto_id"]
            isOneToOne: false
            referencedRelation: "presupuestos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presupuesto_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presupuesto_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
        ]
      }
      presupuestos: {
        Row: {
          cliente_id: string | null
          created_at: string
          estado: string
          fecha: string
          id: string
          iva_total: number
          nombre_cliente: string | null
          numero: string
          observaciones: string | null
          subtotal_sin_iva: number
          sucursal_id: string
          total: number
          updated_at: string
          usuario_id: string
          validez_hasta: string | null
          venta_id: string | null
        }
        Insert: {
          cliente_id?: string | null
          created_at?: string
          estado?: string
          fecha?: string
          id?: string
          iva_total?: number
          nombre_cliente?: string | null
          numero: string
          observaciones?: string | null
          subtotal_sin_iva?: number
          sucursal_id: string
          total?: number
          updated_at?: string
          usuario_id: string
          validez_hasta?: string | null
          venta_id?: string | null
        }
        Update: {
          cliente_id?: string | null
          created_at?: string
          estado?: string
          fecha?: string
          id?: string
          iva_total?: number
          nombre_cliente?: string | null
          numero?: string
          observaciones?: string | null
          subtotal_sin_iva?: number
          sucursal_id?: string
          total?: number
          updated_at?: string
          usuario_id?: string
          validez_hasta?: string | null
          venta_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "presupuestos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presupuestos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "presupuestos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "presupuestos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presupuestos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "presupuestos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      producto_codigos_proveedor: {
        Row: {
          codigo_proveedor: string
          codigo_proveedor_norm: string | null
          created_at: string
          descripcion_proveedor: string | null
          id: string
          producto_id: string
          proveedor_id: string
          updated_at: string
          usuario_id: string | null
        }
        Insert: {
          codigo_proveedor: string
          codigo_proveedor_norm?: string | null
          created_at?: string
          descripcion_proveedor?: string | null
          id?: string
          producto_id: string
          proveedor_id: string
          updated_at?: string
          usuario_id?: string | null
        }
        Update: {
          codigo_proveedor?: string
          codigo_proveedor_norm?: string | null
          created_at?: string
          descripcion_proveedor?: string | null
          id?: string
          producto_id?: string
          proveedor_id?: string
          updated_at?: string
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "producto_codigos_proveedor_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "producto_codigos_proveedor_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "producto_codigos_proveedor_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "producto_codigos_proveedor_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
        ]
      }
      productos: {
        Row: {
          activo: boolean
          archivado: boolean
          categoria_id: string | null
          codigo: string
          codigo_barras: string | null
          created_at: string
          descripcion: string | null
          descuento_porcentaje: number | null
          id: string
          iva_porcentaje: number
          marca_id: string | null
          markup_porcentaje: number | null
          nombre: string
          precio_fabrica: number
          precio_lista: number
          precio_sin_iva: number
          precio_sugerido_publico: number | null
          proveedor_id: string | null
          stock_minimo: number
          tamano_envase: number | null
          unidad_medida: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          archivado?: boolean
          categoria_id?: string | null
          codigo: string
          codigo_barras?: string | null
          created_at?: string
          descripcion?: string | null
          descuento_porcentaje?: number | null
          id?: string
          iva_porcentaje?: number
          marca_id?: string | null
          markup_porcentaje?: number | null
          nombre: string
          precio_fabrica?: number
          precio_lista?: number
          precio_sin_iva?: number
          precio_sugerido_publico?: number | null
          proveedor_id?: string | null
          stock_minimo?: number
          tamano_envase?: number | null
          unidad_medida?: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          archivado?: boolean
          categoria_id?: string | null
          codigo?: string
          codigo_barras?: string | null
          created_at?: string
          descripcion?: string | null
          descuento_porcentaje?: number | null
          id?: string
          iva_porcentaje?: number
          marca_id?: string | null
          markup_porcentaje?: number | null
          nombre?: string
          precio_fabrica?: number
          precio_lista?: number
          precio_sin_iva?: number
          precio_sugerido_publico?: number | null
          proveedor_id?: string | null
          stock_minimo?: number
          tamano_envase?: number | null
          unidad_medida?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "productos_categoria_id_fkey"
            columns: ["categoria_id"]
            isOneToOne: false
            referencedRelation: "categorias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productos_marca_id_fkey"
            columns: ["marca_id"]
            isOneToOne: false
            referencedRelation: "marcas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "productos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_sucursales: {
        Row: {
          creado_en: string
          profile_id: string
          sucursal_id: string
        }
        Insert: {
          creado_en?: string
          profile_id: string
          sucursal_id: string
        }
        Update: {
          creado_en?: string
          profile_id?: string
          sucursal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_sucursales_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_sucursales_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "profile_sucursales_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          activo: boolean
          created_at: string
          id: string
          nombre_completo: string | null
          permite_venta_sin_stock: boolean
          puede_emitir_nc_periodo: boolean
          puede_facturar: boolean
          puede_gestionar_credito_clientes: boolean
          secciones: string[] | null
          sucursal_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          activo?: boolean
          created_at?: string
          id: string
          nombre_completo?: string | null
          permite_venta_sin_stock?: boolean
          puede_emitir_nc_periodo?: boolean
          puede_facturar?: boolean
          puede_gestionar_credito_clientes?: boolean
          secciones?: string[] | null
          sucursal_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          activo?: boolean
          created_at?: string
          id?: string
          nombre_completo?: string | null
          permite_venta_sin_stock?: boolean
          puede_emitir_nc_periodo?: boolean
          puede_facturar?: boolean
          puede_gestionar_credito_clientes?: boolean
          secciones?: string[] | null
          sucursal_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "profiles_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      proveedor_cc_movimientos: {
        Row: {
          compra_id: string | null
          created_at: string
          descripcion: string | null
          estado: string
          forma_pago: string | null
          id: string
          monto: number
          pago_id: string | null
          proveedor_id: string
          sucursal_id: string
          tipo: Database["public"]["Enums"]["proveedor_cc_tipo"]
          usuario_id: string | null
        }
        Insert: {
          compra_id?: string | null
          created_at?: string
          descripcion?: string | null
          estado?: string
          forma_pago?: string | null
          id?: string
          monto: number
          pago_id?: string | null
          proveedor_id: string
          sucursal_id: string
          tipo: Database["public"]["Enums"]["proveedor_cc_tipo"]
          usuario_id?: string | null
        }
        Update: {
          compra_id?: string | null
          created_at?: string
          descripcion?: string | null
          estado?: string
          forma_pago?: string | null
          id?: string
          monto?: number
          pago_id?: string | null
          proveedor_id?: string
          sucursal_id?: string
          tipo?: Database["public"]["Enums"]["proveedor_cc_tipo"]
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proveedor_cc_movimientos_compra_id_fkey"
            columns: ["compra_id"]
            isOneToOne: true
            referencedRelation: "compras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_cc_movimientos_pago_id_fkey"
            columns: ["pago_id"]
            isOneToOne: true
            referencedRelation: "proveedor_pagos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_cc_movimientos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "proveedor_cc_movimientos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_cc_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "proveedor_cc_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      proveedor_pagos: {
        Row: {
          caja_sesion_id: string | null
          compra_id: string | null
          created_at: string
          detalle: Json
          estado: string
          fecha: string
          forma_pago: string
          id: string
          monto: number
          numero: string | null
          proveedor_id: string
          saldo_posterior: number | null
          sucursal_id: string
          usuario_id: string
        }
        Insert: {
          caja_sesion_id?: string | null
          compra_id?: string | null
          created_at?: string
          detalle?: Json
          estado?: string
          fecha?: string
          forma_pago: string
          id?: string
          monto: number
          numero?: string | null
          proveedor_id: string
          saldo_posterior?: number | null
          sucursal_id: string
          usuario_id: string
        }
        Update: {
          caja_sesion_id?: string | null
          compra_id?: string | null
          created_at?: string
          detalle?: Json
          estado?: string
          fecha?: string
          forma_pago?: string
          id?: string
          monto?: number
          numero?: string | null
          proveedor_id?: string
          saldo_posterior?: number | null
          sucursal_id?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proveedor_pagos_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_pagos_compra_id_fkey"
            columns: ["compra_id"]
            isOneToOne: false
            referencedRelation: "compras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_pagos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedor_cc_saldos"
            referencedColumns: ["proveedor_id"]
          },
          {
            foreignKeyName: "proveedor_pagos_proveedor_id_fkey"
            columns: ["proveedor_id"]
            isOneToOne: false
            referencedRelation: "proveedores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proveedor_pagos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "proveedor_pagos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      proveedores: {
        Row: {
          activo: boolean
          codigos_coinciden_con_los_propios: boolean
          condicion_cta_cte: boolean
          condicion_iva: Database["public"]["Enums"]["tipo_cliente"]
          created_at: string
          cuit_dni: string | null
          descuento_porcentaje: number | null
          direccion: string | null
          email: string | null
          id: string
          razon_social: string
          telefono: string | null
          updated_at: string
        }
        Insert: {
          activo?: boolean
          codigos_coinciden_con_los_propios?: boolean
          condicion_cta_cte?: boolean
          condicion_iva?: Database["public"]["Enums"]["tipo_cliente"]
          created_at?: string
          cuit_dni?: string | null
          descuento_porcentaje?: number | null
          direccion?: string | null
          email?: string | null
          id?: string
          razon_social: string
          telefono?: string | null
          updated_at?: string
        }
        Update: {
          activo?: boolean
          codigos_coinciden_con_los_propios?: boolean
          condicion_cta_cte?: boolean
          condicion_iva?: Database["public"]["Enums"]["tipo_cliente"]
          created_at?: string
          cuit_dni?: string | null
          descuento_porcentaje?: number | null
          direccion?: string | null
          email?: string | null
          id?: string
          razon_social?: string
          telefono?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      puntos_venta: {
        Row: {
          activo: boolean
          created_at: string
          emisor_id: string
          id: string
          modo: string
          numero: number
          sucursal_id: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          created_at?: string
          emisor_id: string
          id?: string
          modo?: string
          numero: number
          sucursal_id: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          created_at?: string
          emisor_id?: string
          id?: string
          modo?: string
          numero?: number
          sucursal_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_puntos_venta_sucursal_emisor"
            columns: ["sucursal_id", "emisor_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id", "emisor_id"]
          },
          {
            foreignKeyName: "puntos_venta_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: true
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "puntos_venta_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: true
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      receptores_fiscales: {
        Row: {
          activo: boolean
          cliente_comercial_id: string | null
          condicion_iva: string
          creado_por: string
          created_at: string
          domicilio: string | null
          id: string
          numero_documento: string
          razon_social: string
          sucursal_id: string
          tipo_documento: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          cliente_comercial_id?: string | null
          condicion_iva: string
          creado_por: string
          created_at?: string
          domicilio?: string | null
          id?: string
          numero_documento: string
          razon_social: string
          sucursal_id: string
          tipo_documento: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          cliente_comercial_id?: string | null
          condicion_iva?: string
          creado_por?: string
          created_at?: string
          domicilio?: string | null
          id?: string
          numero_documento?: string
          razon_social?: string
          sucursal_id?: string
          tipo_documento?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "receptores_fiscales_cliente_comercial_id_fkey"
            columns: ["cliente_comercial_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receptores_fiscales_cliente_comercial_id_fkey"
            columns: ["cliente_comercial_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "receptores_fiscales_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "receptores_fiscales_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      remito_items: {
        Row: {
          cantidad: number
          created_at: string
          id: string
          producto_id: string
          remito_id: string
        }
        Insert: {
          cantidad: number
          created_at?: string
          id?: string
          producto_id: string
          remito_id: string
        }
        Update: {
          cantidad?: number
          created_at?: string
          id?: string
          producto_id?: string
          remito_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "remito_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remito_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "remito_items_remito_id_fkey"
            columns: ["remito_id"]
            isOneToOne: false
            referencedRelation: "remitos"
            referencedColumns: ["id"]
          },
        ]
      }
      remitos: {
        Row: {
          aprobado_por: string | null
          creado_por: string
          created_at: string
          estado: Database["public"]["Enums"]["estado_remito"]
          fecha_aprobacion: string | null
          id: string
          idempotency_key: string | null
          motivo_rechazo: string | null
          numero: string
          observaciones: string | null
          request_fingerprint: string | null
          sucursal_destino_id: string
          sucursal_origen_id: string
          updated_at: string
        }
        Insert: {
          aprobado_por?: string | null
          creado_por: string
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_remito"]
          fecha_aprobacion?: string | null
          id?: string
          idempotency_key?: string | null
          motivo_rechazo?: string | null
          numero: string
          observaciones?: string | null
          request_fingerprint?: string | null
          sucursal_destino_id: string
          sucursal_origen_id: string
          updated_at?: string
        }
        Update: {
          aprobado_por?: string | null
          creado_por?: string
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_remito"]
          fecha_aprobacion?: string | null
          id?: string
          idempotency_key?: string | null
          motivo_rechazo?: string | null
          numero?: string
          observaciones?: string | null
          request_fingerprint?: string | null
          sucursal_destino_id?: string
          sucursal_origen_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "remitos_sucursal_destino_id_fkey"
            columns: ["sucursal_destino_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "remitos_sucursal_destino_id_fkey"
            columns: ["sucursal_destino_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remitos_sucursal_origen_id_fkey"
            columns: ["sucursal_origen_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "remitos_sucursal_origen_id_fkey"
            columns: ["sucursal_origen_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      rendiciones_caja: {
        Row: {
          created_at: string
          diferencia: number
          efectivo_dejado: number
          efectivo_retirado: number
          fecha: string
          id: string
          observaciones: string | null
          saldo_inicial: number
          sucursal_id: string
          total_cheque: number
          total_credito: number
          total_cta_cte: number
          total_debito: number
          total_declarado: number
          total_efectivo: number
          total_mp: number
          total_sistema: number
          total_transferencia: number
          updated_at: string
          usuario_id: string
        }
        Insert: {
          created_at?: string
          diferencia?: number
          efectivo_dejado?: number
          efectivo_retirado?: number
          fecha: string
          id?: string
          observaciones?: string | null
          saldo_inicial?: number
          sucursal_id: string
          total_cheque?: number
          total_credito?: number
          total_cta_cte?: number
          total_debito?: number
          total_declarado?: number
          total_efectivo?: number
          total_mp?: number
          total_sistema?: number
          total_transferencia?: number
          updated_at?: string
          usuario_id: string
        }
        Update: {
          created_at?: string
          diferencia?: number
          efectivo_dejado?: number
          efectivo_retirado?: number
          fecha?: string
          id?: string
          observaciones?: string | null
          saldo_inicial?: number
          sucursal_id?: string
          total_cheque?: number
          total_credito?: number
          total_cta_cte?: number
          total_debito?: number
          total_declarado?: number
          total_efectivo?: number
          total_mp?: number
          total_sistema?: number
          total_transferencia?: number
          updated_at?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rendiciones_caja_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "rendiciones_caja_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          descuento_proveedor_porcentaje: number
          facturacion_legacy_writer_enabled: boolean
          facturacion_receptor_v2_enabled: boolean
          id: boolean
          markup_default_porcentaje: number
          nota_credito_periodo_enabled: boolean
          permitir_stock_negativo: boolean
          updated_at: string
        }
        Insert: {
          descuento_proveedor_porcentaje?: number
          facturacion_legacy_writer_enabled?: boolean
          facturacion_receptor_v2_enabled?: boolean
          id?: boolean
          markup_default_porcentaje?: number
          nota_credito_periodo_enabled?: boolean
          permitir_stock_negativo?: boolean
          updated_at?: string
        }
        Update: {
          descuento_proveedor_porcentaje?: number
          facturacion_legacy_writer_enabled?: boolean
          facturacion_receptor_v2_enabled?: boolean
          id?: boolean
          markup_default_porcentaje?: number
          nota_credito_periodo_enabled?: boolean
          permitir_stock_negativo?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      stock_conteo_items: {
        Row: {
          cantidad_anterior: number
          cantidad_contada: number
          cantidad_final: number
          conteo_id: string
          id: string
          movimientos_posteriores: number
          producto_codigo: string
          producto_id: string | null
          producto_nombre: string
        }
        Insert: {
          cantidad_anterior: number
          cantidad_contada: number
          cantidad_final: number
          conteo_id: string
          id?: string
          movimientos_posteriores?: number
          producto_codigo: string
          producto_id?: string | null
          producto_nombre: string
        }
        Update: {
          cantidad_anterior?: number
          cantidad_contada?: number
          cantidad_final?: number
          conteo_id?: string
          id?: string
          movimientos_posteriores?: number
          producto_codigo?: string
          producto_id?: string | null
          producto_nombre?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_conteo_items_conteo_id_fkey"
            columns: ["conteo_id"]
            isOneToOne: false
            referencedRelation: "stock_conteos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_conteo_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_conteo_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
        ]
      }
      stock_conteos: {
        Row: {
          contado_desde: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          items_ajustados: number
          items_con_movimientos: number
          items_conflicto: number
          items_sin_cambio: number
          motivo: string
          sucursal_id: string
          usuario_id: string | null
        }
        Insert: {
          contado_desde?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          items_ajustados?: number
          items_con_movimientos?: number
          items_conflicto?: number
          items_sin_cambio?: number
          motivo: string
          sucursal_id: string
          usuario_id?: string | null
        }
        Update: {
          contado_desde?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          items_ajustados?: number
          items_con_movimientos?: number
          items_conflicto?: number
          items_sin_cambio?: number
          motivo?: string
          sucursal_id?: string
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_conteos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "stock_conteos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_correccion_envase: {
        Row: {
          cantidad_anterior: number
          cantidad_nueva: number
          created_at: string
          id: string
          motivo: string
          movimientos_count: number
          producto_codigo: string
          producto_id: string | null
          producto_nombre: string
          revertido_at: string | null
          stock_updated_at: string | null
          sucursal_codigo: string | null
          sucursal_id: string | null
          tamano_envase: number | null
          ultimo_movimiento_at: string | null
        }
        Insert: {
          cantidad_anterior: number
          cantidad_nueva: number
          created_at?: string
          id?: string
          motivo: string
          movimientos_count?: number
          producto_codigo: string
          producto_id?: string | null
          producto_nombre: string
          revertido_at?: string | null
          stock_updated_at?: string | null
          sucursal_codigo?: string | null
          sucursal_id?: string | null
          tamano_envase?: number | null
          ultimo_movimiento_at?: string | null
        }
        Update: {
          cantidad_anterior?: number
          cantidad_nueva?: number
          created_at?: string
          id?: string
          motivo?: string
          movimientos_count?: number
          producto_codigo?: string
          producto_id?: string | null
          producto_nombre?: string
          revertido_at?: string | null
          stock_updated_at?: string | null
          sucursal_codigo?: string | null
          sucursal_id?: string | null
          tamano_envase?: number | null
          ultimo_movimiento_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_correccion_envase_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_correccion_envase_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "stock_correccion_envase_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "stock_correccion_envase_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movimientos: {
        Row: {
          cantidad: number
          cantidad_anterior: number | null
          cantidad_nueva: number | null
          created_at: string
          id: string
          motivo: string | null
          producto_id: string
          referencia_id: string | null
          sucursal_id: string
          tipo: Database["public"]["Enums"]["tipo_movimiento_stock"]
          usuario_id: string | null
        }
        Insert: {
          cantidad: number
          cantidad_anterior?: number | null
          cantidad_nueva?: number | null
          created_at?: string
          id?: string
          motivo?: string | null
          producto_id: string
          referencia_id?: string | null
          sucursal_id: string
          tipo: Database["public"]["Enums"]["tipo_movimiento_stock"]
          usuario_id?: string | null
        }
        Update: {
          cantidad?: number
          cantidad_anterior?: number | null
          cantidad_nueva?: number | null
          created_at?: string
          id?: string
          motivo?: string | null
          producto_id?: string
          referencia_id?: string | null
          sucursal_id?: string
          tipo?: Database["public"]["Enums"]["tipo_movimiento_stock"]
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movimientos_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movimientos_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "stock_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "stock_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_sucursal: {
        Row: {
          cantidad: number
          id: string
          producto_id: string
          sucursal_id: string
          updated_at: string
        }
        Insert: {
          cantidad?: number
          id?: string
          producto_id: string
          sucursal_id: string
          updated_at?: string
        }
        Update: {
          cantidad?: number
          id?: string
          producto_id?: string
          sucursal_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_sucursal_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_sucursal_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "stock_sucursal_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "stock_sucursal_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      sucursal_activa_log: {
        Row: {
          cambiado_en: string
          desde_sucursal_id: string | null
          hacia_sucursal_id: string
          id: string
          profile_id: string
        }
        Insert: {
          cambiado_en?: string
          desde_sucursal_id?: string | null
          hacia_sucursal_id: string
          id?: string
          profile_id: string
        }
        Update: {
          cambiado_en?: string
          desde_sucursal_id?: string | null
          hacia_sucursal_id?: string
          id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sucursal_activa_log_desde_sucursal_id_fkey"
            columns: ["desde_sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "sucursal_activa_log_desde_sucursal_id_fkey"
            columns: ["desde_sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sucursal_activa_log_hacia_sucursal_id_fkey"
            columns: ["hacia_sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "sucursal_activa_log_hacia_sucursal_id_fkey"
            columns: ["hacia_sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sucursal_activa_log_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sucursales: {
        Row: {
          activa: boolean
          codigo: Database["public"]["Enums"]["sucursal_codigo"]
          created_at: string
          direccion: string | null
          emisor_id: string
          id: string
          nombre: string
          numero: string
          telefono: string | null
          updated_at: string
        }
        Insert: {
          activa?: boolean
          codigo: Database["public"]["Enums"]["sucursal_codigo"]
          created_at?: string
          direccion?: string | null
          emisor_id: string
          id?: string
          nombre: string
          numero: string
          telefono?: string | null
          updated_at?: string
        }
        Update: {
          activa?: boolean
          codigo?: Database["public"]["Enums"]["sucursal_codigo"]
          created_at?: string
          direccion?: string | null
          emisor_id?: string
          id?: string
          nombre?: string
          numero?: string
          telefono?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sucursales_emisor_id_fkey"
            columns: ["emisor_id"]
            isOneToOne: false
            referencedRelation: "emisores"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      usuario_estado_acceso: {
        Row: {
          activo_deseado: boolean
          operacion_id: string | null
          pendiente: boolean
          profile_id: string
          updated_at: string
          version: number
        }
        Insert: {
          activo_deseado: boolean
          operacion_id?: string | null
          pendiente?: boolean
          profile_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          activo_deseado?: boolean
          operacion_id?: string | null
          pendiente?: boolean
          profile_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "usuario_estado_acceso_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      usuario_estado_acceso_operaciones: {
        Row: {
          activo_deseado: boolean
          created_at: string
          operacion_id: string
          profile_id: string
          tipo: string
          version: number
        }
        Insert: {
          activo_deseado: boolean
          created_at?: string
          operacion_id: string
          profile_id: string
          tipo: string
          version: number
        }
        Update: {
          activo_deseado?: boolean
          created_at?: string
          operacion_id?: string
          profile_id?: string
          tipo?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "usuario_estado_acceso_operaciones_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      venta_items: {
        Row: {
          cantidad: number
          codigo: string
          created_at: string
          descripcion: string
          descuento_porcentaje: number
          id: string
          iva_monto: number
          iva_porcentaje: number
          precio_lista_sin_iva: number | null
          precio_unitario_sin_iva: number
          producto_id: string | null
          subtotal_con_iva: number
          subtotal_sin_iva: number
          venta_id: string
        }
        Insert: {
          cantidad: number
          codigo: string
          created_at?: string
          descripcion: string
          descuento_porcentaje?: number
          id?: string
          iva_monto: number
          iva_porcentaje: number
          precio_lista_sin_iva?: number | null
          precio_unitario_sin_iva: number
          producto_id?: string | null
          subtotal_con_iva: number
          subtotal_sin_iva: number
          venta_id: string
        }
        Update: {
          cantidad?: number
          codigo?: string
          created_at?: string
          descripcion?: string
          descuento_porcentaje?: number
          id?: string
          iva_monto?: number
          iva_porcentaje?: number
          precio_lista_sin_iva?: number | null
          precio_unitario_sin_iva?: number
          producto_id?: string | null
          subtotal_con_iva?: number
          subtotal_sin_iva?: number
          venta_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venta_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venta_items_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "venta_items_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venta_items_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      venta_pagos: {
        Row: {
          caja_sesion_id: string | null
          cobro_idempotency_key: string | null
          created_at: string
          detalle: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id: string
          monto: number
          venta_id: string
        }
        Insert: {
          caja_sesion_id?: string | null
          cobro_idempotency_key?: string | null
          created_at?: string
          detalle?: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto: number
          venta_id: string
        }
        Update: {
          caja_sesion_id?: string | null
          cobro_idempotency_key?: string | null
          created_at?: string
          detalle?: Json
          forma_pago?: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto?: number
          venta_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venta_pagos_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venta_pagos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venta_pagos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
      ventas: {
        Row: {
          afip_cbte_asoc_id: string | null
          afip_cbte_tipo: number | null
          afip_claim_token: string | null
          afip_claimed_at: string | null
          afip_emisor_cuit: string | null
          afip_emitido_at: string | null
          afip_error: string | null
          afip_error_clase: string | null
          afip_error_codigo: string | null
          afip_error_fase: string | null
          afip_estado: string
          afip_fase: string | null
          afip_fecha_comprobante: string | null
          afip_imp_total: number | null
          afip_intentos: number
          afip_legacy_incompleto: boolean
          afip_modo: string | null
          afip_numero: number | null
          afip_punto_venta: number | null
          afip_simulado: boolean
          afip_snapshot: Json | null
          afip_snapshot_hash: string | null
          afip_ultimo_error_at: string | null
          afip_validez: string | null
          afip_version: number
          anulacion_idempotency_key: string | null
          anulacion_idempotency_payload_hash: string | null
          cae: string | null
          cae_vencimiento: string | null
          caja_sesion_id: string | null
          cliente_id: string
          condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          created_at: string
          estado: Database["public"]["Enums"]["estado_venta"]
          estado_pago: Database["public"]["Enums"]["estado_pago"]
          fecha: string
          id: string
          idempotency_key: string | null
          idempotency_payload_hash: string | null
          iva_total: number
          motivo_nota_credito: string | null
          nc_efectos_aplicados_at: string | null
          nc_periodo_modalidad:
            | Database["public"]["Enums"]["modalidad_nc_periodo"]
            | null
          nc_periodo_payload_hash: string | null
          nc_resolucion:
            | Database["public"]["Enums"]["resolucion_nc_periodo"]
            | null
          nombre_obra: string | null
          numero_comprobante: string
          observaciones: string | null
          percepciones: number
          periodo_asoc_desde: string | null
          periodo_asoc_hasta: string | null
          subtotal_sin_iva: number
          sucursal_id: string
          tipo_comprobante: Database["public"]["Enums"]["tipo_comprobante"]
          total: number
          total_pagado: number
          updated_at: string
          usuario_id: string
          venta_anulada_por: string | null
        }
        Insert: {
          afip_cbte_asoc_id?: string | null
          afip_cbte_tipo?: number | null
          afip_claim_token?: string | null
          afip_claimed_at?: string | null
          afip_emisor_cuit?: string | null
          afip_emitido_at?: string | null
          afip_error?: string | null
          afip_error_clase?: string | null
          afip_error_codigo?: string | null
          afip_error_fase?: string | null
          afip_estado?: string
          afip_fase?: string | null
          afip_fecha_comprobante?: string | null
          afip_imp_total?: number | null
          afip_intentos?: number
          afip_legacy_incompleto?: boolean
          afip_modo?: string | null
          afip_numero?: number | null
          afip_punto_venta?: number | null
          afip_simulado?: boolean
          afip_snapshot?: Json | null
          afip_snapshot_hash?: string | null
          afip_ultimo_error_at?: string | null
          afip_validez?: string | null
          afip_version?: number
          anulacion_idempotency_key?: string | null
          anulacion_idempotency_payload_hash?: string | null
          cae?: string | null
          cae_vencimiento?: string | null
          caja_sesion_id?: string | null
          cliente_id: string
          condicion_venta?: Database["public"]["Enums"]["condicion_venta"]
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_venta"]
          estado_pago?: Database["public"]["Enums"]["estado_pago"]
          fecha?: string
          id?: string
          idempotency_key?: string | null
          idempotency_payload_hash?: string | null
          iva_total?: number
          motivo_nota_credito?: string | null
          nc_efectos_aplicados_at?: string | null
          nc_periodo_modalidad?:
            | Database["public"]["Enums"]["modalidad_nc_periodo"]
            | null
          nc_periodo_payload_hash?: string | null
          nc_resolucion?:
            | Database["public"]["Enums"]["resolucion_nc_periodo"]
            | null
          nombre_obra?: string | null
          numero_comprobante: string
          observaciones?: string | null
          percepciones?: number
          periodo_asoc_desde?: string | null
          periodo_asoc_hasta?: string | null
          subtotal_sin_iva?: number
          sucursal_id: string
          tipo_comprobante: Database["public"]["Enums"]["tipo_comprobante"]
          total?: number
          total_pagado?: number
          updated_at?: string
          usuario_id: string
          venta_anulada_por?: string | null
        }
        Update: {
          afip_cbte_asoc_id?: string | null
          afip_cbte_tipo?: number | null
          afip_claim_token?: string | null
          afip_claimed_at?: string | null
          afip_emisor_cuit?: string | null
          afip_emitido_at?: string | null
          afip_error?: string | null
          afip_error_clase?: string | null
          afip_error_codigo?: string | null
          afip_error_fase?: string | null
          afip_estado?: string
          afip_fase?: string | null
          afip_fecha_comprobante?: string | null
          afip_imp_total?: number | null
          afip_intentos?: number
          afip_legacy_incompleto?: boolean
          afip_modo?: string | null
          afip_numero?: number | null
          afip_punto_venta?: number | null
          afip_simulado?: boolean
          afip_snapshot?: Json | null
          afip_snapshot_hash?: string | null
          afip_ultimo_error_at?: string | null
          afip_validez?: string | null
          afip_version?: number
          anulacion_idempotency_key?: string | null
          anulacion_idempotency_payload_hash?: string | null
          cae?: string | null
          cae_vencimiento?: string | null
          caja_sesion_id?: string | null
          cliente_id?: string
          condicion_venta?: Database["public"]["Enums"]["condicion_venta"]
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_venta"]
          estado_pago?: Database["public"]["Enums"]["estado_pago"]
          fecha?: string
          id?: string
          idempotency_key?: string | null
          idempotency_payload_hash?: string | null
          iva_total?: number
          motivo_nota_credito?: string | null
          nc_efectos_aplicados_at?: string | null
          nc_periodo_modalidad?:
            | Database["public"]["Enums"]["modalidad_nc_periodo"]
            | null
          nc_periodo_payload_hash?: string | null
          nc_resolucion?:
            | Database["public"]["Enums"]["resolucion_nc_periodo"]
            | null
          nombre_obra?: string | null
          numero_comprobante?: string
          observaciones?: string | null
          percepciones?: number
          periodo_asoc_desde?: string | null
          periodo_asoc_hasta?: string | null
          subtotal_sin_iva?: number
          sucursal_id?: string
          tipo_comprobante?: Database["public"]["Enums"]["tipo_comprobante"]
          total?: number
          total_pagado?: number
          updated_at?: string
          usuario_id?: string
          venta_anulada_por?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ventas_afip_cbte_asoc_id_fkey"
            columns: ["afip_cbte_asoc_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_afip_cbte_asoc_id_fkey"
            columns: ["afip_cbte_asoc_id"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
          {
            foreignKeyName: "ventas_caja_sesion_id_fkey"
            columns: ["caja_sesion_id"]
            isOneToOne: false
            referencedRelation: "caja_sesiones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "ventas_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "ventas_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_venta_anulada_por_fkey"
            columns: ["venta_anulada_por"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_venta_anulada_por_fkey"
            columns: ["venta_anulada_por"]
            isOneToOne: false
            referencedRelation: "ventas_saldo_pendiente"
            referencedColumns: ["venta_id"]
          },
        ]
      }
    }
    Views: {
      cuenta_corriente_saldos: {
        Row: {
          cliente_id: string | null
          cuit_dni: string | null
          limite_credito: number | null
          razon_social: string | null
          saldo: number | null
          telefono: string | null
          total_debe: number | null
          total_pagado: number | null
        }
        Relationships: []
      }
      fiscal_config_publica: {
        Row: {
          cert_alias: string | null
          cert_vence_at: string | null
          condicion_iva: string | null
          cuit: string | null
          domicilio_fiscal: string | null
          habilitada: boolean | null
          ingresos_brutos: string | null
          inicio_actividades: string | null
          nombre_fantasia: string | null
          razon_social: string | null
          tiene_certificado: boolean | null
          tiene_clave: boolean | null
        }
        Insert: {
          cert_alias?: string | null
          cert_vence_at?: string | null
          condicion_iva?: string | null
          cuit?: string | null
          domicilio_fiscal?: string | null
          habilitada?: boolean | null
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          tiene_certificado?: never
          tiene_clave?: never
        }
        Update: {
          cert_alias?: string | null
          cert_vence_at?: string | null
          condicion_iva?: string | null
          cuit?: string | null
          domicilio_fiscal?: string | null
          habilitada?: boolean | null
          ingresos_brutos?: string | null
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          tiene_certificado?: never
          tiene_clave?: never
        }
        Relationships: []
      }
      proveedor_cc_saldos: {
        Row: {
          cuit_dni: string | null
          proveedor_id: string | null
          razon_social: string | null
          saldo: number | null
          total_debe: number | null
          total_pagado: number | null
        }
        Relationships: []
      }
      seguimiento_producto: {
        Row: {
          cantidad: number | null
          cantidad_anterior: number | null
          cantidad_nueva: number | null
          comprobante: string | null
          con_quien: string | null
          condicion_venta: string | null
          created_at: string | null
          id: string | null
          motivo: string | null
          producto_id: string | null
          sucursal_id: string | null
          tipo: Database["public"]["Enums"]["tipo_movimiento_stock"] | null
          usuario_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movimientos_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "productos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movimientos_producto_id_fkey"
            columns: ["producto_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["producto_id"]
          },
          {
            foreignKeyName: "stock_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "stock_movimientos_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_inventario: {
        Row: {
          cantidad: number | null
          cargado: boolean | null
          categoria_id: string | null
          codigo: string | null
          fue_contado: boolean | null
          marca_id: string | null
          nombre: string | null
          producto_id: string | null
          stock_minimo: number | null
          sucursal_codigo: string | null
          sucursal_id: string | null
          sucursal_nombre: string | null
          tamano_envase: number | null
          tiene_fila: boolean | null
          tiene_movimientos: boolean | null
          unidad_medida: string | null
        }
        Relationships: [
          {
            foreignKeyName: "productos_categoria_id_fkey"
            columns: ["categoria_id"]
            isOneToOne: false
            referencedRelation: "categorias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productos_marca_id_fkey"
            columns: ["marca_id"]
            isOneToOne: false
            referencedRelation: "marcas"
            referencedColumns: ["id"]
          },
        ]
      }
      ventas_saldo_pendiente: {
        Row: {
          cliente: string | null
          cliente_id: string | null
          cobrado: number | null
          fecha: string | null
          numero_comprobante: string | null
          saldo: number | null
          sucursal_id: string | null
          sucursal_nombre: string | null
          total: number | null
          venta_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ventas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ventas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "cuenta_corriente_saldos"
            referencedColumns: ["cliente_id"]
          },
          {
            foreignKeyName: "ventas_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "stock_inventario"
            referencedColumns: ["sucursal_id"]
          },
          {
            foreignKeyName: "ventas_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _anular_venta_core_20260823: {
        Args: { p_venta_id: string }
        Returns: {
          nc_id: string
          nc_numero: string
        }[]
      }
      _crear_nc_periodo_core_pre_hash_fix1: {
        Args: {
          p_cliente_id: string
          p_idempotency_key: string
          p_items: Json
          p_modalidad: Database["public"]["Enums"]["modalidad_nc_periodo"]
          p_motivo: string
          p_periodo_desde: string
          p_periodo_hasta: string
          p_reintegros: Json
          p_resolucion: Database["public"]["Enums"]["resolucion_nc_periodo"]
          p_sucursal_id: string
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      _crear_nota_credito_periodo_fiscal_core_20260828: {
        Args: {
          p_cliente_id: string
          p_idempotency_key: string
          p_items: Json
          p_modalidad: Database["public"]["Enums"]["modalidad_nc_periodo"]
          p_motivo: string
          p_periodo_desde: string
          p_periodo_hasta: string
          p_reintegros: Json
          p_resolucion: Database["public"]["Enums"]["resolucion_nc_periodo"]
          p_sucursal_id: string
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      _crear_venta_core_20260823: {
        Args: {
          p_cbte_asoc_id?: string
          p_cliente_id: string
          p_condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          p_fecha?: string
          p_idempotency_key?: string
          p_items: Json
          p_nombre_obra?: string
          p_observaciones?: string
          p_pagos: Json
          p_percepciones?: number
          p_sucursal_id: string
          p_tipo_comprobante: Database["public"]["Enums"]["tipo_comprobante"]
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      _transicionar_emision_fiscal_core_task8_fix1: {
        Args: {
          p_accion: string
          p_claim_token: string
          p_payload?: Json
          p_venta_id: string
        }
        Returns: {
          afip_claim_token: string
          afip_estado: string
          afip_fase: string
          afip_numero: number
          afip_version: number
          venta_id: string
        }[]
      }
      _validar_snapshot_fiscal_v3_con_condicion_legacy_20260829: {
        Args: { p_snapshot: Json }
        Returns: undefined
      }
      abrir_caja: {
        Args: { p_fondo_inicial?: number; p_sucursal_id: string }
        Returns: string
      }
      activar_productos: { Args: { p_ids: string[] }; Returns: Json }
      actualizar_items_borrador: {
        Args: { p_ingreso_id: string; p_items: Json }
        Returns: undefined
      }
      administrar_puede_emitir_nc_periodo: {
        Args: { p_habilitado: boolean; p_profile_id: string }
        Returns: undefined
      }
      administrar_puede_facturar: {
        Args: { p_profile_id: string; p_puede_facturar: boolean }
        Returns: undefined
      }
      administrar_puede_gestionar_credito_clientes: {
        Args: { p_profile_id: string; p_puede: boolean }
        Returns: undefined
      }
      ajustar_stock: {
        Args: {
          p_motivo: string
          p_nueva_cantidad: number
          p_producto_id: string
          p_sucursal_id: string
        }
        Returns: {
          cantidad_anterior: number
          cantidad_nueva: number
        }[]
      }
      ajustar_stock_masivo: {
        Args: {
          p_contado_desde?: string
          p_idempotency_key?: string
          p_items: Json
          p_motivo: string
          p_sucursal_id: string
        }
        Returns: Json
      }
      anular_compra: { Args: { p_compra_id: string }; Returns: undefined }
      anular_ingreso_mercaderia: {
        Args: { p_ingreso_id: string; p_motivo?: string }
        Returns: undefined
      }
      anular_pago_proveedor: { Args: { p_pago_id: string }; Returns: undefined }
      anular_presupuesto: {
        Args: { p_presupuesto_id: string }
        Returns: undefined
      }
      anular_venta: {
        Args: { p_idempotency_key?: string; p_venta_id: string }
        Returns: {
          nc_id: string
          nc_numero: string
        }[]
      }
      aplicar_efectos_nc_periodo: {
        Args: { p_venta_id: string }
        Returns: undefined
      }
      aprobar_remito: { Args: { p_remito_id: string }; Returns: undefined }
      backfill_cola_fiscal: {
        Args: { p_aplicar?: boolean }
        Returns: {
          cantidad: number
          estado_destino: string
        }[]
      }
      buscar_productos_similares: {
        Args: {
          p_codigo?: string
          p_limite?: number
          p_proveedor_id?: string
          p_texto: string
        }
        Returns: {
          activo: boolean
          codigo: string
          id: string
          iva_porcentaje: number
          nombre: string
          score: number
        }[]
      }
      caja_esperado: { Args: { _sesion_id: string }; Returns: Json }
      caja_sesion_actual: { Args: { p_sucursal_id: string }; Returns: string }
      cambiar_precios_masivo: {
        Args: {
          p_idempotency_key: string
          p_operacion: string
          p_porcentaje: number
          p_producto_ids: string[]
        }
        Returns: Json
      }
      cambiar_sucursal_activa: {
        Args: { p_sucursal_id: string }
        Returns: undefined
      }
      cc_registrar_por_venta: {
        Args: { _venta_id: string }
        Returns: undefined
      }
      cc_resumen: {
        Args: { _cliente_id: string }
        Returns: {
          saldo: number
          total_debe: number
          total_pagado: number
        }[]
      }
      cc_saldo: { Args: { _cliente_id: string }; Returns: number }
      cerrar_caja: {
        Args: {
          p_contado?: Json
          p_efectivo_dejado?: number
          p_notas?: string
          p_sesion_id: string
        }
        Returns: {
          total_contado: number
          total_diferencia: number
          total_esperado: number
        }[]
      }
      clave_nombre: { Args: { v: string }; Returns: string }
      cobrar_saldo_venta: {
        Args: {
          p_detalle?: Json
          p_forma_pago: string
          p_idempotency_key?: string
          p_monto: number
          p_venta_id: string
        }
        Returns: {
          estado: string
          pagado: number
          saldo: number
        }[]
      }
      cola_fiscal_lectura: {
        Args: {
          p_desde?: string
          p_documento?: string
          p_emisor_id?: string
          p_estado?: string
          p_hasta?: string
          p_page: number
          p_page_size: number
          p_sucursal_id?: string
          p_tab: string
          p_venta_id?: string
        }
        Returns: {
          conteo_emitidas: number
          conteo_historial: number
          conteo_pendientes: number
          conteo_revisar: number
          filas: Json
          filtros_disponibles: Json
          pagina: number
          paginas: number
          tamano_pagina: number
          total: number
        }[]
      }
      condicion_iva_emisor: { Args: never; Returns: string }
      confirmar_ingreso_mercaderia: {
        Args: {
          p_fecha?: string
          p_idempotency_key?: string
          p_ingreso_id: string
          p_items?: Json
          p_numero?: string
          p_observaciones?: string
        }
        Returns: string
      }
      convertir_presupuesto_en_venta_neutral: {
        Args: {
          p_cliente_id: string
          p_condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          p_idempotency_key?: string
          p_pagos?: Json
          p_presupuesto_id: string
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      corregir_cierre_caja: {
        Args: {
          p_efectivo_contado: number
          p_efectivo_dejado: number
          p_motivo: string
          p_notas: string
          p_sesion_id: string
          p_version_esperada: number
        }
        Returns: {
          correccion_version: number
          efectivo_retirado: number
          total_contado: number
          total_diferencia: number
          total_esperado: number
        }[]
      }
      corregir_ingreso_mercaderia: {
        Args: {
          p_idempotency_key: string
          p_ingreso_id: string
          p_items: Json
          p_motivo: string
        }
        Returns: string
      }
      crear_borrador_ingreso: {
        Args: {
          p_archivo_path?: string
          p_proveedor_id: string
          p_sucursal_id: string
        }
        Returns: string
      }
      crear_compra:
        | {
            Args: {
              p_condicion?: string
              p_fecha_comprobante: string
              p_fecha_vencimiento: string
              p_items: Json
              p_numero: string
              p_observaciones?: string
              p_pagos: Json
              p_percepciones?: number
              p_proveedor_id: string
              p_sucursal_id: string
              p_tipo_comprobante: string
            }
            Returns: {
              compra_id: string
            }[]
          }
        | {
            Args: {
              p_condicion?: string
              p_fecha_comprobante: string
              p_fecha_vencimiento: string
              p_iva_total: number
              p_numero: string
              p_observaciones?: string
              p_pagos: Json
              p_percepciones: number
              p_proveedor_id: string
              p_subtotal_sin_iva: number
              p_sucursal_id: string
              p_tipo_comprobante: string
            }
            Returns: {
              compra_id: string
            }[]
          }
      crear_nota_credito_periodo_fiscal: {
        Args: {
          p_cliente_id: string
          p_idempotency_key: string
          p_items: Json
          p_modalidad: Database["public"]["Enums"]["modalidad_nc_periodo"]
          p_motivo: string
          p_periodo_desde: string
          p_periodo_hasta: string
          p_reintegros: Json
          p_resolucion: Database["public"]["Enums"]["resolucion_nc_periodo"]
          p_sucursal_id: string
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      crear_presupuesto: {
        Args: {
          p_cliente_id?: string
          p_items: Json
          p_nombre_cliente?: string
          p_observaciones?: string
          p_sucursal_id: string
          p_validez_hasta?: string
        }
        Returns: {
          numero: string
          presupuesto_id: string
        }[]
      }
      crear_producto_desde_ingreso: {
        Args: {
          p_codigo: string
          p_iva?: number
          p_nombre: string
          p_precio_sin_iva?: number
        }
        Returns: string
      }
      crear_productos_faltantes: {
        Args: { p_items: Json }
        Returns: {
          creados: number
          rechazados: number
          ya_estaban: number
        }[]
      }
      crear_remito: {
        Args: {
          p_idempotency_key: string
          p_items: Json
          p_observaciones: string
          p_sucursal_destino_id: string
          p_sucursal_origen_id: string
        }
        Returns: {
          numero: string
          remito_id: string
        }[]
      }
      crear_venta: {
        Args: {
          p_cbte_asoc_id?: string
          p_cliente_id: string
          p_condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          p_fecha?: string
          p_idempotency_key?: string
          p_items: Json
          p_nombre_obra?: string
          p_observaciones?: string
          p_pagos: Json
          p_percepciones?: number
          p_sucursal_id: string
          p_tipo_comprobante: Database["public"]["Enums"]["tipo_comprobante"]
        }
        Returns: {
          es_cta_cte: boolean
          numero: string
          venta_id: string
        }[]
      }
      cuit_fiscal_snapshot_valido: {
        Args: { p_cuit: string }
        Returns: boolean
      }
      current_sucursal_id: { Args: never; Returns: string }
      desactivar_receptor_fiscal: {
        Args: { p_receptor_id: string }
        Returns: undefined
      }
      editar_presupuesto: {
        Args: {
          p_cliente_id?: string
          p_items: Json
          p_nombre_cliente?: string
          p_observaciones?: string
          p_presupuesto_id: string
          p_repreciar?: boolean
          p_validez_hasta?: string
        }
        Returns: {
          numero: string
          presupuesto_id: string
          total: number
        }[]
      }
      editar_remito: {
        Args: {
          p_items: Json
          p_observaciones: string
          p_remito_id: string
          p_sucursal_destino_id: string
        }
        Returns: undefined
      }
      efectivo_en_caja: { Args: { _sesion_id: string }; Returns: number }
      eliminar_productos: { Args: { p_ids: string[] }; Returns: Json }
      exigir_efectivo: {
        Args: {
          _monto: number
          _para_que: string
          _sesion_id: string
          _sucursal_id: string
        }
        Returns: undefined
      }
      finalizar_transicion_usuario_activo: {
        Args: {
          p_operacion_id: string
          p_profile_id: string
          p_version: number
        }
        Returns: Json
      }
      fiscal_json_canonico: { Args: { p_value: Json }; Returns: string }
      fiscal_snapshot_hash: { Args: { p_snapshot: Json }; Returns: string }
      forzar_cierre_usuario_activo_fail_safe: {
        Args: { p_operacion_id: string; p_profile_id: string }
        Returns: Json
      }
      guardar_extraccion_ingreso: {
        Args: {
          p_archivo_path?: string
          p_bloqueo?: string
          p_error?: string
          p_extraccion?: Json
          p_fecha?: string
          p_ingreso_id: string
          p_items?: Json
          p_numero?: string
          p_uso_tokens?: Json
        }
        Returns: undefined
      }
      guardar_receptor_fiscal_desde_venta: {
        Args: { p_venta_id: string }
        Returns: {
          cliente_comercial_id: string
          condicion_iva: string
          domicilio: string
          id: string
          numero_documento: string
          razon_social: string
          sucursal_id: string
          tipo_documento: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      iniciar_conteo_stock: { Args: never; Returns: string }
      iniciar_transicion_usuario_activo: {
        Args: {
          p_activo: boolean
          p_actor_id: string
          p_operacion_id: string
          p_profile_id: string
        }
        Returns: Json
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      leer_venta_fiscal_exacta: { Args: { p_venta_id: string }; Returns: Json }
      materializar_intencion_nc_periodo: {
        Args: { p_venta_id: string }
        Returns: {
          payload: Json
          payload_hash: string
          reintegros_vector: Json
        }[]
      }
      next_comprobante_numero: {
        Args: {
          _sucursal_id: string
          _tipo: Database["public"]["Enums"]["tipo_comprobante"]
        }
        Returns: string
      }
      next_documento_numero: {
        Args: { _prefijo: string; _sucursal_id: string; _tipo: string }
        Returns: string
      }
      normalizar_codigo: { Args: { p_texto: string }; Returns: string }
      normalizar_cuit_dni: { Args: { v: string }; Returns: string }
      producto_tiene_presupuesto: {
        Args: { _producto_id: string }
        Returns: boolean
      }
      proveedor_saldo: { Args: { _proveedor_id: string }; Returns: number }
      puede_emitir_nc_periodo: { Args: { _uid?: string }; Returns: boolean }
      puede_facturar: { Args: { _uid?: string }; Returns: boolean }
      puede_gestionar_credito_clientes: {
        Args: { _uid?: string }
        Returns: boolean
      }
      puede_vender_sin_stock: { Args: { _uid: string }; Returns: boolean }
      rechazar_remito: {
        Args: { p_motivo?: string; p_remito_id: string }
        Returns: undefined
      }
      reclamar_reconciliacion_usuario_activo: {
        Args: {
          p_operacion_id: string
          p_profile_id: string
          p_version_observada: number
        }
        Returns: Json
      }
      registrar_cobranza: {
        Args: {
          p_cliente_id: string
          p_detalle?: Json
          p_forma_pago: string
          p_monto: number
          p_observaciones?: string
          p_sucursal_id: string
        }
        Returns: {
          cobranza_id: string
          saldo: number
        }[]
      }
      registrar_gasto: {
        Args: {
          p_descripcion: string
          p_forma_pago: string
          p_monto: number
          p_sucursal_id: string
        }
        Returns: string
      }
      registrar_movimiento_caja: {
        Args: {
          p_descripcion: string
          p_forma_pago: Database["public"]["Enums"]["forma_pago"]
          p_monto: number
          p_sesion_id: string
          p_tipo: Database["public"]["Enums"]["caja_mov_tipo"]
        }
        Returns: string
      }
      registrar_pago_proveedor: {
        Args: {
          p_detalle?: Json
          p_forma_pago: string
          p_monto: number
          p_proveedor_id: string
          p_sucursal_id: string
        }
        Returns: string
      }
      resolver_cliente_obra: { Args: { p_nombre: string }; Returns: string }
      restaurar_productos: { Args: { p_ids: string[] }; Returns: number }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      transicionar_emision_fiscal: {
        Args: {
          p_accion: string
          p_claim_token: string
          p_payload?: Json
          p_venta_id: string
        }
        Returns: {
          afip_claim_token: string
          afip_estado: string
          afip_fase: string
          afip_numero: number
          afip_version: number
          venta_id: string
        }[]
      }
      validar_evidencia_cae_fiscal: {
        Args: {
          p_cae: Json
          p_cae_vencimiento: Json
          p_emitido_at: Json
          p_evidencia: Json
          p_origen: string
        }
        Returns: {
          cae: string
          cae_vencimiento: string
          emitido_at: string
        }[]
      }
      validar_perfil_activo_postgrest: { Args: never; Returns: undefined }
      validar_snapshot_fiscal_persistido: {
        Args: { p_snapshot: Json }
        Returns: number
      }
      validar_snapshot_fiscal_v2: {
        Args: { p_snapshot: Json }
        Returns: undefined
      }
      validar_snapshot_fiscal_v3: {
        Args: { p_snapshot: Json }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "empleado"
      caja_mov_tipo: "INICIAL" | "INGRESO" | "GASTO" | "RETIRO"
      caja_sesion_estado: "ABIERTA" | "CERRADA"
      cc_mov_estado: "CONFIRMADO" | "ANULADO"
      cc_mov_tipo: "DEBITO" | "CREDITO"
      condicion_venta: "CONTADO" | "CTA_CTE"
      estado_pago: "PAGADO" | "PARCIAL" | "PENDIENTE"
      estado_remito: "PENDIENTE" | "APROBADO" | "RECHAZADO"
      estado_venta: "ACTIVA" | "ANULADA" | "PENDIENTE_FISCAL"
      forma_pago:
        | "EFECTIVO"
        | "TRANSFERENCIA"
        | "TARJETA_DEBITO"
        | "TARJETA_CREDITO"
        | "MERCADO_PAGO"
        | "CHEQUE"
        | "CTA_CTE"
      modalidad_nc_periodo: "DEVOLUCION_PRODUCTOS" | "BONIFICACION_AJUSTE"
      proveedor_cc_tipo: "DEBITO" | "CREDITO"
      resolucion_nc_periodo: "REINTEGRO" | "SALDO_FAVOR"
      sucursal_codigo: "OHIGGINS" | "GENERALPAZ"
      tipo_cliente:
        | "CONSUMIDOR_FINAL"
        | "RESPONSABLE_INSCRIPTO"
        | "MONOTRIBUTISTA"
        | "EXENTO"
      tipo_comprobante:
        | "FACTURA_A"
        | "FACTURA_B"
        | "NOTA_CREDITO"
        | "REMITO"
        | "NOTA_DEBITO"
        | "FAC_INTERNA_CTA_CTE"
        | "REMITO_OBRA"
        | "FACTURA_C"
        | "VENTA"
      tipo_movimiento_stock:
        | "VENTA"
        | "AJUSTE"
        | "TRANSFERENCIA_OUT"
        | "TRANSFERENCIA_IN"
        | "INGRESO_INICIAL"
        | "ANULACION_VENTA"
        | "COMPRA"
        | "ANULACION_COMPRA"
        | "DEVOLUCION"
        | "INGRESO_MERCADERIA"
        | "ANULACION_INGRESO_MERCADERIA"
        | "CORRECCION_INGRESO_MERCADERIA"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["admin", "empleado"],
      caja_mov_tipo: ["INICIAL", "INGRESO", "GASTO", "RETIRO"],
      caja_sesion_estado: ["ABIERTA", "CERRADA"],
      cc_mov_estado: ["CONFIRMADO", "ANULADO"],
      cc_mov_tipo: ["DEBITO", "CREDITO"],
      condicion_venta: ["CONTADO", "CTA_CTE"],
      estado_pago: ["PAGADO", "PARCIAL", "PENDIENTE"],
      estado_remito: ["PENDIENTE", "APROBADO", "RECHAZADO"],
      estado_venta: ["ACTIVA", "ANULADA", "PENDIENTE_FISCAL"],
      forma_pago: [
        "EFECTIVO",
        "TRANSFERENCIA",
        "TARJETA_DEBITO",
        "TARJETA_CREDITO",
        "MERCADO_PAGO",
        "CHEQUE",
        "CTA_CTE",
      ],
      modalidad_nc_periodo: ["DEVOLUCION_PRODUCTOS", "BONIFICACION_AJUSTE"],
      proveedor_cc_tipo: ["DEBITO", "CREDITO"],
      resolucion_nc_periodo: ["REINTEGRO", "SALDO_FAVOR"],
      sucursal_codigo: ["OHIGGINS", "GENERALPAZ"],
      tipo_cliente: [
        "CONSUMIDOR_FINAL",
        "RESPONSABLE_INSCRIPTO",
        "MONOTRIBUTISTA",
        "EXENTO",
      ],
      tipo_comprobante: [
        "FACTURA_A",
        "FACTURA_B",
        "NOTA_CREDITO",
        "REMITO",
        "NOTA_DEBITO",
        "FAC_INTERNA_CTA_CTE",
        "REMITO_OBRA",
        "FACTURA_C",
        "VENTA",
      ],
      tipo_movimiento_stock: [
        "VENTA",
        "AJUSTE",
        "TRANSFERENCIA_OUT",
        "TRANSFERENCIA_IN",
        "INGRESO_INICIAL",
        "ANULACION_VENTA",
        "COMPRA",
        "ANULACION_COMPRA",
        "DEVOLUCION",
        "INGRESO_MERCADERIA",
        "ANULACION_INGRESO_MERCADERIA",
        "CORRECCION_INGRESO_MERCADERIA",
      ],
    },
  },
} as const
