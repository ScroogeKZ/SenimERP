import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_KEY = Buffer.from('senimerpencryptionkeysecret32bytes', 'utf8').subarray(0, 32);

/**
 * Handles AES-256-GCM encryption/decryption for credentials.
 */
export class EncryptionService {
  private key: Buffer;

  constructor(keyBase64?: string) {
    this.key = keyBase64 ? Buffer.from(keyBase64, 'base64') : DEFAULT_KEY;
  }

  /**
   * Encrypts plain text.
   * @returns String in iv:encryptedHex:authTagHex format.
   */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
  }

  /**
   * Decrypts encrypted text back to original.
   * @param encryptedText The iv:encryptedHex:authTagHex formatted string.
   */
  decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const authTag = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

import fs from 'fs';
import forge from 'node-forge';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

// Initialize pkijs CryptoEngine with Node.js native WebCrypto (Node >= 20)
const webcrypto = crypto.webcrypto as unknown as Crypto;
const pkijsEngine = new pkijs.CryptoEngine({
  name: 'node-webcrypto',
  crypto: webcrypto,
  subtle: webcrypto.subtle
});
pkijs.setEngine('node-webcrypto', webcrypto, pkijsEngine);

export interface ExtractedSignatureDetails {
  iin: string;
  bin: string;
  signedBy: string;
  certSerial: string;
  algorithm?: 'RSA' | 'GOST';
  certIssuer?: string;
  validTo?: Date;
}

export type NCALayerErrorCode =
  | 'INVALID_CMS_STRUCTURE'
  | 'CERT_EXPIRED'
  | 'CERT_NOT_YET_VALID'
  | 'KEY_USAGE_INVALID'
  | 'POLICY_INVALID'
  | 'SIGNATURE_INVALID'
  | 'CHAIN_UNTRUSTED'
  | 'CERT_REVOKED'
  | 'UNSUPPORTED_ALGORITHM'
  | 'REVOCATION_CHECK_FAILED'
  | 'MOCK_ONLY';

export class NCALayerVerificationError extends Error {
  constructor(public code: NCALayerErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'NCALayerVerificationError';
  }
}

// Standard NUC RK OIDs
const OID_NCA_IIN = '1.2.398.3.3.2.1';
const OID_NCA_BIN = '1.2.398.3.3.2.2';
const OID_SERIAL_NUMBER = '2.5.4.5';
const OID_COMMON_NAME = '2.5.4.3';

// Known GOST OID prefixes
const GOST_OID_PREFIXES = ['1.3.6.1.4.1.6801', '1.2.398.3.10', '1.2.643'];

/**
 * Handles parsing and validation of NCALayer digital signatures.
 * Supports both legacy MOCK XML signatures (when NCALAYER_MOCK=true or XML format)
 * and real X.509 PKCS#7 / CMS RSA signatures for NUC RK (НУЦ РК).
 */
export class NCALayerService {
  /**
   * Flag indicating whether NCALayer service is operating in mock mode.
   * Controlled by environment variable NCALAYER_MOCK (defaults to true).
   */
  static get isMock(): boolean {
    return process.env.NCALAYER_MOCK !== 'false';
  }

  static get rootCertRsaPath(): string | undefined {
    return process.env.NCA_ROOT_CERT_RSA_PATH;
  }

  static get ocspUrl(): string | undefined {
    return process.env.NCA_OCSP_URL;
  }

  static get crlUrl(): string | undefined {
    return process.env.NCA_CRL_URL;
  }

  static get revocationTimeoutMs(): number {
    return parseInt(process.env.NCA_REVOCATION_CHECK_TIMEOUT_MS || '5000', 10);
  }

  /**
   * Verifies an NCALayer digital signature.
   * Supports both legacy mock XML (when NCALAYER_MOCK=true) and real PKCS#7 CMS Base64 signatures.
   */
  static async verifySignature(
    signatureInput: string,
    options?: { originalData?: string; now?: Date }
  ): Promise<ExtractedSignatureDetails> {
    if (!signatureInput || typeof signatureInput !== 'string') {
      throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', 'Signature input is empty or invalid.');
    }

    const trimmedInput = signatureInput.trim();

    // 1. Detect legacy mock XML format
    if (trimmedInput.includes('<signedXml') && trimmedInput.includes('</signedXml>')) {
      if (!this.isMock) {
        throw new NCALayerVerificationError(
          'INVALID_CMS_STRUCTURE',
          'Production NCALayer verification requires Base64 CMS/PKCS#7 signature, not legacy mock XML. Set NCALAYER_MOCK=true for mock mode.'
        );
      }
      return this.verifyMockXmlSignature(trimmedInput);
    }

    // If mock mode is active and input is not valid base64 CMS, fallback to mock if applicable
    if (this.isMock && (trimmedInput.startsWith('MOCK_') || trimmedInput.startsWith('SERIAL_'))) {
      return {
        iin: '123456789012',
        bin: '987654321098',
        signedBy: 'Тестовый Подписант (MOCK)',
        certSerial: trimmedInput.substring(0, 32),
        algorithm: 'RSA'
      };
    }

    // 2. Parse Base64 CMS / PKCS#7
    return await this.verifyCmsSignature(trimmedInput, options);
  }

