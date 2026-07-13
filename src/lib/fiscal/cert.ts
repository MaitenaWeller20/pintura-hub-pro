import forge from "node-forge";

/**
 * Certificado digital de AFIP.
 *
 * El flujo (es un trámite, no un botón):
 *   1. Generamos acá el par de claves RSA + el CSR.
 *   2. La clave privada queda cifrada en la base y NUNCA sale del servidor.
 *   3. El CSR (que es público) se le da al contador, que lo sube a AFIP.
 *   4. AFIP devuelve un .crt, que se sube acá.
 *   5. Recién ahí se puede pedir un CAE real.
 *
 * Usamos node-forge (JS puro) y NO el binario openssl: en Vercel openssl está
 * roto (symbol lookup error). Esta es una cicatriz de lubricentro, no una
 * preferencia estética.
 */

// El CUIT de ejemplo de AFIP. Si alguien deja este puesto, el CSR sale mal y
// AFIP lo rechaza sin explicar por qué.
const CUIT_PROVISORIO = "20111111112";

/** X.509 limita los campos del DN a 64 chars y AFIP rechaza caracteres raros. */
const limpio = (s: string) => s.replace(/[^a-zA-Z0-9 .\-]/g, "").slice(0, 64);

export interface ParYCsr {
  csr: string;
  keyPem: string;
}

/**
 * Genera clave privada RSA 2048 + CSR firmado con SHA-256.
 *
 * El subject es exactamente el que pide AFIP:
 *   C=AR, O=<razón social>, CN=<alias>, serialNumber=CUIT <11 dígitos>
 * (serialNumber va por OID crudo 2.5.4.5 porque node-forge no le da shortName.)
 *
 * generateKeyPair se usa en su forma asíncrona: la versión sincrónica bloquea el
 * event loop varios segundos y se come el timeout de la función serverless.
 */
export function generarParYCsr(razonSocial: string, alias: string, cuit: string): Promise<ParYCsr> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, keys) => {
      if (err || !keys) return reject(err ?? new Error("No se pudo generar la clave."));
      try {
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keys.publicKey;
        csr.setSubject([
          { shortName: "C", value: "AR" },
          { shortName: "O", value: razonSocial },
          { shortName: "CN", value: alias },
          { type: "2.5.4.5", value: `CUIT ${cuit}` },
        ]);
        csr.sign(keys.privateKey, forge.md.sha256.create());
        resolve({
          csr: forge.pki.certificationRequestToPem(csr),
          keyPem: forge.pki.privateKeyToPem(keys.privateKey),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function validarCuitEmisor(cuit: string | null | undefined): string {
  const limpio = (cuit ?? "").replace(/\D/g, "");
  if (limpio.length !== 11) {
    throw new Error("Cargá el CUIT del emisor (11 dígitos) antes de generar el CSR.");
  }
  if (limpio === CUIT_PROVISORIO) {
    throw new Error("Ese es el CUIT de ejemplo de AFIP. Cargá el CUIT real del negocio.");
  }
  return limpio;
}

export function prepararSubject(razonSocial: string | null, nombreFantasia: string | null) {
  const org = limpio(razonSocial || "") || "Empresa";
  const cn = limpio(nombreFantasia || razonSocial || "") || "quimex";
  return { org, cn };
}

/**
 * Verifica que el .crt de AFIP corresponda a la clave privada que generamos, y
 * devuelve su vencimiento.
 *
 * La comprobación compara los módulos RSA. Atrapa el error clásico: subir el
 * .crt equivocado, o el del otro ambiente (homologación vs producción usan
 * certificados distintos). Sin esto, el error aparece recién al llamar a AFIP,
 * disfrazado de un fallo SOAP incomprensible.
 *
 * FALLA CERRADO: si no se puede verificar, no se acepta el certificado.
 * (lubricentro tiene acá un `if (keyPem)` que saltea la verificación en silencio
 * cuando la clave no se puede descifrar. Eso es un bug: acá no lo copiamos.)
 */
export function verificarCertificado(pem: string, keyPem: string): { vence: Date } {
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(pem);
  } catch {
    throw new Error("No se pudo leer el certificado. Tiene que ser el .crt de AFIP, en formato PEM.");
  }

  let priv: forge.pki.rsa.PrivateKey;
  try {
    priv = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  } catch {
    throw new Error(
      "La clave privada guardada no se puede leer. Regenerá el CSR y rehacé el trámite en AFIP.",
    );
  }

  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  if (!priv?.n || !pub?.n) {
    throw new Error("No se pudo verificar el certificado contra la clave (no es RSA).");
  }
  if (pub.n.toString(16) !== priv.n.toString(16)) {
    throw new Error(
      "El certificado no corresponde a la clave que generamos. ¿Subiste el .crt que te dio AFIP para ESTE CSR?",
    );
  }

  return { vence: cert.validity.notAfter };
}
