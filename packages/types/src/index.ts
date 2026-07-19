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
  id: string;          // Unique Event UUID for idempotency / deduplication
  type: string;        // Event topic / type, e.g. "deal.won"
  version: string;     // Schema version, e.g. "1.0.0"
  tenantId: string;    // Target Tenant ID
  timestamp: string;   // ISO string timestamp
  payload: T;
}

// Deal Won Event Payload (CRM -> ERP)
export interface DealWonLineItem {
  sku: string;
  crmProductId: string;
  name: string;
  quantity: number;
  price: number;       // Price excluding VAT
  vatRate: number;     // e.g. 12.00
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
  invoiceId: string;
  crmDealId?: string; // If invoice originated from a CRM deal
  amountPaid: number;
  totalAmount: number;
  status: 'PAID' | 'PARTIALLY_PAID';
}

// Stock Level Changed Event Payload (ERP -> CRM or CRM -> ERP)
export interface StockLevelChangedPayload {
  sku: string;
  crmProductId: string;
  warehouseId: string;
  oldAvailable: number;
  newAvailable: number;
  isCritical: boolean; // Flag if below threshold
}

// Shipment Completed Event Payload (ERP -> CRM)
export interface ShipmentCompletedPayload {
  waybillId: string;
  crmDealId?: string;
  customerId: string;
  status: 'DELIVERED';
  deliveredAt: string;
}
