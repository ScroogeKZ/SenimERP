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
              END$$;
            `);

            // 3. Create tables inside the tenant schema
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
                "sku" TEXT UNIQUE NOT NULL,
                "crmProductId" TEXT,
                "quantity" DECIMAL(12, 3) NOT NULL DEFAULT 0,
                "reserved" DECIMAL(12, 3) NOT NULL DEFAULT 0,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `);

            await tx.$executeRawUnsafe(`
              CREATE TABLE IF NOT EXISTS "${schema}"."StockMovement" (
                "id" TEXT PRIMARY KEY,
                "sku" TEXT NOT NULL,
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

            // 4. Create sequences for monotonic document numbering
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."invoice_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."waybill_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."act_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."po_number_seq";`);
            await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${schema}"."supplier_invoice_number_seq";`);
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
