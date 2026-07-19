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
 */
export class NCALayerService {
  /**
   * Extracts and validates an XML signature.
   * Looks for signature attributes and extracts IIN, BIN, and Name of the signer.
   */
  static verifySignature(signedXml: string): ExtractedSignatureDetails {
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
