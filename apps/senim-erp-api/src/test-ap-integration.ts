import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import crypto from 'crypto';

async function runApTest() {
  console.log('=== STARTING AP (SUPPLIER INVOICES & DEBT) INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const tenantId = 'tenant_ap_test_123';
  const schemaName = `tenant_${tenantId}`;
  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';

  // 1. Provision schema and database tables
  console.log('[Test] Connecting to Database and provisioning tenant schema...');
  const publicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });

  await publicClient.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."SupplierPayment" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."SupplierInvoice" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."PurchaseOrderItem" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."PurchaseOrder" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."Supplier" CASCADE;`);
  await publicClient.$disconnect();

  const ddlQueries = [
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'SupplierInvoiceStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."SupplierInvoiceStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'PurchaseOrderStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
       END IF;
     END$$;`,
    `CREATE TABLE "${schemaName}"."Supplier" (id TEXT PRIMARY KEY, name TEXT NOT NULL, bin TEXT UNIQUE, address TEXT, email TEXT, phone TEXT, "bankAccount" TEXT, "bankBik" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."PurchaseOrder" (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, "supplierId" TEXT NOT NULL REFERENCES "${schemaName}"."Supplier"(id) ON DELETE CASCADE, status TEXT DEFAULT 'DRAFT', "expectedDate" TIMESTAMP, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."PurchaseOrderItem" (id TEXT PRIMARY KEY, "purchaseOrderId" TEXT NOT NULL REFERENCES "${schemaName}"."PurchaseOrder"(id) ON DELETE CASCADE, sku TEXT NOT NULL, "crmProductId" TEXT, name TEXT NOT NULL, quantity DECIMAL(12,3) NOT NULL, "receivedQty" DECIMAL(12,3) DEFAULT 0 NOT NULL, price DECIMAL(15,2) NOT NULL);`,
    `CREATE TABLE "${schemaName}"."SupplierInvoice" (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, "supplierId" TEXT NOT NULL REFERENCES "${schemaName}"."Supplier"(id) ON DELETE CASCADE, "purchaseOrderId" TEXT REFERENCES "${schemaName}"."PurchaseOrder"(id) ON DELETE SET NULL, amount DECIMAL(15,2) NOT NULL, "paidAmount" DECIMAL(15,2) DEFAULT 0.00, status TEXT DEFAULT 'UNPAID', "issueDate" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "dueDate" TIMESTAMP, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."SupplierPayment" (id TEXT PRIMARY KEY, "supplierInvoiceId" TEXT NOT NULL REFERENCES "${schemaName}"."SupplierInvoice"(id) ON DELETE CASCADE, amount DECIMAL(15,2) NOT NULL, "paidAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, method TEXT, "referenceId" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`
  ];

  const pgSetupClient = new PrismaClient({ datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } } });
  for (const q of ddlQueries) {
    await pgSetupClient.$executeRawUnsafe(q);
  }
  await pgSetupClient.$disconnect();
  console.log('[Test] Tenant Database Schema provisioned successfully.');

  // Create auth headers
  const ssoToken = signSsoToken({
    sub: 'usr_accountant_test',
    tenantId,
    email: 'accountant@senim.kz',
    roles: ['ERP_ACCOUNTANT']
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ssoToken}`
  };

  const baseUrl = process.env.ERP_API_URL || 'http://localhost:3004';

  // Step A: Create Supplier
  console.log('[Test] Step A: Creating supplier...');
  const supplierRes = await fetch(`${baseUrl}/api/suppliers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'ТОО "ТехноПоставка"',
      bin: `99${Math.floor(100000000 + Math.random() * 900000000)}`,
      email: 'info@techno.kz'
    })
  });
  if (!supplierRes.ok) throw new Error(`Failed to create supplier: ${await supplierRes.text()}`);
  const supplier = await supplierRes.json();
  console.log(`[Test] Supplier created: ${supplier.name} (${supplier.id})`);

  // Step B: Create Supplier Invoice for 500,000 KZT
  console.log('[Test] Step B: Registering SupplierInvoice for 500,000 KZT...');
  const invoiceRes = await fetch(`${baseUrl}/api/supplier-invoices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      supplierId: supplier.id,
      amount: 500000
    })
  });
  if (!invoiceRes.ok) throw new Error(`Failed to create supplier invoice: ${await invoiceRes.text()}`);
  const invoice = await invoiceRes.json();
  console.log(`[Test] Invoice created: ${invoice.number}, amount=${invoice.amount}, status=${invoice.status}`);
  if (invoice.status !== 'UNPAID') throw new Error(`Expected status UNPAID, got ${invoice.status}`);
  if (Number(invoice.paidAmount) !== 0) throw new Error(`Expected paidAmount 0, got ${invoice.paidAmount}`);

  // Step C: Pay 300,000 KZT -> status PARTIALLY_PAID, debt = 200,000 KZT
  console.log('[Test] Step C: Processing partial payment of 300,000 KZT...');
  const pay1Res = await fetch(`${baseUrl}/api/supplier-invoices/${invoice.id}/pay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 300000,
      method: 'banking',
      referenceId: 'PAY-001'
    })
  });
  if (!pay1Res.ok) throw new Error(`Failed partial payment: ${await pay1Res.text()}`);
  const paidInvoice1 = await pay1Res.json();
  console.log(`[Test] Paid 300,000: status=${paidInvoice1.status}, paidAmount=${paidInvoice1.paidAmount}`);

  if (paidInvoice1.status !== 'PARTIALLY_PAID') {
    throw new Error(`Expected status PARTIALLY_PAID, got ${paidInvoice1.status}`);
  }

  // Check debt endpoint
  console.log('[Test] Checking GET /api/suppliers/debt...');
  const debt1Res = await fetch(`${baseUrl}/api/suppliers/debt`, { headers });
  if (!debt1Res.ok) throw new Error(`Failed to fetch supplier debt: ${await debt1Res.text()}`);
  const debtList1 = await debt1Res.json();
  const supplierDebt1 = debtList1.find((d: any) => d.supplierId === supplier.id);
  console.log(`[Test] Supplier debt summary: totalBilled=${supplierDebt1.totalBilled}, totalPaid=${supplierDebt1.totalPaid}, debt=${supplierDebt1.debt}`);
  if (supplierDebt1.debt !== 200000) {
    throw new Error(`Expected supplier debt to be 200000, got ${supplierDebt1.debt}`);
  }

  // Step D: Pay remaining 200,000 KZT -> status PAID, debt = 0 KZT
  console.log('[Test] Step D: Processing final payment of 200,000 KZT...');
  const pay2Res = await fetch(`${baseUrl}/api/supplier-invoices/${invoice.id}/pay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 200000,
      method: 'banking',
      referenceId: 'PAY-002'
    })
  });
  if (!pay2Res.ok) throw new Error(`Failed final payment: ${await pay2Res.text()}`);
  const paidInvoice2 = await pay2Res.json();
  console.log(`[Test] Paid remaining 200,000: status=${paidInvoice2.status}, paidAmount=${paidInvoice2.paidAmount}`);

  if (paidInvoice2.status !== 'PAID') {
    throw new Error(`Expected status PAID, got ${paidInvoice2.status}`);
  }

  const debt2Res = await fetch(`${baseUrl}/api/suppliers/debt`, { headers });
  const debtList2 = await debt2Res.json();
  const supplierDebt2 = debtList2.find((d: any) => d.supplierId === supplier.id);
  console.log(`[Test] Supplier debt summary: totalBilled=${supplierDebt2.totalBilled}, totalPaid=${supplierDebt2.totalPaid}, debt=${supplierDebt2.debt}`);
  if (supplierDebt2.debt !== 0) {
    throw new Error(`Expected supplier debt to be 0, got ${supplierDebt2.debt}`);
  }

  // Step E: Overpayment validation -> extra 10,000 KZT payment should be rejected with 400 Bad Request
  console.log('[Test] Step E: Testing overpayment protection (attempting extra 10,000 KZT payment)...');
  const overpayRes = await fetch(`${baseUrl}/api/supplier-invoices/${invoice.id}/pay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 10000,
      method: 'banking'
    })
  });
  if (overpayRes.ok) {
    throw new Error('Overpayment was expected to be rejected, but succeeded!');
  }
  const overpayErr = await overpayRes.json();
  console.log(`[Test] Overpayment successfully rejected with HTTP ${overpayRes.status}: ${JSON.stringify(overpayErr)}`);

  console.log('=== AP INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runApTest().catch((err) => {
  console.error('=== AP INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
