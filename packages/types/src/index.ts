// User roles available in Senim suite
export type UserRole = 
  | 'CRM_MANAGER' 
  | 'CRM_LEAD'
  | 'ERP_ACCOUNTANT' 
  | 'ERP_WAREHOUSE_MANAGER' 
  | 'ERP_PURCHASER' 
  | 'ERP_CEO';

// Shared Tenant Structure
export interface Tenant {
  id: string;
  name: string;
  bin: string; // Business Identification Number
  createdAt: string;
}

// SSO User representation
export interface SsoUser {
  id: string;
  email: string;
  tenantId: string;
  roles: UserRole[];
}

// JWT SSO Payload structure
export interface SsoJwtPayload {
  sub: string; // User ID
  email: string;
  tenantId: string;
  roles: UserRole[];
  iat?: number;
  exp?: number;
}

// Integration Event Header Structure
export interface IntegrationEvent<T = any> {
  eventId: string;          // Unique Event UUID for idempotency / deduplication
  eventType: string;        // Event topic / type, e.g. "deal.won"
  tenantId: string;         // Target Tenant ID
  timestamp: string;        // ISO string timestamp
  payload: T;
}

// Deal Won Event Payload (CRM -> ERP)
export interface DealWonLineItem {
  sku: string;
  crmProductId: string;
  name: string;
  quantity: number;
  price: number;       // Price excluding VAT
  vatRate?: number;    // e.g. 12.00 (optional, default will be 12%)
}

export interface DealWonPayload {
  dealId: string;
  customerId: string;
  customerName: string;
  customerBin: string; // Client's BIN or IIN
  customerAddress?: string;
  customerEmail?: string;
  customerPhone?: string;
  amount: number;
  items: DealWonLineItem[];
}

// Client Created / Updated Event Payload (CRM -> ERP)
export interface ClientSyncedPayload {
  customerId: string;
  name: string;
  bin: string;
  address?: string;
  email?: string;
  phone?: string;
}

// Invoice Paid Event Payload (ERP -> CRM)
export interface InvoicePaidPayload {
  dealId: string;
  paymentStatus: 'paid' | 'partially_paid';
  erpDocumentId: string;
  invoiceId: string;
  amountPaid: number;
  totalAmount: number;
}

// Stock Level Changed Event Payload (ERP -> CRM)
export interface StockLevelChangedPayload {
  sku: string;
  quantity: number;
  reserved?: number;
}

// Shipment Completed Event Payload (ERP -> CRM)
export interface ShipmentCompletedPayload {
  waybillId: string;
  dealId?: string;
  customerId: string;
  fulfillmentStatus: 'delivered';
  deliveredAt: string;
}
