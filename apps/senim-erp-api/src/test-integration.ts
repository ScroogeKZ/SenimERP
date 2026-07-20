import { PrismaClient } from '@prisma/client';
import { EventBusPublisher } from '@senimerp/event-bus-client';
import { signSsoToken } from '@senimerp/auth-client';
import { IntegrationEvent, DealWonPayload } from '@senimerp/types';
import crypto from 'crypto';

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  { timeoutMs = 10000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

async function runTest() {
  console.log('=== STARTING END-TO-END INTEGRATION TEST ===');

  const tenantId = 'tenant_test_123';
  const schemaName = `tenant_${tenantId}`;
  
  // 1. Provision schema and database client
  console.log('[Test] Connecting to Database and provisioning tenant schema...');
  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  
  const publicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  
  await publicClient.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
  
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."EsfDocument" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."StockMovement" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."StockItem" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."DocumentSignature" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."InvoiceLineItem" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."Invoice" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."WaybillLineItem" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."Waybill" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."ActLineItem" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."ServiceAct" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."Customer" CASCADE;`);
  await publicClient.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."ProcessedEvent" CASCADE;`);
  await publicClient.$disconnect();

  const ddlQueries = [
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'InvoiceStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'WaybillStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."WaybillStatus" AS ENUM ('DRAFT', 'ISSUED', 'DELIVERED', 'CANCELLED');
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'ActStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."ActStatus" AS ENUM ('DRAFT', 'ISSUED', 'SIGNED_BY_CUSTOMER', 'CANCELLED');
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'EsfStatus' AND n.nspname = '${schemaName}') THEN
         CREATE TYPE "${schemaName}"."EsfStatus" AS ENUM ('PENDING', 'SUBMITTED', 'REGISTERED', 'REJECTED', 'FAILED');
       END IF;
     END$$;`,
    `CREATE TABLE "${schemaName}"."Customer" (id TEXT PRIMARY KEY, "crmId" TEXT UNIQUE, name TEXT NOT NULL, bin TEXT UNIQUE NOT NULL, address TEXT, email TEXT, phone TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."Invoice" (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, "customerId" TEXT NOT NULL REFERENCES "${schemaName}"."Customer"(id) ON DELETE CASCADE, amount DECIMAL(15,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, "paidAmount" DECIMAL(15,2) DEFAULT 0.00, status TEXT DEFAULT 'DRAFT', "issueDate" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "dueDate" TIMESTAMP NOT NULL, "signedXml" TEXT, "crmDealId" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."InvoiceLineItem" (id TEXT PRIMARY KEY, "invoiceId" TEXT NOT NULL REFERENCES "${schemaName}"."Invoice"(id) ON DELETE CASCADE, sku TEXT NOT NULL, "crmProductId" TEXT, name TEXT NOT NULL, quantity DECIMAL(12,3) NOT NULL, price DECIMAL(15,2) NOT NULL, "vatRate" DECIMAL(5,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, "totalAmount" DECIMAL(15,2) NOT NULL);`,
    `CREATE TABLE "${schemaName}"."Waybill" (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, "customerId" TEXT NOT NULL REFERENCES "${schemaName}"."Customer"(id) ON DELETE CASCADE, amount DECIMAL(15,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, status TEXT DEFAULT 'DRAFT', "issueDate" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "signedXml" TEXT, "crmDealId" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."WaybillLineItem" (id TEXT PRIMARY KEY, "waybillId" TEXT NOT NULL REFERENCES "${schemaName}"."Waybill"(id) ON DELETE CASCADE, sku TEXT NOT NULL, "crmProductId" TEXT, name TEXT NOT NULL, quantity DECIMAL(12,3) NOT NULL, price DECIMAL(15,2) NOT NULL, "vatRate" DECIMAL(5,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, "totalAmount" DECIMAL(15,2) NOT NULL);`,
    `CREATE TABLE "${schemaName}"."ServiceAct" (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, "customerId" TEXT NOT NULL REFERENCES "${schemaName}"."Customer"(id) ON DELETE CASCADE, amount DECIMAL(15,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, status TEXT DEFAULT 'DRAFT', "issueDate" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "signedXml" TEXT, "crmDealId" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."ActLineItem" (id TEXT PRIMARY KEY, "actId" TEXT NOT NULL REFERENCES "${schemaName}"."ServiceAct"(id) ON DELETE CASCADE, sku TEXT NOT NULL, "crmProductId" TEXT, name TEXT NOT NULL, quantity DECIMAL(12,3) NOT NULL, price DECIMAL(15,2) NOT NULL, "vatRate" DECIMAL(5,2) NOT NULL, "vatAmount" DECIMAL(15,2) NOT NULL, "totalAmount" DECIMAL(15,2) NOT NULL);`,
    `CREATE TABLE "${schemaName}"."DocumentSignature" (id TEXT PRIMARY KEY, "invoiceId" TEXT UNIQUE REFERENCES "${schemaName}"."Invoice"(id) ON DELETE SET NULL, "waybillId" TEXT UNIQUE REFERENCES "${schemaName}"."Waybill"(id) ON DELETE SET NULL, "actId" TEXT UNIQUE REFERENCES "${schemaName}"."ServiceAct"(id) ON DELETE SET NULL, "signedBy" TEXT NOT NULL, iin TEXT NOT NULL, "certSerial" TEXT NOT NULL, "signedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."EsfDocument" (id TEXT PRIMARY KEY, "invoiceId" TEXT UNIQUE REFERENCES "${schemaName}"."Invoice"(id) ON DELETE SET NULL, "waybillId" TEXT UNIQUE REFERENCES "${schemaName}"."Waybill"(id) ON DELETE SET NULL, "actId" TEXT UNIQUE REFERENCES "${schemaName}"."ServiceAct"(id) ON DELETE SET NULL, status TEXT DEFAULT 'PENDING', "esfRegNumber" TEXT, "requestXml" TEXT, "responseXml" TEXT, "errorMessage" TEXT, "submittedAt" TIMESTAMP, "confirmedAt" TIMESTAMP, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."ProcessedEvent" (id TEXT PRIMARY KEY, "eventType" TEXT NOT NULL, "processedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."StockItem" (id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, "crmProductId" TEXT, quantity DECIMAL(12,3) DEFAULT 0 NOT NULL, reserved DECIMAL(12,3) DEFAULT 0 NOT NULL, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE "${schemaName}"."StockMovement" (id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity DECIMAL(12,3) NOT NULL, type TEXT NOT NULL, "referenceId" TEXT, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`
  ];

  const pgSetupClient = new PrismaClient({ datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } } });
  for (const q of ddlQueries) {
    await pgSetupClient.$executeRawUnsafe(q);
  }
  await pgSetupClient.$disconnect();
  console.log('[Test] Tenant Database Schema provisioned successfully.');

  // 2. Win the deal in CRM via HTTP POST API (which registers the deal and publishes the event)
  console.log('[Test] Winning deal in CRM via API...');
  const winRes = await fetch('http://localhost:3002/api/deals/win', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dealId: 'deal_integration_999',
      tenantId,
      customerId: 'crm_cust_999',
      customerName: 'ИП Прогресс РК',
      customerBin: '850412300999',
      customerAddress: 'Казахстан, г. Нур-Султан, ул. Достык 10',
      amount: 1450000,
      items: [
        { sku: 'HW-ROUTER-01', crmProductId: 'prod_router', name: 'Маршрутизатор Cisco ISR', quantity: 2, price: 500000, vatRate: 12 },
        { sku: 'SRV-ROUTER-CONF', crmProductId: 'prod_conf', name: 'Услуга настройки маршрутизатора', quantity: 1, price: 450000, vatRate: 12 }
      ]
    })
  });

  if (!winRes.ok) {
    throw new Error(`Verification Failed: CRM deal.win endpoint failed with status ${winRes.status}`);
  }
  const winData = (await winRes.json()) as any;
  console.log(`[Test] CRM deal won and event published with ID: ${winData.eventId}`);

  const db = new PrismaClient({ datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } } });

  // Wait for BullMQ worker to consume event
  console.log('[Test] Waiting for ERP subscriber to process event...');
  await pollUntil(() => db.processedEvent.findUnique({ where: { id: winData.eventId } }));

  // 3. Verify Database records
  console.log('[Test] Querying database for generated documents...');
  
  const processed = await db.processedEvent.findUnique({ where: { id: winData.eventId } });
  if (!processed) {
    throw new Error('Verification Failed: deal.won event was not logged in ProcessedEvent table.');
  }
  console.log('✓ Idempotency log ProcessedEvent verified.');

  const invoice = await db.invoice.findFirst({ where: { crmDealId: 'deal_integration_999' }, include: { items: true } });
  if (!invoice) {
    throw new Error('Verification Failed: Invoice was not created.');
  }
  console.log(`✓ Invoice found: ${invoice.number} with amount ${invoice.amount} KZT and status ${invoice.status}`);
  if (invoice.items.length !== 2) {
    throw new Error(`Verification Failed: Invoice has ${invoice.items.length} lines instead of 2.`);
  }
  console.log(`✓ Invoice Line Items verified (count: ${invoice.items.length}).`);

  const waybill = await db.waybill.findFirst({ where: { crmDealId: 'deal_integration_999' }, include: { items: true } });
  if (!waybill) {
    throw new Error('Verification Failed: Waybill was not created for physical goods.');
  }
  console.log(`✓ Waybill found: ${waybill.number} with amount ${waybill.amount} KZT`);
  if (waybill.items[0].sku !== 'HW-ROUTER-01') {
    throw new Error('Verification Failed: Waybill contains incorrect physical item SKU.');
  }
  console.log('✓ Waybill Line Items verified (contained only physical items).');

  const act = await db.serviceAct.findFirst({ where: { crmDealId: 'deal_integration_999' }, include: { items: true } });
  if (!act) {
    throw new Error('Verification Failed: ServiceAct was not created for services.');
  }
  console.log(`✓ Service Act found: ${act.number} with amount ${act.amount} KZT`);
  if (act.items[0].sku !== 'SRV-ROUTER-CONF') {
    throw new Error('Verification Failed: Service Act contains incorrect service item SKU.');
  }
  console.log('✓ Service Act Line Items verified (contained only services).');

  // 3.1 Verify Event Idempotency (Duplicate Delivery)
  console.log('[Test] Re-publishing the same deal.won event to verify idempotency...');
  const duplicatePublisher = new EventBusPublisher();
  await duplicatePublisher.publishEvent({
    eventId: winData.eventId, // Same event ID to trigger deduplication logic
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: 'deal_integration_999',
      customerId: 'crm_cust_999',
      customerName: 'ИП Прогресс РК',
      customerBin: '850412300999',
      customerAddress: 'Казахстан, г. Нур-Султан, ул. Достык 10',
      amount: 1450000,
      items: [
        { sku: 'HW-ROUTER-01', crmProductId: 'prod_router', name: 'Маршрутизатор Cisco ISR', quantity: 2, price: 500000, vatRate: 12 },
        { sku: 'SRV-ROUTER-CONF', crmProductId: 'prod_conf', name: 'Услуга настройки маршрутизатора', quantity: 1, price: 450000, vatRate: 12 }
      ]
    }
  });

  await delay(2000); // Give the event bus worker time to process the duplicate

  const invoicesAfterDuplicate = await db.invoice.findMany({ where: { crmDealId: 'deal_integration_999' } });
  if (invoicesAfterDuplicate.length !== 1) {
    throw new Error(
      `Verification Failed: idempotency broken — expected 1 invoice after duplicate event, found ${invoicesAfterDuplicate.length}.`
    );
  }
  console.log('✓ Idempotency verified: duplicate deal.won event did not create a second Invoice.');
  await duplicatePublisher.close();

  // 4. Simulate NCALayer Signing via REST endpoints
  console.log('[Test] Simulating NCALayer signing on Invoice...');
  const token = signSsoToken({
    sub: 'usr_accountant_test',
    email: 'accountant@senim.kz',
    tenantId,
    roles: ['ERP_ACCOUNTANT']
  });

  const apiHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const signedXml = `<signedXml><data>MOCK_DOC</data><signature iin="850412300999" bin="850412300999" name="ТЕСТОВЫЙ ПОЛЬЗОВАТЕЛЬ">MOCK_SIGNATURE_DATA_CN=TEST_CERT_SERIAL_999</signature></signedXml>`;
  
  const signRes = await fetch(`http://localhost:3004/api/invoices/${invoice.id}/sign`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ signedXml })
  });

  if (!signRes.ok) {
    throw new Error(`Verification Failed: Sign invoice REST endpoint failed with status ${signRes.status}`);
  }
  
  const signedInv = await db.invoice.findUnique({ where: { id: invoice.id }, include: { signature: true } });
  if (signedInv?.status !== 'ISSUED' || !signedInv.signature) {
    throw new Error(`Verification Failed: Invoice status is ${signedInv?.status} instead of ISSUED or signature not logged.`);
  }
  console.log('✓ Invoice signature verification and state update verified.');

  // 5. Simulate Partial Payment and Event loop verification
  console.log('[Test] Registering invoice partial payment of 1,000,000 KZT...');
  const payRes1 = await fetch(`http://localhost:3004/api/invoices/${invoice.id}/pay`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ amount: 1000000 })
  });

  if (!payRes1.ok) {
    throw new Error(`Verification Failed: Invoice partial payment failed with status ${payRes1.status}`);
  }

  const partiallyPaidInv = await db.invoice.findUnique({ where: { id: invoice.id } });
  if (partiallyPaidInv?.status !== 'PARTIALLY_PAID' || Number(partiallyPaidInv.paidAmount) !== 1000000) {
    throw new Error(`Verification Failed: Invoice status is ${partiallyPaidInv?.status} (paidAmount: ${partiallyPaidInv?.paidAmount}) instead of PARTIALLY_PAID.`);
  }
  console.log('✓ Invoice partial payment registration and PARTIALLY_PAID status verified.');

  // Wait for partial payment event to travel back to CRM API and update CRM DB
  console.log('[Test] Waiting for CRM API to process ERP partial payment event...');
  const crmDeal1 = await pollUntil(async () => {
    const res = await fetch(`http://localhost:3002/api/deals/deal_integration_999`);
    if (!res.ok) return null;
    const deal = await res.json() as any;
    return deal.paymentStatus === 'partially_paid' ? deal : null;
  });
  console.log('✓ CRM partial payment status update verification verified.');

  // 6. Simulate Final Payment to reach full amount
  console.log('[Test] Registering invoice final payment of remaining 624,000 KZT...');
  const payRes2 = await fetch(`http://localhost:3004/api/invoices/${invoice.id}/pay`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ amount: 624000 })
  });

  if (!payRes2.ok) {
    throw new Error(`Verification Failed: Invoice final payment failed with status ${payRes2.status}`);
  }

  const fullyPaidInv = await db.invoice.findUnique({ where: { id: invoice.id } });
  if (fullyPaidInv?.status !== 'PAID' || Number(fullyPaidInv.paidAmount) !== 1624000) {
    throw new Error(`Verification Failed: Invoice status is ${fullyPaidInv?.status} (paidAmount: ${fullyPaidInv?.paidAmount}) instead of PAID.`);
  }
  console.log('✓ Invoice full payment registration and PAID status verified.');

  // Wait for final payment event to travel back to CRM API and update CRM DB
  console.log('[Test] Waiting for CRM API to process ERP final payment event...');
  const crmDeal2 = await pollUntil(async () => {
    const res = await fetch(`http://localhost:3002/api/deals/deal_integration_999`);
    if (!res.ok) return null;
    const deal = await res.json() as any;
    return deal.paymentStatus === 'paid' ? deal : null;
  });
  console.log('✓ CRM final payment status update verification verified.');

  // 7. Test Warehouse Receipt
  console.log('[Test] Posting warehouse receipt of 100 units for SKU HW-ROUTER-01...');
  const receiptRes = await fetch('http://localhost:3004/api/warehouse/receipts', {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ sku: 'HW-ROUTER-01', quantity: 100, referenceId: 'REC-001' })
  });

  if (!receiptRes.ok) {
    throw new Error(`Verification Failed: Warehouse receipt endpoint failed with status ${receiptRes.status}`);
  }

  const stockAfterReceipt = await (db as any).stockItem.findUnique({ where: { sku: 'HW-ROUTER-01' } });
  if (!stockAfterReceipt || Number(stockAfterReceipt.quantity) !== 100) {
    throw new Error(`Verification Failed: StockItem quantity is ${stockAfterReceipt?.quantity} instead of 100.`);
  }
  console.log('✓ Warehouse receipt recorded in ERP database.');

  // Wait for stock.level_changed event to hit CRM
  console.log('[Test] Waiting for CRM API to process stock.level_changed event after receipt...');
  await pollUntil(async () => {
    const res = await fetch('http://localhost:3002/api/stocks/HW-ROUTER-01');
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.quantity === 100 ? data : null;
  });
  console.log('✓ CRM stock level verified at 100.');

  // 8. Test Waybill Signing (Deduction of 2 units of HW-ROUTER-01)
  console.log('[Test] Simulating signing Waybill (Delivery) & Stock Deduction...');
  const waybillSignRes = await fetch(`http://localhost:3004/api/waybills/${waybill.id}/sign`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ signedXml })
  });

  if (!waybillSignRes.ok) {
    throw new Error(`Verification Failed: Sign waybill REST endpoint failed with status ${waybillSignRes.status}`);
  }

  const stockAfterWaybill = await (db as any).stockItem.findUnique({ where: { sku: 'HW-ROUTER-01' } });
  if (!stockAfterWaybill || Number(stockAfterWaybill.quantity) !== 98) {
    throw new Error(`Verification Failed: StockItem quantity is ${stockAfterWaybill?.quantity} instead of 98 after waybill signing.`);
  }
  console.log('✓ StockItem balance correctly deducted to 98 in ERP.');

  const shipmentMovement = await (db as any).stockMovement.findFirst({
    where: { sku: 'HW-ROUTER-01', type: 'shipment', referenceId: waybill.id }
  });
  if (!shipmentMovement || Number(shipmentMovement.quantity) !== -2) {
    throw new Error('Verification Failed: StockMovement for shipment not recorded correctly.');
  }
  console.log('✓ StockMovement for shipment recorded in ERP.');

  console.log('[Test] Waiting for CRM API to process stock.level_changed and shipment.completed events...');
  await pollUntil(async () => {
    const res = await fetch('http://localhost:3002/api/stocks/HW-ROUTER-01');
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.quantity === 98 ? data : null;
  });
  console.log('✓ CRM stock level verified at 98.');

  const crmDeal3 = await pollUntil(async () => {
    const res = await fetch('http://localhost:3002/api/deals/deal_integration_999');
    if (!res.ok) return null;
    const deal = await res.json() as any;
    return deal.shipmentStatus === 'delivered' ? deal : null;
  });
  console.log('✓ CRM waybill status update verification verified (fulfillment status: delivered).');

  // 8.5 Test IS ESF Submission Queue & Registration Verification
  console.log('[Test] Verifying IS ESF submission for signed Waybill...');
  const esfDoc = await pollUntil(async () => {
    const res = await fetch(`http://localhost:3004/api/waybills/${waybill.id}/esf`, { headers: apiHeaders });
    if (!res.ok) return null;
    const doc = await res.json() as any;
    return doc.status === 'REGISTERED' ? doc : null;
  }, { timeoutMs: 15000, intervalMs: 500 });

  if (!esfDoc || !esfDoc.esfRegNumber || !esfDoc.esfRegNumber.startsWith('ESF-')) {
    throw new Error(`Verification Failed: ESF document status is ${esfDoc?.status}, esfRegNumber: ${esfDoc?.esfRegNumber}`);
  }
  console.log(`✓ IS ESF submission verified: Waybill ESF REGISTERED with Reg. № ${esfDoc.esfRegNumber}.`);

  // Test Manual Retry endpoint
  console.log('[Test] Testing ESF manual retry endpoint...');
  const retryRes = await fetch(`http://localhost:3004/api/waybills/${waybill.id}/esf/retry`, {
    method: 'POST',
    headers: apiHeaders
  });
  if (!retryRes.ok) {
    throw new Error(`Verification Failed: ESF retry endpoint returned status ${retryRes.status}`);
  }
  console.log('✓ ESF manual retry endpoint verified.');

  // 9. Test Edge Case: Signing a waybill with an unstocked item
  console.log('[Test] Testing edge case: waybill for unstocked item...');
  const unstockedWaybill = await (db as any).waybill.create({
    data: {
      number: 'WAY-UNSTOCKED-99',
      customerId: waybill.customerId,
      amount: 1000,
      vatAmount: 120,
      status: 'DRAFT',
      crmDealId: 'deal_unstocked_99',
      items: {
        create: [
          { sku: 'UNSTOCKED-SKU-999', name: 'Nonexistent Item', quantity: 5, price: 200, vatRate: 12, vatAmount: 24, totalAmount: 224 }
        ]
      }
    }
  });

  const unstockedSignRes = await fetch(`http://localhost:3004/api/waybills/${unstockedWaybill.id}/sign`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ signedXml })
  });

  if (!unstockedSignRes.ok) {
    throw new Error(`Verification Failed: Sign unstocked waybill failed with status ${unstockedSignRes.status}`);
  }

  const unstockedItem = await (db as any).stockItem.findUnique({ where: { sku: 'UNSTOCKED-SKU-999' } });
  if (!unstockedItem || Number(unstockedItem.quantity) !== -5) {
    throw new Error(`Verification Failed: Unstocked item should have negative quantity -5, found ${unstockedItem?.quantity}`);
  }
  console.log('✓ Edge case verified: Unstocked item created with negative balance -5 and processed gracefully.');

  console.log('=== ALL INTEGRATION TESTS PASSED SUCCESSFULLY! ===');
  
  await db.$disconnect();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('!!! INTEGRATION TEST FAILED !!!');
  console.error(err);
  process.exit(1);
});