  /**
   * Synchronous legacy XML mock parser (for backward compatibility when NCALAYER_MOCK=true)
   */
  static verifyMockXmlSignature(signedXml: string): ExtractedSignatureDetails {
    console.warn('[NCALayerService] WARNING: Running in MOCK mode. XML signature is not cryptographically verified!');

    const iinMatch = signedXml.match(/iin="([^"]+)"/);
    const binMatch = signedXml.match(/bin="([^"]+)"/);
    const nameMatch = signedXml.match(/name="([^"]+)"/);
    const signMatch = signedXml.match(/<signature[^>]*>([^<]+)<\/signature>/);

    if (!iinMatch || !binMatch || !nameMatch || !signMatch) {
      throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', 'Failed to parse mock XML signature: metadata missing');
    }

    const certContent = signMatch[1];
    let certSerial = '';
    const serialMatch = certContent.match(/SERIAL_([A-Za-z0-9]+)/);
    if (serialMatch) {
      certSerial = serialMatch[1];
    } else {
      certSerial = crypto.createHash('md5').update(certContent).digest('hex').substring(0, 16).toUpperCase();
    }

    return {
      iin: iinMatch[1],
      bin: binMatch[1],
      signedBy: nameMatch[1],
      certSerial,
      algorithm: 'RSA'
    };
  }

  /**
   * Performs 9-step cryptographic verification of Base64 CMS / PKCS#7 SignedData against NUC RK RSA certificates.
   */
  private static async verifyCmsSignature(
    base64Cms: string,
    options?: { originalData?: string; now?: Date }
  ): Promise<ExtractedSignatureDetails> {
    const now = options?.now || new Date();

    // Step 1: Check for GOST algorithm OIDs before PKCS#7 parsing
    if (this.detectGostAlgorithm(base64Cms)) {
      throw new NCALayerVerificationError(
        'UNSUPPORTED_ALGORITHM',
        'GOST 34.310 signature verification is not natively supported in Node.js runtime (Phase 2 Java/Go sidecar required).'
      );
    }

    // Step 2: Decode Base64 DER into ASN.1 PKCS#7
    let p7: forge.pkcs7.PkcsSignedData;
    try {
      const binaryDer = Buffer.from(base64Cms, 'base64').toString('binary');
      const asn1 = forge.asn1.fromDer(binaryDer);
      p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
    } catch (e: any) {
      throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', `Failed to parse CMS PKCS#7 structure: ${e.message}`);
    }

    // Secondary check for GOST inside PKCS#7 structure
    if (this.detectGostAlgorithm(p7)) {
      throw new NCALayerVerificationError(
        'UNSUPPORTED_ALGORITHM',
        'GOST 34.310 signature verification is not natively supported in Node.js runtime (Phase 2 Java/Go sidecar required).'
      );
    }

    // Step 3: Extract Signer Certificate
    if (!p7.certificates || p7.certificates.length === 0) {
      throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', 'CMS structure does not contain signer X.509 certificate.');
    }
    const cert = p7.certificates[0];

    // Step 4: Check Certificate Validity Period
    if (now < cert.validity.notBefore) {
      throw new NCALayerVerificationError('CERT_NOT_YET_VALID', `Certificate is not valid before ${cert.validity.notBefore.toISOString()}`);
    }
    if (now > cert.validity.notAfter) {
      throw new NCALayerVerificationError('CERT_EXPIRED', `Certificate expired on ${cert.validity.notAfter.toISOString()}`);
    }

    // Step 5: Check Key Usage (Digital Signature bit)
    const keyUsageExt = cert.getExtension('keyUsage') as any;
    if (keyUsageExt && keyUsageExt.digitalSignature === false) {
      throw new NCALayerVerificationError('KEY_USAGE_INVALID', 'Certificate keyUsage extension lacks Digital Signature bit.');
    }

    // Step 6: Extract Subject Attributes (IIN, BIN, Name, Serial)
    const { iin, bin, signedBy } = this.extractSubjectAttributes(cert);
    const certSerial = cert.serialNumber || crypto.createHash('sha256').update(cert.publicKey.toString()).digest('hex').substring(0, 16);

    // Step 7: Cryptographic Signature Verification using pkijs WebCrypto
    try {
      const cmsBuffer = Buffer.from(base64Cms, 'base64');
      const cmsArrayBuffer = cmsBuffer.buffer.slice(cmsBuffer.byteOffset, cmsBuffer.byteOffset + cmsBuffer.byteLength);
      const asn1Parsed = asn1js.fromBER(cmsArrayBuffer);
      if (asn1Parsed.offset === -1) {
        throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', 'Failed to parse BER/DER encoding of CMS for cryptographic verification.');
      }
      const contentInfo = new pkijs.ContentInfo({ schema: asn1Parsed.result });
      if (contentInfo.contentType !== '1.2.840.113549.1.7.2') {
        throw new NCALayerVerificationError('INVALID_CMS_STRUCTURE', `CMS ContentInfo contentType is not SignedData (got: ${contentInfo.contentType}).`);
      }
      const signedData = new pkijs.SignedData({ schema: contentInfo.content });
      const verifyResult = await signedData.verify({
        signer: 0,
        checkChain: false
      });
      if (!verifyResult) {
        throw new NCALayerVerificationError(
          'SIGNATURE_INVALID',
          'CMS signature cryptographic integrity check failed: signature does not match content or signer public key.'
        );
      }
    } catch (err: any) {
      if (err instanceof NCALayerVerificationError) throw err;
      throw new NCALayerVerificationError(
        'SIGNATURE_INVALID',
        `Cryptographic signature verification failed: ${err.message}`
      );
    }

    // Step 8: Certificate Chain Verification against NUC RK Root CA
    await this.verifyTrustChain(cert);

    // Step 9: Revocation Status Check (OCSP / CRL)
    await this.checkRevocationStatus(cert);

    return {
      iin,
      bin,
      signedBy,
      certSerial,
      algorithm: 'RSA',
      certIssuer: this.extractCn(cert.issuer.attributes),
      validTo: cert.validity.notAfter
    };
  }

  /**
   * Helper to detect GOST OIDs in PKCS#7 signature parameters or certificates.
   */
  private static detectGostAlgorithm(input: any): boolean {
    if (!input) return false;
    let str = typeof input === 'string' ? input : '';
    if (typeof input !== 'string') {
      try {
        str = JSON.stringify(input);
      } catch {
        str = String(input);
      }
    }
    if (GOST_OID_PREFIXES.some((prefix) => str.includes(prefix))) {
      return true;
    }
    // Inspect ASN.1 DER structure for GOST OIDs
    try {
      const der = typeof input === 'string' ? forge.util.decode64(input) : input;
      const asn1 = forge.asn1.fromDer(typeof der === 'string' ? forge.util.createBuffer(der, 'raw') : der);
      if (this.hasGostOidInAsn1(asn1)) return true;
    } catch {
      // Ignore ASN.1 parse errors
    }
    return false;
  }

  private static hasGostOidInAsn1(node: forge.asn1.Asn1): boolean {
    if (!node) return false;
    if (node.type === forge.asn1.Type.OID && typeof node.value === 'string') {
      try {
        const oidStr = forge.asn1.derToOid(node.value);
        if (GOST_OID_PREFIXES.some((prefix) => oidStr.startsWith(prefix))) {
          return true;
        }
      } catch {
        // Not a valid OID byte sequence
      }
    }
    if (Array.isArray(node.value)) {
      for (const child of node.value) {
        if (typeof child === 'object' && this.hasGostOidInAsn1(child as forge.asn1.Asn1)) {
          return true;
        }
      }
    }
    return false;
  }

  private static decodeUtf8Str(val: string): string {
    if (!val) return '';
    try {
      return forge.util.decodeUtf8(val);
    } catch {
      return val;
    }
  }

  /**
   * Helper to extract IIN, BIN, and Name from NUC RK X.509 Certificate Subject Attributes.
   */
  private static extractSubjectAttributes(cert: forge.pki.Certificate): { iin: string; bin: string; signedBy: string } {
    let iin = '';
    let bin = '';
    let signedBy = '';

    for (const attr of cert.subject.attributes) {
      const oid = attr.type || (attr as any).oid;
      const value = this.decodeUtf8Str(String(attr.value || ''));

      if (oid === OID_NCA_IIN || oid === OID_SERIAL_NUMBER) {
        const iinMatch = value.match(/IIN(\d{12})/i) || value.match(/^(\d{12})$/);
        if (iinMatch) iin = iinMatch[1];
      }
      if (oid === OID_NCA_BIN) {
        const binMatch = value.match(/BIN(\d{12})/i) || value.match(/^(\d{12})$/);
        if (binMatch) bin = binMatch[1];
      }
      if (oid === OID_COMMON_NAME && !signedBy) {
        signedBy = value;
      }
    }

    // Fallback parsing from Subject String if OIDs were not explicitly keyed
    const subjectStr = cert.subject.attributes.map((a) => `${a.name || a.type}=${this.decodeUtf8Str(String(a.value || ''))}`).join(', ');
    if (!iin) {
      const iinMatch = subjectStr.match(/IIN=?(\d{12})/i) || subjectStr.match(/SERIALNUMBER=?(\d{12})/i);
      if (iinMatch) iin = iinMatch[1];
    }
    if (!bin) {
      const binMatch = subjectStr.match(/BIN=?(\d{12})/i) || subjectStr.match(/OU=?BIN(\d{12})/i);
      if (binMatch) bin = binMatch[1];
    }
    if (!signedBy) {
      const cnMatch = subjectStr.match(/CN=([^,]+)/i);
      if (cnMatch) signedBy = cnMatch[1];
    }

    return {
      iin: iin || '000000000000',
      bin: bin || '000000000000',
      signedBy: signedBy || 'Подписант НУЦ РК'
    };
  }

  private static extractCn(attributes: forge.pki.CertificateField[]): string {
    const cnAttr = attributes.find((a) => a.type === OID_COMMON_NAME || a.name === 'commonName');
    return this.decodeUtf8Str(String(cnAttr?.value || 'НУЦ РК (NCA RK)'));
  }

  /**
   * Verifies certificate chain against NUC RK Root CA certificate.
   * Fail-closed: in production mode, missing configuration is an error.
   */
  private static async verifyTrustChain(cert: forge.pki.Certificate): Promise<void> {
    if (!this.rootCertRsaPath || !fs.existsSync(this.rootCertRsaPath)) {
      if (!this.isMock) {
        throw new NCALayerVerificationError(
          'CHAIN_UNTRUSTED',
          'NCA_ROOT_CERT_RSA_PATH is not configured or file not found — cannot verify certificate trust chain in production mode.'
        );
      }
      return; // mock mode: skip trust chain verification
    }

    try {
      const caPem = fs.readFileSync(this.rootCertRsaPath, 'utf8');
      const caCert = forge.pki.certificateFromPem(caPem);
      const caStore = forge.pki.createCaStore([caCert]);
      const verified = forge.pki.verifyCertificateChain(caStore, [cert]);
      if (!verified) {
        throw new NCALayerVerificationError('CHAIN_UNTRUSTED', 'Certificate trust chain verification failed against NUC RK Root CA.');
      }
    } catch (e: any) {
      if (e instanceof NCALayerVerificationError) throw e;
      throw new NCALayerVerificationError('CHAIN_UNTRUSTED', `Failed to verify trust chain against CA: ${e.message}`);
    }
  }

  /**
   * Revocation check via OCSP/CRL (Fail-closed policy).
   * In production mode, missing OCSP/CRL configuration is an error.
   */
  private static async checkRevocationStatus(cert: forge.pki.Certificate): Promise<void> {
    if (!this.ocspUrl && !this.crlUrl) {
      if (!this.isMock) {
        throw new NCALayerVerificationError(
          'REVOCATION_CHECK_FAILED',
          'NCA_OCSP_URL and NCA_CRL_URL are not configured — cannot verify certificate revocation status in production mode.'
        );
      }
      return; // mock mode: skip revocation check
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.revocationTimeoutMs);

    try {
      const targetUrl = this.ocspUrl || this.crlUrl!;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/ocsp-request' },
        body: cert.serialNumber,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new NCALayerVerificationError('REVOCATION_CHECK_FAILED', `OCSP/CRL service returned HTTP status ${response.status}`);
      }

      const text = await response.text();
      if (text.includes('REVOKED')) {
        throw new NCALayerVerificationError('CERT_REVOKED', 'Signer certificate has been REVOKED according to NUC RK OCSP/CRL service.');
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err instanceof NCALayerVerificationError) throw err;
      throw new NCALayerVerificationError(
        'REVOCATION_CHECK_FAILED',
        `Revocation check failed (fail-closed policy): ${err.name === 'AbortError' ? 'OCSP service request timed out' : err.message}`
      );
    }
  }
}

