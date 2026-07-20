import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runSigningGuardsTest() {
  console.log('=== STARTING DOCUMENT SIGNING GUARDS & CONCURRENCY TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for signing guards test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `sign_guard_tenant_${Date.now()}`;
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

  const customerId = `cust_sign_${Date.now()}`;
  const waybillId = `wb_sign_${Date.now()}`;
  const actId = `act_sign_${Date.now()}`;
  const sku = `SKU-SIGN-GUARD-01`;

  // Seed Customer, Waybill, WaybillLineItem, StockItem (qty 50), and ServiceAct
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'ТОО "Клиент Подпись"', '110102030405');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."StockItem" (id, sku, quantity) VALUES ('stock_sign_1', '${sku}', 50);
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", amount, "vatAmount", status)
    VALUES ('${waybillId}', 'WB-GUARD-001', '${customerId}', 100000, 12000, 'DRAFT');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."WaybillLineItem" (id, "waybillId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('wb_item_1', '${waybillId}', '${sku}', 'Товар для отгрузки', 10, 10000, 12, 1200, 100000);
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."ServiceAct" (id, number, "customerId", amount, "vatAmount", status)
    VALUES ('${actId}', 'ACT-GUARD-001', '${customerId}', 80000, 9600, 'DRAFT');
  `);

  const mockSignedXml = `<signedXml><data>MOCK_DOCUMENT_SIGNATURE</data><signature iin="850412300999" bin="850412300999" name="ТЕСТОВЫЙ ПОЛЬЗОВАТЕЛЬ">MOCK_SIGNATURE_SERIAL_001</signature></signedXml>`;

  // =========================================================================
  // SECTION 1: Waybill Double Signing & Concurrency Protection
  // =========================================================================
  console.log('\n--- SECTION 1: Waybill Double Signing & Concurrency Protection ---');
  console.log('[Waybill Test] Firing 2 SIMULTANEOUS signWaybill requests...');

  const concurrentWaybillReqs = [
    fetch(`${baseUrl}/api/waybills/${waybillId}/sign`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ signedXml: mockSignedXml })
    }),
    fetch(`${baseUrl}/api/waybills/${waybillId}/sign`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ signedXml: mockSignedXml })
    })
  ];

  const wbResponses = await Promise.all(concurrentWaybillReqs);
  const wbSuccess = wbResponses.filter((r) => r.ok);
  const wbFailed = wbResponses.filter((r) => !r.ok);

  console.log(`[Waybill Test SUCCESS] Waybill concurrent signing: ${wbSuccess.length} succeeded, ${wbFailed.length} failed.`);

  if (wbSuccess.length !== 1 || wbFailed.length !== 1) {
    throw new Error(`Expected exactly 1 succeeded and 1 failed waybill sign request, got ${wbSuccess.length} succeeded and ${wbFailed.length} failed!`);
  }

  const wbFailedBody = await wbFailed[0].json();
  console.log(`[Waybill Test SUCCESS] Rejected request message: ${JSON.stringify(wbFailedBody)}`);

  // Verify database StockItem quantity is strictly 40 (decremented by 10 once, NOT 20)
  const stockItem = await tenantClient.stockItem.findUnique({ where: { sku } });
  const finalStockQty = Number(stockItem?.quantity);
  console.log(`[Waybill Test SUCCESS] Stock quantity after concurrent signing: ${finalStockQty} (Expected: 40)`);
  if (finalStockQty !== 40) {
    throw new Error(`Stock quantity was decremented incorrectly! Expected 40, got ${finalStockQty}`);
  }

  // =========================================================================
  // SECTION 2: ServiceAct Double Signing & Concurrency Protection
  // =========================================================================
  console.log('\n--- SECTION 2: ServiceAct Double Signing & Concurrency Protection ---');
  console.log('[Act Test] Firing 2 SIMULTANEOUS signAct requests...');

  const concurrentActReqs = [
    fetch(`${baseUrl}/api/acts/${actId}/sign`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ signedXml: mockSignedXml })
    }),
    fetch(`${baseUrl}/api/acts/${actId}/sign`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ signedXml: mockSignedXml })
    })
  ];

  const actResponses = await Promise.all(concurrentActReqs);
  const actSuccess = actResponses.filter((r) => r.ok);
  const actFailed = actResponses.filter((r) => !r.ok);

  console.log(`[Act Test SUCCESS] Act concurrent signing: ${actSuccess.length} succeeded, ${actFailed.length} failed.`);

  if (actSuccess.length !== 1 || actFailed.length !== 1) {
    throw new Error(`Expected exactly 1 succeeded and 1 failed act sign request, got ${actSuccess.length} succeeded and ${actFailed.length} failed!`);
  }

  const actFailedBody = await actFailed[0].json();
  console.log(`[Act Test SUCCESS] Rejected request message: ${JSON.stringify(actFailedBody)}`);

  // =========================================================================
  // SECTION 3: Sequential Re-signing Rejection Tests
  // =========================================================================
  console.log('\n--- SECTION 3: Sequential Re-signing Rejection ---');

  console.log('[Sequential Test] Attempting sequential re-signing of already DELIVERED waybill...');
  const seqWbRes = await fetch(`${baseUrl}/api/waybills/${waybillId}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml: mockSignedXml })
  });
  if (seqWbRes.ok) throw new Error('Re-signing already delivered waybill succeeded when it should have failed!');
  console.log(`[Sequential Test SUCCESS] Rejected with HTTP ${seqWbRes.status}: ${await seqWbRes.text()}`);

  console.log('[Sequential Test] Attempting sequential re-signing of already SIGNED_BY_CUSTOMER act...');
  const seqActRes = await fetch(`${baseUrl}/api/acts/${actId}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml: mockSignedXml })
  });
  if (seqActRes.ok) throw new Error('Re-signing already signed act succeeded when it should have failed!');
  console.log(`[Sequential Test SUCCESS] Rejected with HTTP ${seqActRes.status}: ${await seqActRes.text()}`);

  await tenantClient.$disconnect();

  console.log('\n=== DOCUMENT SIGNING GUARDS & CONCURRENCY TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runSigningGuardsTest().catch((err) => {
  console.error('=== DOCUMENT SIGNING GUARDS & CONCURRENCY TEST FAILED ===', err);
  process.exit(1);
});
