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

export interface ExtractedSignatureDetails {
  iin: string;
  bin: string;
  signedBy: string;
  certSerial: string;
}

/**
 * Handles parsing and validation of NCALayer digital signatures.
 * NOTE: Currently runs in MOCK mode. Production X.509 PKCS#7 cryptographic verification
 * against NCA RK (НУЦ РК) root certificates is not yet configured.
 */
export class NCALayerService {
  /**
   * Flag indicating whether NCALayer service is operating in mock mode.
   * Controlled by environment variable NCALAYER_MOCK (defaults to true).
   */
  static readonly isMock: boolean = process.env.NCALAYER_MOCK !== 'false';

  /**
   * Extracts and validates an XML signature.
   * In mock mode: parses XML wrappers and regex metadata (IIN, BIN, Name, Cert Serial).
   * In production mode (NCALAYER_MOCK=false): throws an error as production KGD/NCA verification is not configured.
   */
  static verifySignature(signedXml: string): ExtractedSignatureDetails {
    if (!this.isMock) {
      throw new Error('Production NCALayer cryptographic verification endpoint not configured. Set NCALAYER_MOCK=true.');
    }

    console.warn('[NCALayerService] WARNING: Running in MOCK mode. XML signature is not cryptographically verified!');

    if (!signedXml.includes('<signedXml>') || !signedXml.includes('</signedXml>')) {
      throw new Error('Invalid signature structure: signedXml wrappers missing');
    }

    const iinMatch = signedXml.match(/iin="([^"]+)"/);
    const binMatch = signedXml.match(/bin="([^"]+)"/);
    const nameMatch = signedXml.match(/name="([^"]+)"/);
    const signMatch = signedXml.match(/<signature[^>]*>([^<]+)<\/signature>/);

    if (!iinMatch || !binMatch || !nameMatch || !signMatch) {
      throw new Error('Failed to verify NCALayer XML signature: invalid metadata or signature block');
    }

    const certContent = signMatch[1];
    let certSerial = '';
    const serialMatch = certContent.match(/SERIAL_([A-Za-z0-9]+)/);
    if (serialMatch) {
      certSerial = serialMatch[1];
    } else {
      // Generate a reproducible mock serial from signature content
      certSerial = crypto.createHash('md5').update(certContent).digest('hex').substring(0, 16).toUpperCase();
    }

    return {
      iin: iinMatch[1],
      bin: binMatch[1],
      signedBy: nameMatch[1],
      certSerial
    };
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

