import { describe, it, expect, beforeAll } from "vitest";
import forge from "node-forge";

beforeAll(() => {
  // El cifrado exige una clave dedicada de 32+ chars.
  process.env.ARCA_ENCRYPTION_KEY = "clave-de-prueba-de-32-caracteres-o-mas!!";
});

describe("cifrado de secretos (AES-256-GCM)", () => {
  it("ida y vuelta", async () => {
    const { encryptString, decryptString } = await import("./crypto");
    const secreto = "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----";
    expect(decryptString(encryptString(secreto))).toBe(secreto);
  });

  it("cada cifrado usa un IV distinto (dos cifrados del mismo texto no coinciden)", async () => {
    const { encryptString } = await import("./crypto");
    expect(encryptString("hola")).not.toBe(encryptString("hola"));
  });

  it("descifrar null devuelve null (así fluye el 'todavía no hay certificado')", async () => {
    const { decryptString } = await import("./crypto");
    expect(decryptString(null)).toBeNull();
    expect(decryptString("")).toBeNull();
  });

  it("un dato manipulado LANZA, no devuelve null en silencio", async () => {
    const { encryptString, decryptString } = await import("./crypto");
    const cifrado = encryptString("secreto");
    const corrupto = Buffer.from(cifrado, "base64");
    corrupto[corrupto.length - 1] ^= 0xff; // manoseamos el último byte
    expect(() => decryptString(corrupto.toString("base64"))).toThrow();
  });
});

describe("CSR para AFIP", () => {
  it("rechaza el CUIT de ejemplo de AFIP y los CUIT mal formados", async () => {
    const { validarCuitEmisor } = await import("./cert");
    expect(() => validarCuitEmisor("20111111112")).toThrow(/ejemplo/i);
    expect(() => validarCuitEmisor("123")).toThrow(/11 dígitos/);
    expect(() => validarCuitEmisor(null)).toThrow();
    // CUIT con dígito verificador incorrecto: ahora también se rechaza (módulo 11).
    expect(() => validarCuitEmisor("30-71234567-8")).toThrow(/dígito verificador/i);
    // CUIT válido (mismos 10 primeros dígitos, verificador correcto = 1).
    expect(validarCuitEmisor("30-71234567-1")).toBe("30712345671");
  });

  it("genera un CSR con el subject exacto que pide AFIP", async () => {
    const { generarParYCsr } = await import("./cert");
    const { csr, keyPem } = await generarParYCsr("CasaForma SRL", "casaforma", "30712345678");

    expect(csr).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(keyPem).toContain("-----BEGIN RSA PRIVATE KEY-----");

    const parsed = forge.pki.certificationRequestFromPem(csr);
    const campo = (name: string) => parsed.subject.getField(name)?.value;
    expect(campo("C")).toBe("AR");
    expect(campo("O")).toBe("CasaForma SRL");
    expect(campo("CN")).toBe("casaforma");
    // serialNumber va por OID crudo: AFIP lo exige como "CUIT <11 dígitos>".
    expect(parsed.subject.getField({ type: "2.5.4.5" })?.value).toBe("CUIT 30712345678");

    // La clave tiene que ser RSA 2048.
    const priv = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    expect(priv.n.bitLength()).toBe(2048);
  }, 30_000); // generar RSA 2048 tarda unos segundos

  it("rechaza un certificado que no corresponde a la clave (subiste el .crt equivocado)", async () => {
    const { generarParYCsr, verificarCertificado } = await import("./cert");

    // Dos pares distintos: el certificado de uno no valida contra la clave del otro.
    const a = await generarParYCsr("Empresa A", "a", "30712345678");
    const b = await generarParYCsr("Empresa B", "b", "30712345679");

    // Autofirmamos un certificado con la clave de B.
    const keysB = forge.pki.privateKeyFromPem(b.keyPem) as forge.pki.rsa.PrivateKey;
    const csrB = forge.pki.certificationRequestFromPem(b.csr);
    const cert = forge.pki.createCertificate();
    cert.publicKey = csrB.publicKey!;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
    cert.setSubject(csrB.subject.attributes);
    cert.setIssuer(csrB.subject.attributes);
    cert.sign(keysB, forge.md.sha256.create());
    const pemB = forge.pki.certificateToPem(cert);

    // Contra la clave de B: valida y devuelve el vencimiento.
    expect(verificarCertificado(pemB, b.keyPem).vence).toBeInstanceOf(Date);

    // Contra la clave de A: tiene que fallar CERRADO.
    expect(() => verificarCertificado(pemB, a.keyPem)).toThrow(/no corresponde a la clave/i);
  }, 60_000);
});

describe("modo simulado (sin certificado de AFIP)", () => {
  it("devuelve un CAE de 14 dígitos, determinístico, para poder operar sin certificado", async () => {
    process.env.INVOICING_MOCK_MODE = "true";
    const { solicitarCae } = await import("./arca");

    const emisor = { cuit: "30712345678", arca_key_enc: null, arca_cert_enc: null };
    const pv = { numero: 1, modo: "HOMOLOGACION" as const };
    const datos = {
      cbteTipo: 6, numero: 1, fecha: new Date("2026-07-13T15:00:00Z"),
      docTipo: 99, docNro: 0, neto: 1000, iva: 210, tributos: 0, total: 1210,
      condicionIvaReceptorId: 5, alicuotas: [{ Id: 5, BaseImp: 1000, Importe: 210 }],
    };

    const r1 = await solicitarCae(emisor, pv, datos, null);
    expect(r1.cae).toHaveLength(14);
    expect(/^\d{14}$/.test(r1.cae)).toBe(true);
    expect(r1.vencimiento).toBeInstanceOf(Date);

    // El mismo comprobante da el mismo CAE; otro número da otro.
    const r2 = await solicitarCae(emisor, pv, datos, null);
    expect(r2.cae).toBe(r1.cae);
    const r3 = await solicitarCae(emisor, pv, { ...datos, numero: 2 }, null);
    expect(r3.cae).not.toBe(r1.cae);
  });
});
