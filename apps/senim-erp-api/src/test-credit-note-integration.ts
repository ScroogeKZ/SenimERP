import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runCreditNoteTest() {
  console.log('=== STARTING CREDIT NOTE INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for CreditNote test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3005;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `cn_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_cn_manager',
      tenantId,
      email: 'cn@senim.kz',
      roles: ['ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Trigger schema provisioning
  console.log('[Test] Triggering on-demand schema provisioning...');
  const whRes = await fetch(`${baseUrl}/api/warehouses`, { headers: getAuthHeaders() });
  if (!whRes.ok) throw new Error(`GET /api/warehouses failed: ${await whRes.text()}`);
  const warehouses = await whRes.json();
  const defaultWarehouseId = warehouses[0]?.id || 'default-main-warehouse';

  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  const sku = `SKU-CN-${Date.now()}`;
  const customerId = `cust_cn_${Date.now()}`;
  const bin = `88${Math.floor(100000000 + Math.random() * 900000000)}`;
  const crmDealId = `deal_cn_${Date.now()}`;

  // Setup Customer
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'Кредит-Нота Клиент', '${bin}');
  `);

  // Initial Stock Receipt (100 units)
  await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku,
      quantity: 100,
      warehouseId: defaultWarehouseId,
      referenceId: 'REC-CN-01'
    })
  });

  // Setup Waybill (shipped: 10 units @ 10,000 KZT each, VAT 12% = 1,200, total = 11,200 per item, total bill = 112,000)
  const waybillId = `wb_cn_${Date.now()}`;
  const waybillNumber = `WAY-CN-${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", "warehouseId", amount, "vatAmount", status, "crmDealId")
    VALUES ('${waybillId}', '${waybillNumber}', '${customerId}', '${defaultWarehouseId}', 112000, 12000, 'DRAFT', '${crmDealId}');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."WaybillLineItem" (id, "waybillId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount", "discountAmount", "dealCurrency", "dealCurrencyPrice", "exchangeRate")
    VALUES ('line_cn_${Date.now()}', '${waybillId}', '${sku}', 'Ноутбук', 10, 10000, 12, 12000, 112000, 5000, 'USD', 20, 500);
  `);

  // Reserve stock & sign waybill
  await tenantClient.stockItem.update({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } },
    data: { reserved: 10 }
  });
  const signedXmlWb = `<signedXml><data>waybill_${waybillId}</data><signature iin="${bin}" bin="${bin}" name="Тест Клиент">SERIAL_WB</signature></signedXml>`;
  await fetch(`${baseUrl}/api/waybills/${waybillId}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml: signedXmlWb })
  });

  // Setup Invoice for the same crmDealId (amount = 112,000)
  const invoiceId = `inv_cn_${Date.now()}`;
  const invoiceNumber = `INV-CN-${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate", "crmDealId")
    VALUES ('${invoiceId}', '${invoiceNumber}', '${customerId}', 112000, 12000, 0, 'ISSUED', NOW(), '${crmDealId}');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."InvoiceLineItem" (id, "invoiceId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('inv_item_${Date.now()}', '${invoiceId}', '${sku}', 'Ноутбук', 10, 10000, 12, 12000, 112000);
  `);

  // Initial Debtors check
  console.log('[Test] Checking initial debtors balance...');
  let debtorsRes = await fetch(`${baseUrl}/api/debtors`, { headers: getAuthHeaders() });
  let debtors = await debtorsRes.json();
  let custDebtor = debtors.find((d: any) => d.customerId === customerId);
  console.log(`[Test] Initial debtor outstandingDebt=${custDebtor?.outstandingDebt}, totalBilled=${custDebtor?.totalBilled}`);
  if (Number(custDebtor?.outstandingDebt) !== 112000) {
    throw new Error(`Expected initial debt 112,000, got ${custDebtor?.outstandingDebt}`);
  }

  // --- Step 1: createRma snapshots price & VAT from WaybillLineItem ---
  console.log('[Test 1] Creating RMA for 2 returned units...');
  const createRmaRes = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      waybillId,
      reason: 'Дефект экрана',
      items: [{ sku, quantity: 2 }]
    })
  });
  if (!createRmaRes.ok) throw new Error(`createRma failed: ${await createRmaRes.text()}`);
  const rma = await createRmaRes.json();
  const rmaLine = rma.lines[0];
  console.log(`[Test 1 SUCCESS] RmaLine created: price=${rmaLine.price}, vatRate=${rmaLine.vatRate}, vatAmount=${rmaLine.vatAmount}, totalAmount=${rmaLine.totalAmount}`);
  if (Number(rmaLine.price) !== 10000 || Number(rmaLine.vatRate) !== 12 || Number(rmaLine.vatAmount) !== 2400 || Number(rmaLine.totalAmount) !== 22400) {
    throw new Error(`RmaLine price snapshot calculation invalid! Got price=${rmaLine.price}, total=${rmaLine.totalAmount}`);
  }

  // --- Step 2 & 3: confirmRma creates CreditNote in DRAFT status linked to Invoice via crmDealId ---
  console.log(`[Test 2 & 3] Confirming RMA ${rma.id}...`);
  const confirmRmaRes = await fetch(`${baseUrl}/api/rma/${rma.id}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!confirmRmaRes.ok) throw new Error(`confirmRma failed: ${await confirmRmaRes.text()}`);
  const confirmedData = await confirmRmaRes.json();
  const creditNote = confirmedData.creditNote;
  console.log(`[Test 2 & 3 SUCCESS] CreditNote created: number=${creditNote.number}, status=${creditNote.status}, amount=${creditNote.amount}, invoiceId=${creditNote.invoiceId}`);

  if (creditNote.status !== 'DRAFT') {
    throw new Error(`CreditNote must be created in DRAFT status. Got ${creditNote.status}`);
  }
  if (Number(creditNote.amount) !== 22400 || Number(creditNote.vatAmount) !== 2400) {
    throw new Error(`CreditNote amount calculation invalid! Expected 22400, got ${creditNote.amount}`);
  }
  if (creditNote.invoiceId !== invoiceId) {
    throw new Error(`CreditNote invoiceId expected ${invoiceId}, got ${creditNote.invoiceId}`);
  }

  // --- Step 5a: GET /api/debtors & BI reports — DRAFT CreditNote does NOT reduce debt/revenue ---
  console.log('[Test 5a] Checking debtors & reports with DRAFT CreditNote...');
  debtorsRes = await fetch(`${baseUrl}/api/debtors`, { headers: getAuthHeaders() });
  debtors = await debtorsRes.json();
  custDebtor = debtors.find((d: any) => d.customerId === customerId);
  console.log(`[Test 5a SUCCESS] Debtors while CreditNote is DRAFT: debt=${custDebtor?.outstandingDebt}`);
  if (Number(custDebtor?.outstandingDebt) !== 112000) {
    throw new Error(`DRAFT CreditNote should NOT reduce debt. Expected 112,000, got ${custDebtor?.outstandingDebt}`);
  }

  // Verify top-customers, top-products, discounts & currency-exposure remain unreduced during DRAFT status
  const topCustDraftRes = await fetch(`${baseUrl}/api/reports/top-customers`, { headers: getAuthHeaders() });
  const topCustDraft = await topCustDraftRes.json();
  const custDraftEntry = topCustDraft.find((c: any) => c.customerId === customerId);
  if (custDraftEntry?.totalRevenue !== 112000) {
    throw new Error(`DRAFT CreditNote should NOT reduce top-customers revenue. Expected 112,000, got ${custDraftEntry?.totalRevenue}`);
  }

  const topProdDraftRes = await fetch(`${baseUrl}/api/reports/top-products`, { headers: getAuthHeaders() });
  const topProdDraft = await topProdDraftRes.json();
  const prodDraftEntry = topProdDraft.find((p: any) => p.sku === sku);
  if (prodDraftEntry?.totalRevenue !== 112000 || prodDraftEntry?.totalQuantity !== 10) {
    throw new Error(`DRAFT CreditNote should NOT reduce top-products. Expected revenue 112,000 & qty 10, got: ${JSON.stringify(prodDraftEntry)}`);
  }

  const discountsDraftRes = await fetch(`${baseUrl}/api/reports/discounts`, { headers: getAuthHeaders() });
  const discountsDraft = await discountsDraftRes.json();
  const custDiscountDraft = discountsDraft.find((d: any) => d.customerId === customerId);
  if (custDiscountDraft?.totalDiscountAmount !== 5000) {
    throw new Error(`DRAFT CreditNote should NOT reduce discounts report. Expected 5,000, got ${custDiscountDraft?.totalDiscountAmount}`);
  }

  const currencyDraftRes = await fetch(`${baseUrl}/api/reports/currency-exposure`, { headers: getAuthHeaders() });
  const currencyDraft = await currencyDraftRes.json();
  const usdDraft = currencyDraft.find((c: any) => c.currency === 'USD');
  if (usdDraft?.totalKztAmount !== 112000 || usdDraft?.totalForeignCurrencyAmount !== 200) {
    throw new Error(`DRAFT CreditNote should NOT reduce currency-exposure. Expected KZT 112,000 & USD 200, got: ${JSON.stringify(usdDraft)}`);
  }
  console.log('[Test 5a SUCCESS] DRAFT CreditNote correctly ignored in top-customers, top-products, discounts & currency-exposure reports.');

  // --- Step 4: POST /api/credit-notes/:id/sign moves status to ISSUED, creates signature & ESF ---
  console.log(`[Test 4] Signing CreditNote ${creditNote.id}...`);
  const signedXmlCn = `<signedXml><data>credit_note_${creditNote.id}</data><signature iin="${bin}" bin="${bin}" name="Главный Бухгалтер">SERIAL_CN_SIGN</signature></signedXml>`;
  const signCnRes = await fetch(`${baseUrl}/api/credit-notes/${creditNote.id}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml: signedXmlCn })
  });
  if (!signCnRes.ok) throw new Error(`signCreditNote failed: ${await signCnRes.text()}`);
  const signedCn = await signCnRes.json();
  console.log(`[Test 4 SUCCESS] CreditNote signed: status=${signedCn.status}, signature=${signedCn.signature?.signedBy}, esfDocument=${signedCn.esfDocument?.status}`);
  if (signedCn.status !== 'ISSUED' || !signedCn.signature || !signedCn.esfDocument) {
    throw new Error('CreditNote sign assertion failed!');
  }

  // --- Step 5b: GET /api/debtors & BI reports — ISSUED CreditNote reduces debt/revenue ---
  console.log('[Test 5b] Checking debtors & reports with ISSUED CreditNote...');
  debtorsRes = await fetch(`${baseUrl}/api/debtors`, { headers: getAuthHeaders() });
  debtors = await debtorsRes.json();
  custDebtor = debtors.find((d: any) => d.customerId === customerId);
  console.log(`[Test 5b SUCCESS] Debtors after CreditNote ISSUED: totalBilled=${custDebtor?.totalBilled}, totalCredited=${custDebtor?.totalCredited}, outstandingDebt=${custDebtor?.outstandingDebt}`);
  if (Number(custDebtor?.totalCredited) !== 22400 || Number(custDebtor?.outstandingDebt) !== 89600) {
    throw new Error(`ISSUED CreditNote should reduce debt to 89,600 (112,000 - 22,400). Got ${custDebtor?.outstandingDebt}`);
  }

  // Verify top-customers, top-products, discounts & currency-exposure deduct ISSUED CreditNote
  const topCustIssuedRes = await fetch(`${baseUrl}/api/reports/top-customers`, { headers: getAuthHeaders() });
  const topCustIssued = await topCustIssuedRes.json();
  const custIssuedEntry = topCustIssued.find((c: any) => c.customerId === customerId);
  if (custIssuedEntry?.totalRevenue !== 89600) {
    throw new Error(`ISSUED CreditNote should reduce top-customers revenue to 89,600 (112,000 - 22,400). Got ${custIssuedEntry?.totalRevenue}`);
  }

  const topProdIssuedRes = await fetch(`${baseUrl}/api/reports/top-products`, { headers: getAuthHeaders() });
  const topProdIssued = await topProdIssuedRes.json();
  const prodIssuedEntry = topProdIssued.find((p: any) => p.sku === sku);
  if (prodIssuedEntry?.totalRevenue !== 89600 || prodIssuedEntry?.totalQuantity !== 8) {
    throw new Error(`ISSUED CreditNote should reduce top-products. Expected revenue 89,600 & qty 8, got: ${JSON.stringify(prodIssuedEntry)}`);
  }

  const discountsIssuedRes = await fetch(`${baseUrl}/api/reports/discounts`, { headers: getAuthHeaders() });
  const discountsIssued = await discountsIssuedRes.json();
  const custDiscountIssued = discountsIssued.find((d: any) => d.customerId === customerId);
  if (custDiscountIssued?.totalDiscountAmount !== 4000) {
    throw new Error(`ISSUED CreditNote should reduce discounts report proportionally to 4,000 (5,000 - 1,000). Got ${custDiscountIssued?.totalDiscountAmount}`);
  }

  const currencyIssuedRes = await fetch(`${baseUrl}/api/reports/currency-exposure`, { headers: getAuthHeaders() });
  const currencyIssued = await currencyIssuedRes.json();
  const usdIssued = currencyIssued.find((c: any) => c.currency === 'USD');
  if (usdIssued?.totalKztAmount !== 89600 || usdIssued?.totalForeignCurrencyAmount !== 160) {
    throw new Error(`ISSUED CreditNote should reduce currency-exposure. Expected KZT 89,600 & USD 160, got: ${JSON.stringify(usdIssued)}`);
  }
  console.log('[Test 5b SUCCESS] ISSUED CreditNote correctly deducted from top-customers, top-products, discounts & currency-exposure reports!');

  // --- Step 6: GET /api/reports/revenue-trend reflects returns and netRevenue ---
  console.log('[Test 6] Checking revenue trend report...');
  const trendRes = await fetch(`${baseUrl}/api/reports/revenue-trend?granularity=month`, { headers: getAuthHeaders() });
  if (!trendRes.ok) throw new Error(`revenue-trend failed: ${await trendRes.text()}`);
  const trend = await trendRes.json();
  console.log('[Test 6] Revenue trend data:', JSON.stringify(trend));
  const currentPeriod = trend[0];
  if (!currentPeriod || currentPeriod.revenue !== 112000 || currentPeriod.returns !== 22400 || currentPeriod.netRevenue !== 89600) {
    throw new Error(`Revenue trend assertion failed! Expected revenue=112000, returns=22400, netRevenue=89600. Got: ${JSON.stringify(currentPeriod)}`);
  }
  console.log('[Test 6 SUCCESS] Revenue trend verified: gross(112,000) - returns(22,400) = netRevenue(89,600)');

  // Extra check: Unlinked invoice CreditNote (crmDealId missing)
  console.log('[Extra Test] Testing CreditNote creation when Invoice is unlinked...');
  const waybillNoInvId = `wb_noinv_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", "warehouseId", amount, "vatAmount", status)
    VALUES ('${waybillNoInvId}', 'WAY-NOINV-01', '${customerId}', '${defaultWarehouseId}', 11200, 1200, 'DELIVERED');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."WaybillLineItem" (id, "waybillId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('line_noinv_${Date.now()}', '${waybillNoInvId}', '${sku}', 'Ноутбук', 1, 10000, 12, 1200, 11200);
  `);
  const rmaNoInvRes = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ waybillId: waybillNoInvId, items: [{ sku, quantity: 1 }] })
  });
  const rmaNoInv = await rmaNoInvRes.json();
  const confirmNoInvRes = await fetch(`${baseUrl}/api/rma/${rmaNoInv.id}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  const confirmNoInvData = await confirmNoInvRes.json();
  console.log(`[Extra Test SUCCESS] Unlinked CreditNote created without error: invoiceId=${confirmNoInvData.creditNote.invoiceId} (null as expected)`);
  if (confirmNoInvData.creditNote.invoiceId !== null) {
    throw new Error(`Unlinked CreditNote should have invoiceId=null, got ${confirmNoInvData.creditNote.invoiceId}`);
  }

  // Defect 1 check: RBAC 403 Forbidden assertion for unauthorized role on GET /api/credit-notes
  console.log('[Defect 1 Test] Testing RBAC restriction on GET /api/credit-notes for unauthorized role...');
  const unauthorizedToken = signSsoToken({
    sub: 'usr_unauthorized',
    tenantId,
    email: 'unauthorized@senim.kz',
    roles: ['CRM_MANAGER']
  });
  const forbiddenRes = await fetch(`${baseUrl}/api/credit-notes`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${unauthorizedToken}` }
  });
  if (forbiddenRes.status !== 403) {
    throw new Error(`Expected HTTP 403 Forbidden for unauthorized role on GET /api/credit-notes, got ${forbiddenRes.status}`);
  }
  console.log('[Defect 1 Test SUCCESS] GET /api/credit-notes correctly rejected unauthorized role with HTTP 403 Forbidden.');

  // Defect 2 check: Foreign Key constraint assertion on DocumentSignature & EsfDocument
  console.log('[Defect 2 Test] Testing Foreign Key constraint on DocumentSignature and EsfDocument...');
  let fkErrorOccurred = false;
  try {
    await tenantClient.$executeRawUnsafe(`
      INSERT INTO "${schemaName}"."DocumentSignature" (id, "creditNoteId", "signedBy", iin, "certSerial")
      VALUES ('sig_invalid_fk', 'non_existent_cn_id', 'Test', '123456789012', 'SERIAL');
    `);
  } catch (e: any) {
    fkErrorOccurred = true;
    console.log('[Defect 2 Test SUCCESS] FK violation caught on DocumentSignature insert with invalid creditNoteId.');
  }
  if (!fkErrorOccurred) {
    throw new Error('FK constraint on DocumentSignature.creditNoteId is missing! Insertion of invalid FK succeeded!');
  }

  // --- Test: Legacy RmaLine Migration & Null Price Fallback ---
  console.log('[RmaLine Migration Test] Testing legacy RmaLine with 0.00 values corrected by migration script...');
  const legacyWaybillId = `wb_legacy_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", "warehouseId", amount, "vatAmount", status)
    VALUES ('${legacyWaybillId}', 'WAY-LEGACY-01', '${customerId}', '${defaultWarehouseId}', 22400, 2400, 'DELIVERED');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."WaybillLineItem" (id, "waybillId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('line_legacy_${Date.now()}', '${legacyWaybillId}', '${sku}', 'Старый Товар', 2, 10000, 12, 2400, 22400);
  `);
  const legacyRmaId = `rma_legacy_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Rma" (id, number, "waybillId", reason, status)
    VALUES ('${legacyRmaId}', 'RMA-LEG-001', '${legacyWaybillId}', 'Возврат старого товара', 'DRAFT');
  `);

  // Simulate buggy migration data: price, vatRate, vatAmount, totalAmount were inserted as 0.00
  const legacyRmaLineId = `rmaline_legacy_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."RmaLine" (id, "rmaId", sku, "warehouseId", quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('${legacyRmaLineId}', '${legacyRmaId}', '${sku}', '${defaultWarehouseId}', 2, 0.00, 0.00, 0.00, 0.00);
  `);

  // Execute corrective migration UPDATE query
  await tenantClient.$executeRawUnsafe(`
    UPDATE "${schemaName}"."RmaLine"
    SET price = NULL, "vatRate" = NULL, "vatAmount" = NULL, "totalAmount" = NULL
    WHERE price = 0.00 AND "vatRate" = 0.00 AND "vatAmount" = 0.00 AND "totalAmount" = 0.00;
  `);

  // Confirm legacy RMA
  const confirmLegacyRes = await fetch(`${baseUrl}/api/rma/${legacyRmaId}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!confirmLegacyRes.ok) throw new Error(`confirmRma for legacy RMA failed: ${await confirmLegacyRes.text()}`);
  const confirmLegacyData = await confirmLegacyRes.json();
  const legacyCreditNote = confirmLegacyData.creditNote;
  console.log(`[RmaLine Migration Test SUCCESS] Legacy CreditNote created: amount=${legacyCreditNote.amount}, vatAmount=${legacyCreditNote.vatAmount}`);

  if (Number(legacyCreditNote.amount) !== 22400 || Number(legacyCreditNote.vatAmount) !== 2400) {
    throw new Error(`Legacy CreditNote amount should use WaybillLineItem price fallback (22400), but got ${legacyCreditNote.amount}!`);
  }

  await tenantClient.$disconnect();
  console.log('=== CREDIT NOTE INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runCreditNoteTest().catch((err) => {
  console.error('=== CREDIT NOTE INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