export interface EsfPartyInfo {
  bin: string;
  name: string;
  address?: string;
}

export interface EsfItemInfo {
  sku: string;
  name: string;
  quantity: number;
  price: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
}

export interface EsfDocumentData {
  documentType: 'WAYBILL' | 'SERVICE_ACT' | 'INVOICE' | 'CREDIT_NOTE';
  documentId: string;
  documentNumber: string;
  turnoverDate: string; // YYYY-MM-DD
  supplier: EsfPartyInfo;
  customer: EsfPartyInfo;
  items: EsfItemInfo[];
  totalAmount: number;
  totalVatAmount: number;
}

/**
 * Handles generation of XML structures for Kazakhstani IS ESF system.
 */
export class EsfXmlGenerator {
  /**
   * Generates a standard ESF XML representation.
   */
  static generateXml(data: EsfDocumentData): string {
    const itemsXml = data.items
      .map(
        (item) => `
      <product>
        <sku>${item.sku}</sku>
        <description>${item.name}</description>
        <quantity>${item.quantity.toFixed(3)}</quantity>
        <unitPrice>${item.price.toFixed(2)}</unitPrice>
        <vatRate>${item.vatRate.toFixed(2)}</vatRate>
        <vatAmount>${item.vatAmount.toFixed(2)}</vatAmount>
        <totalAmount>${item.totalAmount.toFixed(2)}</totalAmount>
      </product>`
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<esf:esfDocument xmlns:esf="v1.esf.kgd.minfin.gov.kz">
  <header>
    <num>${data.documentNumber}</num>
    <documentId>${data.documentId}</documentId>
    <documentType>${data.documentType}</documentType>
    <turnoverDate>${data.turnoverDate}</turnoverDate>
  </header>
  <sellers>
    <seller>
      <bin>${data.supplier.bin}</bin>
      <name>${data.supplier.name}</name>
      <address>${data.supplier.address || ''}</address>
    </seller>
  </sellers>
  <buyers>
    <buyer>
      <bin>${data.customer.bin}</bin>
      <name>${data.customer.name}</name>
      <address>${data.customer.address || ''}</address>
    </buyer>
  </buyers>
  <productSet>
    <products>${itemsXml}
    </products>
    <totalValue>${data.totalAmount.toFixed(2)}</totalValue>
    <totalVat>${data.totalVatAmount.toFixed(2)}</totalVat>
  </productSet>
</esf:esfDocument>`;
  }
}

export interface EsfSubmissionResult {
  success: boolean;
  esfRegNumber?: string;
  responseXml: string;
  errorMessage?: string;
  isRetryable?: boolean;
}

export interface EsfStatusCheckResult {
  status: 'REGISTERED' | 'REJECTED' | 'SUBMITTED';
  esfRegNumber?: string;
  responseXml: string;
  errorMessage?: string;
}

/**
 * SOAP Client interface for interacting with IS ESF (KGD MF RK).
 * Supports Mock mode for development/testing and production WSDL mode.
 */
export class EsfSoapClient {
  private isMock: boolean;

  constructor(isMock: boolean = true) {
    this.isMock = isMock;
  }

  /**
   * Submits signed ESF XML to IS ESF system.
   */
  async submitEsf(signedXml: string): Promise<EsfSubmissionResult> {
    if (this.isMock) {
      // Simulate IS ESF processing
      const randomSuffix = Math.floor(10000000 + Math.random() * 90000000);
      const esfRegNumber = `ESF-${new Date().getFullYear()}-${randomSuffix}`;
      const responseXml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><submitResponse><status>SUCCESS</status><esfRegistrationNumber>${esfRegNumber}</esfRegistrationNumber></submitResponse></soap:Body></soap:Envelope>`;

      return {
        success: true,
        esfRegNumber,
        responseXml
      };
    }

    throw new Error('Production KGD SOAP endpoint not configured. Set IS_ESF_MOCK=true.');
  }

  /**
   * Checks status of submitted ESF in IS ESF.
   */
  async checkStatus(esfRegNumberOrDocId: string): Promise<EsfStatusCheckResult> {
    if (this.isMock) {
      const esfRegNumber = esfRegNumberOrDocId.startsWith('ESF-')
        ? esfRegNumberOrDocId
        : `ESF-${new Date().getFullYear()}-${Math.floor(10000000 + Math.random() * 90000000)}`;

      return {
        status: 'REGISTERED',
        esfRegNumber,
        responseXml: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><statusResponse><status>REGISTERED</status><esfRegistrationNumber>${esfRegNumber}</esfRegistrationNumber></statusResponse></soap:Body></soap:Envelope>`
      };
    }

    throw new Error('Production KGD SOAP endpoint not configured.');
  }
}

