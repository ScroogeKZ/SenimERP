export interface SignatureDocumentInput {
  id: string;
  number?: string;
  documentNumber?: string;
  customer?: { bin?: string } | null;
  customerBin?: string;
  amount?: any;
  totalAmount?: any;
  vatAmount?: any;
  totalVatAmount?: any;
  updatedAt: Date | string;
}

/**
 * Builds a deterministic canonical payload string for ERP document CMS signatures:
 * {documentType}|{id}|{documentNumber}|{customerBin}|{supplierBin}|{totalAmount}|{totalVatAmount}|{updatedAt.toISOString()}
 */
export function buildSignaturePayload(
  documentType: string,
  doc: SignatureDocumentInput,
  supplierBin: string = '000000000000'
): string {
  const id = doc.id;
  const docNum = doc.number ?? doc.documentNumber ?? '';
  const custBin = doc.customer?.bin ?? doc.customerBin ?? '';
  const suppBin = supplierBin;
  const amount = doc.amount !== undefined && doc.amount !== null
    ? String(doc.amount)
    : (doc.totalAmount !== undefined && doc.totalAmount !== null ? String(doc.totalAmount) : '0');
  const vatAmount = doc.vatAmount !== undefined && doc.vatAmount !== null
    ? String(doc.vatAmount)
    : (doc.totalVatAmount !== undefined && doc.totalVatAmount !== null ? String(doc.totalVatAmount) : '0');
  const updatedAtIso = doc.updatedAt instanceof Date
    ? doc.updatedAt.toISOString()
    : new Date(doc.updatedAt).toISOString();

  return `${documentType}|${id}|${docNum}|${custBin}|${suppBin}|${amount}|${vatAmount}|${updatedAtIso}`;
}
