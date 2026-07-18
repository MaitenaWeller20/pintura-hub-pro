import crypto from "node:crypto";

/**
 * Cifrado simétrico para secretos en reposo: la clave privada del certificado de
 * AFIP y el ticket de acceso (TA). AES-256-GCM, mismo esquema que lubricentro y
 * MesaYa.
 *
 * OJO: si se pierde ARCA_ENCRYPTION_KEY, el certificado guardado queda
 * indescifrable y hay que rehacer todo el trámite del CSR con AFIP.
 *
 * Para PODER ROTAR la clave sin re-importar el certificado, decryptString acepta
 * una clave anterior en ARCA_ENCRYPTION_KEY_PREVIOUS: descifra con la primaria y,
 * si falla, reintenta con la anterior. Flujo de rotación: (1) mover la key actual
 * a ARCA_ENCRYPTION_KEY_PREVIOUS y poner la nueva en ARCA_ENCRYPTION_KEY;
 * (2) re-guardar el certificado (se re-cifra con la nueva); (3) borrar la anterior.
 */

function keyFrom(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/** Clave primaria (la que cifra). No cae al secreto de sesión: ese se rota. */
function getKey(): Buffer {
  const secret = process.env.ARCA_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "ARCA_ENCRYPTION_KEY no configurada (mínimo 32 caracteres). " +
        "Generala con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return keyFrom(secret);
}

/** Devuelve base64 de iv(12) ‖ authTag(16) ‖ ciphertext. Cifra SIEMPRE con la primaria. */
export function encryptString(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Descifra. Devuelve null si el valor es null/vacío (así fluye el caso
 * "todavía no hay certificado cargado"). Prueba la clave primaria y, si falla,
 * la anterior (ARCA_ENCRYPTION_KEY_PREVIOUS) para permitir rotar. Si ninguna
 * funciona (dato manipulado o clave equivocada), LANZA — no devuelve null en
 * silencio.
 */
export function decryptString(value: string | null | undefined): string | null {
  if (!value) return null;
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);

  const claves: Buffer[] = [getKey()];
  const previa = process.env.ARCA_ENCRYPTION_KEY_PREVIOUS;
  if (previa && previa.length >= 32) claves.push(keyFrom(previa));

  let ultimoError: unknown;
  for (const clave of claves) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", clave, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch (e) {
      ultimoError = e; // el authTag de GCM no valida con esta clave: probamos la siguiente
    }
  }
  throw ultimoError instanceof Error ? ultimoError : new Error("No se pudo descifrar el secreto");
}
