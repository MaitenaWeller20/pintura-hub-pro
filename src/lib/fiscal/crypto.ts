import crypto from "node:crypto";

/**
 * Cifrado simétrico para secretos en reposo: la clave privada del certificado de
 * AFIP y el ticket de acceso (TA). AES-256-GCM, mismo esquema que lubricentro y
 * MesaYa.
 *
 * OJO: si se pierde o se rota ARCA_ENCRYPTION_KEY, el certificado guardado queda
 * indescifrable y hay que rehacer todo el trámite del CSR con AFIP. Se setea una
 * vez y no se toca.
 */

function getKey(): Buffer {
  const secret = process.env.ARCA_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    // A propósito NO cae de vuelta al secreto de sesión: ese es el tipo de clave
    // que la gente rota, y rotarla acá te deja sin certificado.
    throw new Error(
      "ARCA_ENCRYPTION_KEY no configurada (mínimo 32 caracteres). " +
        "Generala con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/** Devuelve base64 de iv(12) ‖ authTag(16) ‖ ciphertext. */
export function encryptString(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Descifra. Devuelve null si el valor es null/vacío (así fluye el caso
 * "todavía no hay certificado cargado"). Si el dato fue manipulado o la clave
 * cambió, LANZA — no devuelve null en silencio.
 */
export function decryptString(value: string | null | undefined): string | null {
  if (!value) return null;
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
