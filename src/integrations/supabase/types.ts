export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
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
          nombre: string
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
          nombre: string
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
          nombre?: string
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
          cliente_id: string
          condicion_venta: Database["public"]["Enums"]["condicion_venta"]
          created_at: string
          estado: Database["public"]["Enums"]["estado_venta"]
          estado_pago: Database["public"]["Enums"]["estado_pago"]
          fecha: string
          id: string
          iva_total: number
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
          cliente_id: string
          condicion_venta?: Database["public"]["Enums"]["condicion_venta"]
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_venta"]
          estado_pago?: Database["public"]["Enums"]["estado_pago"]
          fecha?: string
          id?: string
          iva_total?: number
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
          cliente_id?: string
          condicion_venta?: Database["public"]["Enums"]["condicion_venta"]
          created_at?: string
          estado?: Database["public"]["Enums"]["estado_venta"]
          estado_pago?: Database["public"]["Enums"]["estado_pago"]
          fecha?: string
          id?: string
          iva_total?: number
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
            foreignKeyName: "ventas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
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
      [_ in never]: never
    }
    Functions: {
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
    }
    Enums: {
      app_role: "admin" | "empleado"
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
      tipo_comprobante: "FACTURA_A" | "FACTURA_B" | "NOTA_CREDITO" | "REMITO"
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
  public: {
    Enums: {
      app_role: ["admin", "empleado"],
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
      tipo_comprobante: ["FACTURA_A", "FACTURA_B", "NOTA_CREDITO", "REMITO"],
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
