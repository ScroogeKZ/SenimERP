import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';

async function runDocumentNumberingTest() {
  console.log('=== STARTING DOCUMENT NUMBERING & SEQUENCE CONCURRENCY INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for document numbering test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `num_sec_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // Ensure DB schema does NOT exist beforehand
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_accountant',
      tenantId,
      email: 'accountant@senim.kz',
      roles: ['ERP_ACCOUNTANT']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Trigger schema provisioning
  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  console.log('[Test] Triggering on-demand schema provisioning...');
  const initRes = await fetch(`${baseUrl}/api/invoices`, { headers: getAuthHeaders() });
  if (!initRes.ok) throw new Error(`Initial invoice query failed: ${await initRes.text()}`);

  // =========================================================================
  // SECTION 1: Concurrent REST PurchaseOrder & SupplierInvoice Creation
  // =========================================================================
  console.log('\n--- SECTION 1: Concurrent REST PurchaseOrder & SupplierInvoice Creation ---');

  // Create supplier
  const supplierRes = await fetch(`${baseUrl}/api/suppliers`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      name: 'ТОО "Нумератор"',
      bin: '123456789012'
    })
  });
  if (!supplierRes.ok) throw new Error(`Supplier creation failed: ${await supplierRes.text()}`);
  const supplier = await supplierRes.json();

  console.log('[PO Test] Firing 5 SIMULTANEOUS POST /api/purchase-orders requests...');
  const poRequests = Array.from({ length: 5 }, (_, i) =>
    fetch(`${baseUrl}/api/purchase-orders`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        supplierId: supplier.id,
        items: [
          { sku: `SKU-PO-ITEM-${i}`, name: `Item ${i}`, quantity: 10, price: 5000 }
        ]
      })
    })
  );

  const poResponses = await Promise.all(poRequests);
  const poResults = await Promise.all(poResponses.map((r) => r.json()));
  const poNumbers = poResults.map((r) => r.number).sort();

  console.log(`[PO Test SUCCESS] 5 PurchaseOrders created with numbers: ${poNumbers.join(', ')}`);
  const expectedYear = new Date().getFullYear();
  if (poNumbers.length !== 5 || new Set(poNumbers).size !== 5) {
    throw new Error(`Duplicate PO numbers detected! Got: ${poNumbers.join(', ')}`);
  }
  if (!poNumbers[0].startsWith(`PO-${expectedYear}-`)) {
    throw new Error(`PO number formatting invalid! Expected PO-${expectedYear}-0001, got ${poNumbers[0]}`);
  }

  console.log('\n[AP Test] Firing 5 SIMULTANEOUS POST /api/supplier-invoices requests...');
  const supInvRequests = Array.from({ length: 5 }, (_, i) =>
    fetch(`${baseUrl}/api/supplier-invoices`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        supplierId: supplier.id,
        amount: 50000 * (i + 1)
      })
    })
  );

  const supInvResponses = await Promise.all(supInvRequests);
  const supInvResults = await Promise.all(supInvResponses.map((r) => r.json()));
  const supInvNumbers = supInvResults.map((r) => r.number).sort();

  console.log(`[AP Test SUCCESS] 5 SupplierInvoices created with numbers: ${supInvNumbers.join(', ')}`);
  if (supInvNumbers.length !== 5 || new Set(supInvNumbers).size !== 5) {
    throw new Error(`Duplicate SupplierInvoice numbers detected! Got: ${supInvNumbers.join(', ')}`);
  }
  if (!supInvNumbers[0].startsWith(`SUP-INV-${expectedYear}-`)) {
    throw new Error(`SupplierInvoice number formatting invalid! Expected SUP-INV-${expectedYear}-0001, got ${supInvNumbers[0]}`);
  }

  // =========================================================================
  // SECTION 2: Sequence Verification for Customer Documents (Invoice, Waybill, ServiceAct)
  // =========================================================================
  console.log('\n--- SECTION 2: Verifying Sequence Nextval queries for AR documents ---');

  const eventConsumer = app.get(EventConsumerService);

  console.log('[AR Event Test] Firing 5 SIMULTANEOUS deal.won events...');
  const dealEvents = Array.from({ length: 5 }, (_, i) => ({
    eventId: `evt_deal_${Date.now()}_${i}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: `deal_${i}`,
      customerId: `cust_${i}`,
      customerName: `Клиент ${i}`,
      customerBin: `99010203040${i}`,
      amount: 150000,
      items: [
        { sku: `SKU-GOODS-${i}`, crmProductId: `p_${i}`, name: `Товар ${i}`, quantity: 5, price: 20000, vatRate: 12 },
        { sku: `SRV-SERVICE-${i}`, crmProductId: `s_${i}`, name: `Услуга ${i}`, quantity: 1, price: 50000, vatRate: 12 }
      ]
    }
  }));

  await Promise.all(dealEvents.map((evt) => eventConsumer.handleDealWon(evt)));

  const invoices = await tenantClient.invoice.findMany({ orderBy: { number: 'asc' } });
  const waybills = await tenantClient.waybill.findMany({ orderBy: { number: 'asc' } });
  const acts = await tenantClient.serviceAct.findMany({ orderBy: { number: 'asc' } });

  const invNumbers = invoices.map((i) => i.number);
  const wayNumbers = waybills.map((w) => w.number);
  const actNumbers = acts.map((a) => a.number);

  console.log(`[AR Event Test SUCCESS] 5 Invoices created: ${invNumbers.join(', ')}`);
  console.log(`[AR Event Test SUCCESS] 5 Waybills created: ${wayNumbers.join(', ')}`);
  console.log(`[AR Event Test SUCCESS] 5 ServiceActs created: ${actNumbers.join(', ')}`);

  if (invNumbers.length !== 5 || new Set(invNumbers).size !== 5 || !invNumbers[0].startsWith(`INV-${expectedYear}-`)) {
    throw new Error(`Invoice numbering failed! Got: ${invNumbers.join(', ')}`);
  }
  if (wayNumbers.length !== 5 || new Set(wayNumbers).size !== 5 || !wayNumbers[0].startsWith(`WAY-${expectedYear}-`)) {
    throw new Error(`Waybill numbering failed! Got: ${wayNumbers.join(', ')}`);
  }
  if (actNumbers.length !== 5 || new Set(actNumbers).size !== 5 || !actNumbers[0].startsWith(`ACT-${expectedYear}-`)) {
    throw new Error(`ServiceAct numbering failed! Got: ${actNumbers.join(', ')}`);
  }

  await tenantClient.$disconnect();

  console.log('\n=== DOCUMENT NUMBERING & SEQUENCE CONCURRENCY TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runDocumentNumberingTest().catch((err) => {
  console.error('=== DOCUMENT NUMBERING & SEQUENCE CONCURRENCY TEST FAILED ===', err);
  process.exit(1);
});
