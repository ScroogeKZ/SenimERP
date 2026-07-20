import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runEsfRetryGuardTest() {
  console.log('=== STARTING ESF RETRY STATUS GUARD INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for ESF retry guard test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `esf_retry_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_esf_guard',
      tenantId,
      email: 'esf@senim.kz',
      roles: ['ERP_ACCOUNTANT']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;
  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  // Trigger schema provisioning
  console.log('[Test] Triggering on-demand schema provisioning...');
  await fetch(`${baseUrl}/api/invoices`, { headers: getAuthHeaders() });

  // Wait for schema creation
  await new Promise((r) => setTimeout(r, 1000));

  // Create customer and invoice via raw SQL for test setup
  const customerId = `cust_esf_retry_${Date.now()}`;
  const invoiceId = `inv_esf_retry_${Date.now()}`;
  const waybillId = `wb_esf_retry_${Date.now()}`;
  const actId = `act_esf_retry_${Date.now()}`;

  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'Клиент ЭСФ', '990102030405');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate", "signedXml")
    VALUES ('${invoiceId}', 'INV-ESF-RETRY-001', '${customerId}', 100000, 12000, 0, 'ISSUED', now() + interval '14 days',
    '<signedXml><data>MOCK</data><signature iin="850412300999" bin="850412300999" name="TEST">SIG</signature></signedXml>');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", amount, "vatAmount", status, "signedXml")
    VALUES ('${waybillId}', 'WAY-ESF-RETRY-001', '${customerId}', 80000, 9600, 'DELIVERED',
    '<signedXml><data>MOCK</data><signature iin="850412300999" bin="850412300999" name="TEST">SIG</signature></signedXml>');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."ServiceAct" (id, number, "customerId", amount, "vatAmount", status, "signedXml")
    VALUES ('${actId}', 'ACT-ESF-RETRY-001', '${customerId}', 60000, 7200, 'SIGNED_BY_CUSTOMER',
    '<signedXml><data>MOCK</data><signature iin="850412300999" bin="850412300999" name="TEST">SIG</signature></signedXml>');
  `);

  // =========================================================================
  // SECTION 1: Invoice ESF retry — first call creates, subsequent blocked after REGISTERED
  // =========================================================================
  console.log('\n--- SECTION 1: Invoice ESF Retry Guard ---');

  // First retry creates EsfDocument (no existing doc)
  const firstRetryRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!firstRetryRes.ok) throw new Error(`First invoice ESF retry failed: ${await firstRetryRes.text()}`);
  const firstEsfDoc = await firstRetryRes.json();
  console.log(`[Invoice ESF Test] First retry created EsfDocument ${firstEsfDoc.id}, status=${firstEsfDoc.status}`);

  // Wait for worker to process and register
  await new Promise((r) => setTimeout(r, 2000));

  // Verify document is now REGISTERED
  const esfStatusRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/esf`, { headers: getAuthHeaders() });
  const esfStatus = await esfStatusRes.json();
  console.log(`[Invoice ESF Test] After worker: status=${esfStatus.status}, regNumber=${esfStatus.esfRegNumber}`);
  if (esfStatus.status !== 'REGISTERED') {
    throw new Error(`Expected REGISTERED, got ${esfStatus.status}`);
  }

  // Now retry on REGISTERED document — should be blocked
  const blockedRetryRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (blockedRetryRes.status !== 400) {
    throw new Error(`Expected HTTP 400 for REGISTERED retry, got ${blockedRetryRes.status}: ${await blockedRetryRes.text()}`);
  }
  const blockedBody = await blockedRetryRes.json();
  console.log(`[Invoice ESF Test SUCCESS] REGISTERED retry blocked: ${JSON.stringify(blockedBody)}`);

  // =========================================================================
  // SECTION 2: Direct ESF ID retry — blocked for REGISTERED
  // =========================================================================
  console.log('\n--- SECTION 2: Direct ESF/:id/retry Guard ---');

  const directRetryRes = await fetch(`${baseUrl}/api/esf/${firstEsfDoc.id}/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (directRetryRes.status !== 400) {
    throw new Error(`Expected HTTP 400 for direct ESF retry on REGISTERED doc, got ${directRetryRes.status}`);
  }
  const directBody = await directRetryRes.json();
  console.log(`[Direct ESF Test SUCCESS] REGISTERED retry blocked: ${JSON.stringify(directBody)}`);

  // =========================================================================
  // SECTION 3: Waybill ESF retry — create then block after REGISTERED
  // =========================================================================
  console.log('\n--- SECTION 3: Waybill ESF Retry Guard ---');

  const wbRetryRes = await fetch(`${baseUrl}/api/waybills/${waybillId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!wbRetryRes.ok) throw new Error(`Waybill ESF retry failed: ${await wbRetryRes.text()}`);
  console.log('[Waybill ESF Test] First retry created EsfDocument, waiting for worker...');
  await new Promise((r) => setTimeout(r, 2000));

  const wbBlockedRes = await fetch(`${baseUrl}/api/waybills/${waybillId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (wbBlockedRes.status !== 400) {
    throw new Error(`Expected HTTP 400 for waybill REGISTERED retry, got ${wbBlockedRes.status}`);
  }
  console.log(`[Waybill ESF Test SUCCESS] REGISTERED retry blocked: ${JSON.stringify(await wbBlockedRes.json())}`);

  // =========================================================================
  // SECTION 4: Act ESF retry — create then block after REGISTERED
  // =========================================================================
  console.log('\n--- SECTION 4: Act ESF Retry Guard ---');

  const actRetryRes = await fetch(`${baseUrl}/api/acts/${actId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!actRetryRes.ok) throw new Error(`Act ESF retry failed: ${await actRetryRes.text()}`);
  console.log('[Act ESF Test] First retry created EsfDocument, waiting for worker...');
  await new Promise((r) => setTimeout(r, 2000));

  const actBlockedRes = await fetch(`${baseUrl}/api/acts/${actId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (actBlockedRes.status !== 400) {
    throw new Error(`Expected HTTP 400 for act REGISTERED retry, got ${actBlockedRes.status}`);
  }
  console.log(`[Act ESF Test SUCCESS] REGISTERED retry blocked: ${JSON.stringify(await actBlockedRes.json())}`);

  // =========================================================================
  // SECTION 5: ESF retry for FAILED document — should succeed
  // =========================================================================
  console.log('\n--- SECTION 5: FAILED Document Retry (should succeed) ---');

  // Manually set first ESF doc to FAILED
  await tenantClient.$executeRawUnsafe(`
    UPDATE "${schemaName}"."EsfDocument"
    SET "status" = 'FAILED', "errorMessage" = 'Simulated failure'
    WHERE "id" = '${firstEsfDoc.id}';
  `);

  const failedRetryRes = await fetch(`${baseUrl}/api/esf/${firstEsfDoc.id}/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!failedRetryRes.ok) {
    throw new Error(`FAILED document retry should succeed, got ${failedRetryRes.status}: ${await failedRetryRes.text()}`);
  }
  const failedRetryBody = await failedRetryRes.json();
  console.log(`[FAILED Retry Test SUCCESS] FAILED document retried: status=${failedRetryBody.status}`);

  await tenantClient.$disconnect();

  console.log('\n=== ESF RETRY STATUS GUARD INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runEsfRetryGuardTest().catch((err) => {
  console.error('=== ESF RETRY STATUS GUARD INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
