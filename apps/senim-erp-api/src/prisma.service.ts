import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
  private clients = new Map<string, PrismaClient>();
  private ensuredSchemas = new Set<string>();
  private provisioningPromises = new Map<string, Promise<void>>();

  /**
   * Enforces strict alphanumeric format with dashes and underscores to prevent SQL injection in DDL queries.
   */
  private assertValidTenantId(tenantId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(tenantId)) {
      throw new Error(`Invalid tenantId format: ${tenantId}`);
    }
  }

  /**
   * Retrieves or creates a PrismaClient instance isolated to the tenant's specific schema.
   */
  getClient(tenantId: string): PrismaClient {
    this.assertValidTenantId(tenantId);
    const schema = `tenant_${tenantId}`;
    if (!this.clients.has(schema)) {
      const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
      // Append schema name as query parameter for schema-per-tenant routing
      const connectionUrl = `${baseDbUrl}?schema=${schema}`;

      const client = new PrismaClient({
        datasources: {
          db: {
            url: connectionUrl,
          },
        },
      });

      this.clients.set(schema, client);
    }
    return this.clients.get(schema)!;
  }

  /**
   * High-level method to guarantee tenant schema initialization and return the tenant PrismaClient.
   */
  async getTenantClient(tenantId: string): Promise<PrismaClient> {
    await this.ensureTenantSchema(tenantId);
    return this.getClient(tenantId);
  }

  /**
   * Ensures that a tenant's database schema and all associated tables are fully initialized.
   * Runs raw SQL DDL directly against the database to construct isolated tables dynamically.
   */
  async ensureTenantSchema(tenantId: string): Promise<void> {
    this.assertValidTenantId(tenantId);
    const schema = `tenant_${tenantId}`;

    if (this.ensuredSchemas.has(schema)) {
      return;
    }

    if (this.provisioningPromises.has(schema)) {
      await this.provisioningPromises.get(schema);
      return;
    }

    const provisioningTask = (async () => {
      const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
      const baseClient = new PrismaClient({
        datasources: {
          db: {
            url: `${baseDbUrl}?schema=public`
          }
        }
      });

      try {
        await baseClient.$transaction(
          async (tx) => {
            // Transactional Advisory Lock for cross-instance / multi-node concurrency protection
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${schema}'));`);

            // 1. Create target schema
            await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);

            // 2. Create custom enum types safely using PL/pgSQL checks
            await tx.$executeRawUnsafe(`
              DO $$
              BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'InvoiceStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'WaybillStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."WaybillStatus" AS ENUM ('DRAFT', 'ISSUED', 'DELIVERED', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'ActStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."ActStatus" AS ENUM ('DRAFT', 'ISSUED', 'SIGNED_BY_CUSTOMER', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'PurchaseOrderStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'SupplierInvoiceStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."SupplierInvoiceStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'EsfStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."EsfStatus" AS ENUM ('PENDING', 'SUBMITTED', 'REGISTERED', 'REJECTED', 'FAILED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'RmaStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."RmaStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'CreditNoteStatus' AND n.nspname = '${schema}') THEN
                  CREATE TYPE "${schema}"."CreditNoteStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');
                END IF;
              END$$;
            `);

            // 3. Create tables inside the tenant schema
            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Warehouse" (
                "id" TEXT PRIMARY KEY,
                "name" TEXT NOT NULL,
                "code" TEXT UNIQUE NOT NULL,
                "isDefault" BOOLEAN NOT NULL DEFAULT false,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              INSERT INTO "${schema}"."Warehouse" ("id", "name", "code", "isDefault")
              VALUES ('default-main-warehouse', 'Основной склад', 'MAIN', true)
              ON CONFLICT ("code") DO NOTHING;
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Customer" (
                "id" TEXT PRIMARY KEY,
                "crmId" TEXT UNIQUE,
                "name" TEXT NOT NULL,
                "bin" TEXT UNIQUE NOT NULL,
                "address" TEXT,
                "email" TEXT,
                "phone" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Invoice" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "customerId" TEXT NOT NULL REFERENCES "${schema}"."Customer"("id") ON DELETE CASCADE,
                "amount" DECIMAL(15, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "paidAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
                "status" TEXT NOT NULL DEFAULT 'DRAFT',
                "issueDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "dueDate" TIMESTAMP NOT NULL,
                "signedXml" TEXT,
                "crmDealId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."InvoiceLineItem" (
                "id" TEXT PRIMARY KEY,
                "invoiceId" TEXT NOT NULL REFERENCES "${schema}"."Invoice"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "crmProductId" TEXT,
                "name" TEXT NOT NULL,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "price" DECIMAL(15, 2) NOT NULL,
                "originalPrice" DECIMAL(15, 2),
                "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
                "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
                "dealCurrency" TEXT,
                "dealCurrencyPrice" DECIMAL(15, 4),
                "exchangeRate" DECIMAL(12, 6),
                "exchangeRateDate" TIMESTAMP,
                "vatRate" DECIMAL(5, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "totalAmount" DECIMAL(15, 2) NOT NULL
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."InvoicePayment" (
                "id" TEXT PRIMARY KEY,
                "invoiceId" TEXT NOT NULL REFERENCES "${schema}"."Invoice"("id") ON DELETE CASCADE,
                "amount" DECIMAL(15, 2) NOT NULL,
                "paidAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "method" TEXT,
                "referenceId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Waybill" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "customerId" TEXT NOT NULL REFERENCES "${schema}"."Customer"("id") ON DELETE CASCADE,
                "warehouseId" TEXT REFERENCES "${schema}"."Warehouse"("id") ON DELETE SET NULL,
                "amount" DECIMAL(15, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'DRAFT',
                "issueDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "signedXml" TEXT,
                "crmDealId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."WaybillLineItem" (
                "id" TEXT PRIMARY KEY,
                "waybillId" TEXT NOT NULL REFERENCES "${schema}"."Waybill"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "crmProductId" TEXT,
                "name" TEXT NOT NULL,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "price" DECIMAL(15, 2) NOT NULL,
                "originalPrice" DECIMAL(15, 2),
                "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
                "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
                "dealCurrency" TEXT,
                "dealCurrencyPrice" DECIMAL(15, 4),
                "exchangeRate" DECIMAL(12, 6),
                "exchangeRateDate" TIMESTAMP,
                "vatRate" DECIMAL(5, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "totalAmount" DECIMAL(15, 2) NOT NULL
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."ServiceAct" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "customerId" TEXT NOT NULL REFERENCES "${schema}"."Customer"("id") ON DELETE CASCADE,
                "amount" DECIMAL(15, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "status" TEXT NOT NULL DEFAULT 'DRAFT',
                "issueDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "signedXml" TEXT,
                "crmDealId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."ActLineItem" (
                "id" TEXT PRIMARY KEY,
                "actId" TEXT NOT NULL REFERENCES "${schema}"."ServiceAct"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "crmProductId" TEXT,
                "name" TEXT NOT NULL,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "price" DECIMAL(15, 2) NOT NULL,
                "originalPrice" DECIMAL(15, 2),
                "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
                "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
                "dealCurrency" TEXT,
                "dealCurrencyPrice" DECIMAL(15, 4),
                "exchangeRate" DECIMAL(12, 6),
                "exchangeRateDate" TIMESTAMP,
                "vatRate" DECIMAL(5, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "totalAmount" DECIMAL(15, 2) NOT NULL
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."DocumentSignature" (
                "id" TEXT PRIMARY KEY,
                "invoiceId" TEXT UNIQUE REFERENCES "${schema}"."Invoice"("id") ON DELETE SET NULL,
                "waybillId" TEXT UNIQUE REFERENCES "${schema}"."Waybill"("id") ON DELETE SET NULL,
                "actId" TEXT UNIQUE REFERENCES "${schema}"."ServiceAct"("id") ON DELETE SET NULL,
                "signedBy" TEXT NOT NULL,
                "iin" TEXT NOT NULL,
                "certSerial" TEXT NOT NULL,
                "signedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."EsfDocument" (
                "id" TEXT PRIMARY KEY,
                "invoiceId" TEXT UNIQUE REFERENCES "${schema}"."Invoice"("id") ON DELETE SET NULL,
                "waybillId" TEXT UNIQUE REFERENCES "${schema}"."Waybill"("id") ON DELETE SET NULL,
                "actId" TEXT UNIQUE REFERENCES "${schema}"."ServiceAct"("id") ON DELETE SET NULL,
                "status" TEXT NOT NULL DEFAULT 'PENDING',
                "esfRegNumber" TEXT,
                "requestXml" TEXT,
                "responseXml" TEXT,
                "errorMessage" TEXT,
                "submittedAt" TIMESTAMP,
                "confirmedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Supplier" (
                "id" TEXT PRIMARY KEY,
                "name" TEXT NOT NULL,
                "bin" TEXT UNIQUE,
                "address" TEXT,
                "email" TEXT,
                "phone" TEXT,
                "bankAccount" TEXT,
                "bankBik" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."PurchaseOrder" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "supplierId" TEXT NOT NULL REFERENCES "${schema}"."Supplier"("id") ON DELETE CASCADE,
                "warehouseId" TEXT REFERENCES "${schema}"."Warehouse"("id") ON DELETE SET NULL,
                "status" TEXT NOT NULL DEFAULT 'DRAFT',
                "expectedDate" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."PurchaseOrderItem" (
                "id" TEXT PRIMARY KEY,
                "purchaseOrderId" TEXT NOT NULL REFERENCES "${schema}"."PurchaseOrder"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "crmProductId" TEXT,
                "name" TEXT NOT NULL,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "receivedQty" DECIMAL(12, 3) NOT NULL DEFAULT 0,
                "price" DECIMAL(15, 2) NOT NULL
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."SupplierInvoice" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "supplierId" TEXT NOT NULL REFERENCES "${schema}"."Supplier"("id") ON DELETE CASCADE,
                "purchaseOrderId" TEXT REFERENCES "${schema}"."PurchaseOrder"("id") ON DELETE SET NULL,
                "amount" DECIMAL(15, 2) NOT NULL,
                "paidAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
                "status" TEXT NOT NULL DEFAULT 'UNPAID',
                "issueDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "dueDate" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."SupplierPayment" (
                "id" TEXT PRIMARY KEY,
                "supplierInvoiceId" TEXT NOT NULL REFERENCES "${schema}"."SupplierInvoice"("id") ON DELETE CASCADE,
                "amount" DECIMAL(15, 2) NOT NULL,
                "paidAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "method" TEXT,
                "referenceId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."StockItem" (
                "id" TEXT PRIMARY KEY,
                "sku" TEXT NOT NULL,
                "warehouseId" TEXT NOT NULL REFERENCES "${schema}"."Warehouse"("id") ON DELETE CASCADE,
                "crmProductId" TEXT,
                "quantity" DECIMAL(12, 3) NOT NULL DEFAULT 0,
                "reserved" DECIMAL(12, 3) NOT NULL DEFAULT 0,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "StockItem_sku_warehouseId_key" UNIQUE ("sku", "warehouseId")
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."StockMovement" (
                "id" TEXT PRIMARY KEY,
                "sku" TEXT NOT NULL,
                "warehouseId" TEXT NOT NULL REFERENCES "${schema}"."Warehouse"("id") ON DELETE CASCADE,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "type" TEXT NOT NULL,
                "referenceId" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE INDEX IF NOT EXISTS "idx_${schema}_stockmovement_sku" ON "${schema}"."StockMovement" ("sku");
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."ProcessedEvent" (
                "id" TEXT PRIMARY KEY,
                "eventType" TEXT NOT NULL,
                "processedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."TenantProfile" (
                "id" TEXT PRIMARY KEY DEFAULT 'tenant_profile',
                "companyName" TEXT NOT NULL,
                "companyBin" TEXT NOT NULL,
                "legalAddress" TEXT,
                "directorName" TEXT,
                "directorIin" TEXT,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              INSERT INTO "${schema}"."TenantProfile" ("id", "companyName", "companyBin")
              VALUES ('tenant_profile', '${tenantId}', '000000000000')
              ON CONFLICT ("id") DO NOTHING;
            `);

            // 4. Create sequences for monotonic document numbering
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."invoice_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."waybill_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."act_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."po_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."supplier_invoice_number_seq";`);

            // 5. Run migrations for legacy tenant schemas
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
            `);
            await tx.$executeRawUnsafe(`
              UPDATE "${schema}"."StockItem"
              SET "warehouseId" = (SELECT "id" FROM "${schema}"."Warehouse" WHERE "isDefault" = true LIMIT 1)
              WHERE "warehouseId" IS NULL;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" ALTER COLUMN "warehouseId" SET NOT NULL;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" DROP CONSTRAINT IF EXISTS "StockItem_sku_key";
            `);
            await tx.$executeRawUnsafe(`
              DROP INDEX IF EXISTS "${schema}"."StockItem_sku_key";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" DROP CONSTRAINT IF EXISTS "StockItem_sku_warehouseId_key";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" ADD CONSTRAINT "StockItem_sku_warehouseId_key" UNIQUE ("sku", "warehouseId");
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" DROP CONSTRAINT IF EXISTS "StockItem_warehouseId_fkey";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockItem" ADD CONSTRAINT "StockItem_warehouseId_fkey"
                FOREIGN KEY ("warehouseId") REFERENCES "${schema}"."Warehouse"("id") ON DELETE CASCADE;
            `);

            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockMovement" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
            `);
            await tx.$executeRawUnsafe(`
              UPDATE "${schema}"."StockMovement"
              SET "warehouseId" = (SELECT "id" FROM "${schema}"."Warehouse" WHERE "isDefault" = true LIMIT 1)
              WHERE "warehouseId" IS NULL;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockMovement" ALTER COLUMN "warehouseId" SET NOT NULL;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_warehouseId_fkey";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey"
                FOREIGN KEY ("warehouseId") REFERENCES "${schema}"."Warehouse"("id") ON DELETE CASCADE;
            `);

            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."Waybill" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."Waybill" DROP CONSTRAINT IF EXISTS "Waybill_warehouseId_fkey";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."Waybill" ADD CONSTRAINT "Waybill_warehouseId_fkey"
                FOREIGN KEY ("warehouseId") REFERENCES "${schema}"."Warehouse"("id") ON DELETE SET NULL;
            `);

            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_warehouseId_fkey";
            `);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_warehouseId_fkey"
                FOREIGN KEY ("warehouseId") REFERENCES "${schema}"."Warehouse"("id") ON DELETE SET NULL;
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."Rma" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "waybillId" TEXT NOT NULL REFERENCES "${schema}"."Waybill"("id") ON DELETE CASCADE,
                "status" TEXT NOT NULL DEFAULT 'DRAFT',
                "reason" TEXT,
                "confirmedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."RmaLine" (
                "id" TEXT PRIMARY KEY,
                "rmaId" TEXT NOT NULL REFERENCES "${schema}"."Rma"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "warehouseId" TEXT NOT NULL REFERENCES "${schema}"."Warehouse"("id") ON DELETE CASCADE,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "price" DECIMAL(15, 2),
                "vatRate" DECIMAL(5, 2),
                "vatAmount" DECIMAL(15, 2),
                "totalAmount" DECIMAL(15, 2)
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE SEQUENCE IF NOT EXISTS "${schema}"."rma_number_seq" START WITH 1 INCREMENT BY 1;
            `);

            await tx.$executeRawUnsafe(`
              CREATE SEQUENCE IF NOT EXISTS "${schema}"."credit_note_number_seq" START WITH 1 INCREMENT BY 1;
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."CreditNote" (
                "id" TEXT PRIMARY KEY,
                "number" TEXT UNIQUE NOT NULL,
                "rmaId" TEXT UNIQUE NOT NULL REFERENCES "${schema}"."Rma"("id") ON DELETE RESTRICT,
                "invoiceId" TEXT REFERENCES "${schema}"."Invoice"("id") ON DELETE SET NULL,
                "customerId" TEXT NOT NULL REFERENCES "${schema}"."Customer"("id") ON DELETE RESTRICT,
                "amount" DECIMAL(15, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "status" "${schema}"."CreditNoteStatus" NOT NULL DEFAULT 'DRAFT',
                "issueDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "signedXml" TEXT,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."CreditNoteLineItem" (
                "id" TEXT PRIMARY KEY,
                "creditNoteId" TEXT NOT NULL REFERENCES "${schema}"."CreditNote"("id") ON DELETE CASCADE,
                "sku" TEXT NOT NULL,
                "crmProductId" TEXT,
                "name" TEXT NOT NULL,
                "quantity" DECIMAL(12, 3) NOT NULL,
                "price" DECIMAL(15, 2) NOT NULL,
                "vatRate" DECIMAL(5, 2) NOT NULL,
                "vatAmount" DECIMAL(15, 2) NOT NULL,
                "totalAmount" DECIMAL(15, 2) NOT NULL
              );
            `);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ADD COLUMN IF NOT EXISTS "price" DECIMAL(15, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ADD COLUMN IF NOT EXISTS "vatAmount" DECIMAL(15, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ADD COLUMN IF NOT EXISTS "totalAmount" DECIMAL(15, 2);`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "price" DROP NOT NULL;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "price" DROP DEFAULT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "vatRate" DROP NOT NULL;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "vatRate" DROP DEFAULT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "vatAmount" DROP NOT NULL;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "vatAmount" DROP DEFAULT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "totalAmount" DROP NOT NULL;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."RmaLine" ALTER COLUMN "totalAmount" DROP DEFAULT;`);

            await tx.$executeRawUnsafe(`
              UPDATE "${schema}"."RmaLine"
              SET "price" = NULL, "vatRate" = NULL, "vatAmount" = NULL, "totalAmount" = NULL
              WHERE "price" = 0.00 AND "vatRate" = 0.00 AND "vatAmount" = 0.00 AND "totalAmount" = 0.00;
            `);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."CreditNote" ALTER COLUMN "status" TYPE "${schema}"."CreditNoteStatus" USING "status"::"${schema}"."CreditNoteStatus";`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."DocumentSignature" ADD COLUMN IF NOT EXISTS "creditNoteId" TEXT UNIQUE;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."EsfDocument" ADD COLUMN IF NOT EXISTS "creditNoteId" TEXT UNIQUE;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."DocumentSignature" DROP CONSTRAINT IF EXISTS "DocumentSignature_creditNoteId_fkey";`);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."DocumentSignature" ADD CONSTRAINT "DocumentSignature_creditNoteId_fkey"
                FOREIGN KEY ("creditNoteId") REFERENCES "${schema}"."CreditNote"("id") ON DELETE SET NULL;
            `);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."EsfDocument" DROP CONSTRAINT IF EXISTS "EsfDocument_creditNoteId_fkey";`);
            await tx.$executeRawUnsafe(`
              ALTER TABLE "${schema}"."EsfDocument" ADD CONSTRAINT "EsfDocument_creditNoteId_fkey"
                FOREIGN KEY ("creditNoteId") REFERENCES "${schema}"."CreditNote"("id") ON DELETE SET NULL;
            `);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "originalPrice" DECIMAL(15, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "originalPrice" DECIMAL(15, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "originalPrice" DECIMAL(15, 2);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "discountAmount" DECIMAL(15, 2) NOT NULL DEFAULT 0.00;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0.00;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "dealCurrency" TEXT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "dealCurrencyPrice" DECIMAL(15, 4);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "exchangeRate" DECIMAL(12, 6);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."InvoiceLineItem" ADD COLUMN IF NOT EXISTS "exchangeRateDate" TIMESTAMP;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "dealCurrency" TEXT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "dealCurrencyPrice" DECIMAL(15, 4);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "exchangeRate" DECIMAL(12, 6);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."WaybillLineItem" ADD COLUMN IF NOT EXISTS "exchangeRateDate" TIMESTAMP;`);

            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "dealCurrency" TEXT;`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "dealCurrencyPrice" DECIMAL(15, 4);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "exchangeRate" DECIMAL(12, 6);`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."ActLineItem" ADD COLUMN IF NOT EXISTS "exchangeRateDate" TIMESTAMP;`);
          },
          {
            timeout: 30000, // Explicit 30s timeout to allow lock waiting without transaction abortion
            maxWait: 10000
          }
        );

        console.log(`[Database] Schema ${schema} checked/created successfully.`);
        this.ensuredSchemas.add(schema);
      } catch (e) {
        console.error(`[Database] Error provisioning schema ${schema}:`, e);
        throw e;
      } finally {
        await baseClient.$disconnect();
      }
    })();

    // Synchronously register promise BEFORE any await statement in this function call
    this.provisioningPromises.set(schema, provisioningTask);

    try {
      await provisioningTask;
    } finally {
      this.provisioningPromises.delete(schema);
    }
  }

  async onModuleDestroy() {
    for (const client of this.clients.values()) {
      await client.$disconnect();
    }
    this.clients.clear();
    this.ensuredSchemas.clear();
    this.provisioningPromises.clear();
  }
}
