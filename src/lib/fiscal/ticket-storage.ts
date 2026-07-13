import type { AccessTicket } from "@arcasdk/core";
import { encryptString, decryptString } from "./crypto";

/**
 * Caché del ticket de acceso de AFIP (TA), respaldada en Postgres.
 *
 * POR QUÉ NO ALCANZA CON MEMORIA:
 *   1. El SDK, por defecto, escribe el TA en un directorio DENTRO del bundle.
 *      En Vercel ese path es read-only: el mkdir falla y se cae la facturación
 *      entera. (MesaYa no lo sufre porque corre en Fargate, con filesystem
 *      escribible. Nosotros vamos a Vercel.)
 *   2. lubricentro lo resuelve con un Map en RAM. Anda, pero es por proceso:
 *      cada cold start arranca vacío y pide un TA nuevo. Y AFIP RECHAZA pedir
 *      un TA si ya hay uno válido para ese (CUIT, servicio) —el famoso
 *      "coe.alreadyAuthenticated"— además de limitar los intentos de login.
 *      Con autoscaling eso es una tormenta de logins contra AFIP.
 *
 * Solución: el TA vive en la base (compartido entre todas las instancias), con
 * un Map en RAM adelante como caché de primer nivel para no ir a Postgres en
 * cada request de una instancia caliente.
 *
 * El TA son credenciales bearer contra AFIP válidas por 12h => se guarda cifrado
 * y la tabla no es accesible desde el navegador.
 */

// Tratamos como vencido lo que le quedan menos de 5 minutos: un TA que expira a
// mitad de la llamada SOAP devuelve un error de autenticación opaco.
const MARGEN_VENCIMIENTO_MS = 5 * 60 * 1000;

type SupabaseAdmin = {
  from: (t: string) => any;
};

export class SupabaseTicketStorage {
  private static l1 = new Map<string, AccessTicket>();

  constructor(
    private readonly supabase: SupabaseAdmin,
    private readonly cuit: number,
    private readonly production: boolean,
  ) {}

  private key(serviceName: string): string {
    return `${this.cuit}-${serviceName}-${this.production ? "prod" : "test"}`;
  }

  private porVencer(t: AccessTicket): boolean {
    try {
      return t.getExpiration().getTime() - Date.now() < MARGEN_VENCIMIENTO_MS;
    } catch {
      return true;
    }
  }

  async get(serviceName: string): Promise<AccessTicket | null> {
    const k = this.key(serviceName);

    const enRam = SupabaseTicketStorage.l1.get(k);
    if (enRam && !this.porVencer(enRam)) return enRam;
    SupabaseTicketStorage.l1.delete(k);

    const { data } = await this.supabase
      .from("afip_ta")
      .select("ticket_enc")
      .eq("cuit", String(this.cuit))
      .eq("service_name", serviceName)
      .eq("production", this.production)
      .maybeSingle();

    if (!data?.ticket_enc) return null;

    // AccessTicket se importa como VALOR (no `import type`) porque necesitamos
    // llamar a .create() para rehidratarlo desde el JSON guardado.
    const { AccessTicket: AT } = await import("@arcasdk/core");
    let ticket: AccessTicket;
    try {
      ticket = AT.create(JSON.parse(decryptString(data.ticket_enc)!));
    } catch {
      // Guardado corrupto o clave de cifrado rotada: que pida uno nuevo.
      return null;
    }

    if (this.porVencer(ticket)) return null;

    SupabaseTicketStorage.l1.set(k, ticket);
    return ticket;
  }

  async save(ticket: AccessTicket, serviceName: string): Promise<void> {
    SupabaseTicketStorage.l1.set(this.key(serviceName), ticket);
    await this.supabase.from("afip_ta").upsert(
      {
        cuit: String(this.cuit),
        service_name: serviceName,
        production: this.production,
        ticket_enc: encryptString(JSON.stringify(ticket.toLoginCredentials())),
        expires_at: ticket.getExpiration().toISOString(),
      },
      { onConflict: "cuit,service_name,production" },
    );
  }

  async delete(serviceName: string): Promise<void> {
    SupabaseTicketStorage.l1.delete(this.key(serviceName));
    await this.supabase
      .from("afip_ta")
      .delete()
      .eq("cuit", String(this.cuit))
      .eq("service_name", serviceName)
      .eq("production", this.production);
  }
}
