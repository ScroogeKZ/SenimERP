import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runPaymentSecurityTest() {
  console.log('=== STARTING PAYMENT SECURITY & CONCURRENCY PROTECTION INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for payment security test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `pay_sec_tenant_${Date.now()}`;
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
  // SECTION 1: Client Invoice (AR) Security & Payment History Tests
  // =========================================================================
  console.log('\n--- SECTION 1: Client Invoice (AR) Security & Payment History ---');

  const customerId = `cust_ar_${Date.now()}`;
  const inv1Id = `inv_ar_1_${Date.now()}`;
  const invCancelId = `inv_ar_cancel_${Date.now()}`;

  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'ТОО "Покупатель"', '880102030405');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${inv1Id}', 'INV-AR-001', '${customerId}', 100000, 12000, 0, 'DRAFT', NOW());
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${invCancelId}', 'INV-AR-CANCEL', '${customerId}', 50000, 6000, 0, 'CANCELLED', NOW());
  `);

  // 1.1 Partial Payment (60,000 KZT) with method & referenceId
  console.log('[AR Test 1.1] Paying 60,000 KZT on 100,000 KZT invoice...');
  const pay1Res = await fetch(`${baseUrl}/api/invoices/${inv1Id}/pay`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      amount: 60000,
      method: 'bank_transfer',
      referenceId: 'PAY-REF-101'
    })
  });
  if (!pay1Res.ok) throw new Error(`Partial payment failed: ${await pay1Res.text()}`);
  const pay1Invoice = await pay1Res.json();
  console.log(`[AR Test 1.1 SUCCESS] Paid 60,000: status=${pay1Invoice.status}, paidAmount=${pay1Invoice.paidAmount}, paymentsCount=${pay1Invoice.payments?.length}`);
  if (pay1Invoice.status !== 'PARTIALLY_PAID' || Number(pay1Invoice.paidAmount) !== 60000 || pay1Invoice.payments?.length !== 1) {
    throw new Error(`Unexpected AR payment 1 result: ${JSON.stringify(pay1Invoice)}`);
  }

  // 1.2 Overpayment attempt (50,000 KZT when only 40,000 KZT is remaining)
  console.log('[AR Test 1.2] Attempting overpayment (50,000 KZT on 40,000 KZT remaining balance)...');
  const overpayRes = await fetch(`${baseUrl}/api/invoices/${inv1Id}/pay`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ amount: 50000 })
  });
  if (overpayRes.ok) {
    throw new Error('Overpayment request succeeded when it should have been rejected!');
  }
  const overpayErr = await overpayRes.json();
  console.log(`[AR Test 1.2 SUCCESS] Overpayment rejected with HTTP ${overpayRes.status}: ${JSON.stringify(overpayErr)}`);

  // 1.3 Payment on CANCELLED invoice attempt
  console.log('[AR Test 1.3] Attempting payment on CANCELLED invoice...');
  const cancelPayRes = await fetch(`${baseUrl}/api/invoices/${invCancelId}/pay`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ amount: 10000 })
  });
  if (cancelPayRes.ok) {
    throw new Error('Cancelled invoice payment succeeded when it should have been rejected!');
  }
  const cancelPayErr = await cancelPayRes.json();
  console.log(`[AR Test 1.3 SUCCESS] Cancelled invoice payment rejected with HTTP ${cancelPayRes.status}: ${JSON.stringify(cancelPayErr)}`);

  // 1.4 Final Payment (40,000 KZT) -> reaches PAID
  console.log('[AR Test 1.4] Paying remaining 40,000 KZT on 100,000 KZT invoice...');
  const pay2Res = await fetch(`${baseUrl}/api/invoices/${inv1Id}/pay`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      amount: 40000,
      method: 'cash',
      referenceId: 'PAY-REF-102'
    })
  });
  if (!pay2Res.ok) throw new Error(`Final payment failed: ${await pay2Res.text()}`);
  const pay2Invoice = await pay2Res.json();
  console.log(`[AR Test 1.4 SUCCESS] Paid remaining 40,000: status=${pay2Invoice.status}, paidAmount=${pay2Invoice.paidAmount}, paymentsCount=${pay2Invoice.payments?.length}`);
  if (pay2Invoice.status !== 'PAID' || Number(pay2Invoice.paidAmount) !== 100000 || pay2Invoice.payments?.length !== 2) {
    throw new Error(`Unexpected AR payment 2 result: ${JSON.stringify(pay2Invoice)}`);
  }

  // =========================================================================
  // SECTION 2: Supplier Invoice (AP) TOCTOU Concurrency Test
  // =========================================================================
  console.log('\n--- SECTION 2: Supplier Invoice (AP) TOCTOU Concurrency Protection ---');

  const supplierId = `sup_ap_${Date.now()}`;
  const suppInvId = `supp_inv_conc_${Date.now()}`;

  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Supplier" (id, name, bin) VALUES ('${supplierId}', 'ТОО "Поставщик"', '770102030405');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."SupplierInvoice" (id, number, "supplierId", amount, "paidAmount", status)
    VALUES ('${suppInvId}', 'SUP-INV-CONC-01', '${supplierId}', 200000, 0, 'UNPAID');
  `);

  console.log('[AP Test 2.1] Firing 5 SIMULTANEOUS payment requests of 100,000 KZT each on 200,000 KZT SupplierInvoice...');
  const concurrentPayRequests = Array.from({ length: 5 }, (_, i) =>
    fetch(`${baseUrl}/api/supplier-invoices/${suppInvId}/pay`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        amount: 100000,
        method: 'banking',
        referenceId: `CONC-REF-${i + 1}`
      })
    })
  );

  const responses = await Promise.all(concurrentPayRequests);
  const successResponses = responses.filter((r) => r.ok);
  const rejectedResponses = responses.filter((r) => !r.ok);

  console.log(`[AP Test 2.1] Concurrent responses received: ${successResponses.length} succeeded, ${rejectedResponses.length} rejected.`);

  if (successResponses.length !== 2 || rejectedResponses.length !== 3) {
    throw new Error(`Expected exactly 2 succeeded and 3 rejected requests, but got ${successResponses.length} succeeded and ${rejectedResponses.length} rejected!`);
  }

  // Verify final SupplierInvoice state in database
  const finalSuppInvoiceRes = await fetch(`${baseUrl}/api/supplier-invoices/${suppInvId}`, {
    headers: getAuthHeaders()
  });
  const finalSuppInvoice = await finalSuppInvoiceRes.json();

  console.log(`[AP Test 2.1 SUCCESS] Final SupplierInvoice paidAmount=${finalSuppInvoice.paidAmount}, status=${finalSuppInvoice.status}, paymentsCount=${finalSuppInvoice.payments?.length}`);
  if (Number(finalSuppInvoice.paidAmount) !== 200000 || finalSuppInvoice.status !== 'PAID' || finalSuppInvoice.payments?.length !== 2) {
    throw new Error(`AP Concurrency Test failed! Expected paidAmount=200000, status=PAID, 2 payments. Got ${JSON.stringify(finalSuppInvoice)}`);
  }

  await tenantClient.$disconnect();

  console.log('\n=== PAYMENT SECURITY & CONCURRENCY PROTECTION INTEGRATION TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runPaymentSecurityTest().catch((err) => {
  console.error('=== PAYMENT SECURITY & CONCURRENCY PROTECTION INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
