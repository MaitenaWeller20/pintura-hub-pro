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
          created_at: string
          diferencia: Json | null
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
          created_at?: string
          diferencia?: Json | null
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
          created_at?: string
          diferencia?: Json | null
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
            referencedRelation: "sucursales"
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
        ]
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
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          updated_at?: string
        }
        Relationships: []
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
      productos: {
        Row: {
          activo: boolean
          categoria_id: string | null
          codigo: string
          codigo_barras: string | null
          created_at: string
          descripcion: string | null
          id: string
          iva_porcentaje: number
          marca_id: string | null
          markup_porcentaje: number | null
          nombre: string
          precio_fabrica: number
          precio_sin_iva: number
          stock_minimo: number
          unidad_medida: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          categoria_id?: string | null
          codigo: string
          codigo_barras?: string | null
          created_at?: string
          descripcion?: string | null
          id?: string
          iva_porcentaje?: number
          marca_id?: string | null
          markup_porcentaje?: number | null
          nombre: string
          precio_fabrica?: number
          precio_sin_iva?: number
          stock_minimo?: number
          unidad_medida?: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          categoria_id?: string | null
          codigo?: string
          codigo_barras?: string | null
          created_at?: string
          descripcion?: string | null
          id?: string
          iva_porcentaje?: number
          marca_id?: string | null
          markup_porcentaje?: number | null
          nombre?: string
          precio_fabrica?: number
          precio_sin_iva?: number
          stock_minimo?: number
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
        ]
      }
      profiles: {
        Row: {
          activo: boolean
          created_at: string
          id: string
          nombre_completo: string | null
          sucursal_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          activo?: boolean
          created_at?: string
          id: string
          nombre_completo?: string | null
          sucursal_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          activo?: boolean
          created_at?: string
          id?: string
          nombre_completo?: string | null
          sucursal_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      puntos_venta: {
        Row: {
          activo: boolean
          created_at: string
          id: string
          modo: string
          numero: number
          sucursal_id: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          created_at?: string
          id?: string
          modo?: string
          numero: number
          sucursal_id: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          created_at?: string
          id?: string
          modo?: string
          numero?: number
          sucursal_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "puntos_venta_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: true
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
          motivo_rechazo: string | null
          numero: string
          observaciones: string | null
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
          motivo_rechazo?: string | null
          numero: string
          observaciones?: string | null
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
          motivo_rechazo?: string | null
          numero?: string
          observaciones?: string | null
          sucursal_destino_id?: string
          sucursal_origen_id?: string
          updated_at?: string
        }
        Relationships: [
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
            referencedRelation: "sucursales"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          id: boolean
          markup_default_porcentaje: number
          permitir_stock_negativo: boolean
          updated_at: string
        }
        Insert: {
          id?: boolean
          markup_default_porcentaje?: number
          permitir_stock_negativo?: boolean
          updated_at?: string
        }
        Update: {
          id?: boolean
          markup_default_porcentaje?: number
          permitir_stock_negativo?: boolean
          updated_at?: string
        }
        Relationships: []
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
            foreignKeyName: "stock_sucursal_sucursal_id_fkey"
            columns: ["sucursal_id"]
            isOneToOne: false
            referencedRelation: "sucursales"
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
          id?: string
          nombre?: string
          numero?: string
          telefono?: string | null
          updated_at?: string
        }
        Relationships: []
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
          producto_id: string
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
          producto_id: string
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
          producto_id?: string
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
            foreignKeyName: "venta_items_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
        ]
      }
      venta_pagos: {
        Row: {
          created_at: string
          detalle: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id: string
          monto: number
          venta_id: string
        }
        Insert: {
          created_at?: string
          detalle?: Json
          forma_pago: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto: number
          venta_id: string
        }
        Update: {
          created_at?: string
          detalle?: Json
          forma_pago?: Database["public"]["Enums"]["forma_pago"]
          id?: string
          monto?: number
          venta_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venta_pagos_venta_id_fkey"
            columns: ["venta_id"]
            isOneToOne: false
            referencedRelation: "ventas"
            referencedColumns: ["id"]
          },
        ]
      }
      ventas: {
        Row: {
          afip_cbte_asoc_id: string | null
          afip_cbte_tipo: number | null
          afip_emitido_at: string | null
          afip_error: string | null
          afip_estado: string
          afip_imp_total: number | null
          afip_intentos: number
          afip_modo: string | null
          afip_numero: number | null
          afip_punto_venta: number | null
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
          iva_total: number
          nombre_obra: string | null
          numero_comprobante: string
          observaciones: string | null
          percepciones: number
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
          afip_emitido_at?: string | null
          afip_error?: string | null
          afip_estado?: string
          afip_imp_total?: number | null
          afip_intentos?: number
          afip_modo?: string | null
          afip_numero?: number | null
          afip_punto_venta?: number | null
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
          iva_total?: number
          nombre_obra?: string | null
          numero_comprobante: string
          observaciones?: string | null
          percepciones?: number
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
          afip_emitido_at?: string | null
          afip_error?: string | null
          afip_estado?: string
          afip_imp_total?: number | null
          afip_intentos?: number
          afip_modo?: string | null
          afip_numero?: number | null
          afip_punto_venta?: number | null
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
          iva_total?: number
          nombre_obra?: string | null
          numero_comprobante?: string
          observaciones?: string | null
          percepciones?: number
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
          inicio_actividades?: string | null
          nombre_fantasia?: string | null
          razon_social?: string | null
          tiene_certificado?: never
          tiene_clave?: never
        }
        Relationships: []
      }
    }
    Functions: {
      abrir_caja: {
        Args: { p_fondo_inicial?: number; p_sucursal_id: string }
        Returns: string
      }
      anular_venta: {
        Args: { p_venta_id: string }
        Returns: {
          nc_id: string
          nc_numero: string
        }[]
      }
      caja_esperado: { Args: { _sesion_id: string }; Returns: Json }
      cc_registrar_por_venta: {
        Args: { _venta_id: string }
        Returns: undefined
      }
      cc_saldo: { Args: { _cliente_id: string }; Returns: number }
      cerrar_caja: {
        Args: { p_contado?: Json; p_notas?: string; p_sesion_id: string }
        Returns: {
          total_contado: number
          total_diferencia: number
          total_esperado: number
        }[]
      }
      crear_venta: {
        Args: {
          p_cbte_asoc_id?: string
          p_cliente_id: string
          p_condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          p_fecha?: string
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
      current_sucursal_id: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      next_comprobante_numero: {
        Args: {
          _sucursal_id: string
          _tipo: Database["public"]["Enums"]["tipo_comprobante"]
        }
        Returns: string
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
      estado_venta: "ACTIVA" | "ANULADA"
      forma_pago:
        | "EFECTIVO"
        | "TRANSFERENCIA"
        | "TARJETA_DEBITO"
        | "TARJETA_CREDITO"
        | "MERCADO_PAGO"
        | "CHEQUE"
        | "CTA_CTE"
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
      tipo_movimiento_stock:
        | "VENTA"
        | "AJUSTE"
        | "TRANSFERENCIA_OUT"
        | "TRANSFERENCIA_IN"
        | "INGRESO_INICIAL"
        | "ANULACION_VENTA"
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
      estado_venta: ["ACTIVA", "ANULADA"],
      forma_pago: [
        "EFECTIVO",
        "TRANSFERENCIA",
        "TARJETA_DEBITO",
        "TARJETA_CREDITO",
        "MERCADO_PAGO",
        "CHEQUE",
        "CTA_CTE",
      ],
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
      ],
      tipo_movimiento_stock: [
        "VENTA",
        "AJUSTE",
        "TRANSFERENCIA_OUT",
        "TRANSFERENCIA_IN",
        "INGRESO_INICIAL",
        "ANULACION_VENTA",
      ],
    },
  },
} as const

