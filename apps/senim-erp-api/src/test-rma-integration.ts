import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runRmaTest() {
  console.log('=== STARTING RMA (RETURNS) INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for RMA test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `rma_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_rma_manager',
      tenantId,
      email: 'rma@senim.kz',
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

  const sku = `SKU-RMA-${Date.now()}`;

  // Step 1: Initial stock receipt (50 units)
  console.log(`[Test 1] Receiving 50 units of ${sku}...`);
  const receiptRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku,
      quantity: 50,
      warehouseId: defaultWarehouseId,
      referenceId: 'REC-RMA-01'
    })
  });
  if (!receiptRes.ok) throw new Error(`Receipt failed: ${await receiptRes.text()}`);

  // Step 2: Setup Customer & Waybill (shipped: 20 units), then Sign Waybill -> DELIVERED (quantity=30)
  console.log('[Test 2] Creating and signing Waybill (shipping 20 units)...');
  const customerId = `cust_rma_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;

  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'РМА Клиент', '${bin}');
  `);

  const waybillId = `wb_rma_${Date.now()}`;
  const waybillNumber = `WAY-RMA-${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", "warehouseId", amount, "vatAmount", status)
    VALUES ('${waybillId}', '${waybillNumber}', '${customerId}', '${defaultWarehouseId}', 20000, 2400, 'DRAFT');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."WaybillLineItem" (id, "waybillId", sku, name, quantity, price, "vatRate", "vatAmount", "totalAmount")
    VALUES ('line_${Date.now()}', '${waybillId}', '${sku}', 'РМА Товар', 20, 1000, 12, 2400, 22400);
  `);

  // Reserve stock for draft waybill
  await tenantClient.stockItem.update({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } },
    data: { reserved: 20 }
  });

  // Sign Waybill -> DELIVERED
  const signedXml = `<signedXml><data>waybill_${waybillId}</data><signature iin="${bin}" bin="${bin}" name="Иванов И.">SERIAL_RMA_SIGN</signature></signedXml>`;
  const signRes = await fetch(`${baseUrl}/api/waybills/${waybillId}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml })
  });
  if (!signRes.ok) throw new Error(`Sign waybill failed: ${await signRes.text()}`);

  let stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 2 SUCCESS] Waybill DELIVERED. Stock: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 30 || Number(stock?.reserved) !== 0) {
    throw new Error(`Expected quantity 30, reserved 0. Got quantity=${stock?.quantity}`);
  }

  // Step 3: Create DRAFT RMA 1 for 10 units -> stock remains quantity=30
  console.log('[Test 3] Creating DRAFT RMA 1 for 10 units...');
  const rma1Res = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      waybillId,
      reason: 'Брак упаковки',
      items: [{ sku, quantity: 10 }]
    })
  });
  if (!rma1Res.ok) throw new Error(`Create RMA 1 failed: ${await rma1Res.text()}`);
  const rma1 = await rma1Res.json();
  console.log(`[Test 3 SUCCESS] DRAFT RMA 1 created: ${rma1.number}, status=${rma1.status}`);

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  if (Number(stock?.quantity) !== 30) {
    throw new Error(`Stock quantity should not change on DRAFT RMA. Expected 30, got ${stock?.quantity}`);
  }

  // Step 4: Over-return validation -> attempt to create another RMA for 15 units (10 existing + 15 > 20 shipped)
  console.log('[Test 4] Testing over-return protection (requesting 15 units when 10 are already in RMA 1 out of 20 shipped)...');
  const overReturnRes = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      waybillId,
      reason: 'Превышение количества',
      items: [{ sku, quantity: 15 }]
    })
  });
  if (overReturnRes.ok) {
    throw new Error('Over-return was expected to be rejected, but succeeded!');
  }
  const overReturnErr = await overReturnRes.json();
  console.log(`[Test 4 SUCCESS] Over-return rejected with HTTP ${overReturnRes.status}: ${JSON.stringify(overReturnErr)}`);

  // Step 5: Confirm RMA 1 -> status CONFIRMED, stock quantity increases to 40
  console.log(`[Test 5] Confirming RMA 1 (${rma1.id})...`);
  const confirmRes = await fetch(`${baseUrl}/api/rma/${rma1.id}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!confirmRes.ok) throw new Error(`Confirm RMA 1 failed: ${await confirmRes.text()}`);

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 5 SUCCESS] Stock after RMA 1 confirmation: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 40) {
    throw new Error(`Expected quantity 40 after return. Got ${stock?.quantity}`);
  }

  // Step 6: Create DRAFT RMA 2 for 5 units and cancel it -> status CANCELLED, stock remains quantity=40
  console.log('[Test 6] Creating and cancelling DRAFT RMA 2 for 5 units...');
  const rma2Res = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      waybillId,
      reason: 'Ошибка ввода',
      items: [{ sku, quantity: 5 }]
    })
  });
  if (!rma2Res.ok) throw new Error(`Create RMA 2 failed: ${await rma2Res.text()}`);
  const rma2 = await rma2Res.json();

  const cancelRes = await fetch(`${baseUrl}/api/rma/${rma2.id}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!cancelRes.ok) throw new Error(`Cancel RMA 2 failed: ${await cancelRes.text()}`);
  console.log('[Test 6 SUCCESS] DRAFT RMA 2 successfully cancelled.');

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  if (Number(stock?.quantity) !== 40) {
    throw new Error(`Stock quantity should remain 40 after RMA cancellation. Got ${stock?.quantity}`);
  }

  // Step 7: Strict Atomic Status Guard Rejection Tests
  console.log('[Test 7] Running strict atomic status guard rejection assertions...');

  // 7a: Confirm an already CONFIRMED RMA (rma1)
  console.log('  [7a] Confirming already CONFIRMED RMA 1...');
  const confirmAgainRes = await fetch(`${baseUrl}/api/rma/${rma1.id}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (confirmAgainRes.ok) throw new Error('Confirming an already CONFIRMED RMA should fail!');
  console.log(`  [7a SUCCESS] Rejected with HTTP ${confirmAgainRes.status}: ${(await confirmAgainRes.json()).message}`);

  // 7b: Confirm an already CANCELLED RMA (rma2)
  console.log('  [7b] Confirming already CANCELLED RMA 2...');
  const confirmCancelledRes = await fetch(`${baseUrl}/api/rma/${rma2.id}/confirm`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (confirmCancelledRes.ok) throw new Error('Confirming an already CANCELLED RMA should fail!');
  console.log(`  [7b SUCCESS] Rejected with HTTP ${confirmCancelledRes.status}: ${(await confirmCancelledRes.json()).message}`);

  // 7c: Cancel an already CONFIRMED RMA (rma1)
  console.log('  [7c] Cancelling already CONFIRMED RMA 1...');
  const cancelConfirmedRes = await fetch(`${baseUrl}/api/rma/${rma1.id}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (cancelConfirmedRes.ok) throw new Error('Cancelling an already CONFIRMED RMA should fail!');
  console.log(`  [7c SUCCESS] Rejected with HTTP ${cancelConfirmedRes.status}: ${(await cancelConfirmedRes.json()).message}`);

  // 7d: Cancel an already CANCELLED RMA (rma2)
  console.log('  [7d] Cancelling already CANCELLED RMA 2...');
  const cancelCancelledRes = await fetch(`${baseUrl}/api/rma/${rma2.id}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (cancelCancelledRes.ok) throw new Error('Cancelling an already CANCELLED RMA should fail!');
  console.log(`  [7d SUCCESS] Rejected with HTTP ${cancelCancelledRes.status}: ${(await cancelCancelledRes.json()).message}`);

  // 7e: Attempt to create RMA for non-DELIVERED waybill
  console.log('  [7e] Attempting RMA creation for non-DELIVERED (DRAFT) waybill...');
  const draftWaybillId = `wb_draft_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Waybill" (id, number, "customerId", "warehouseId", amount, "vatAmount", status)
    VALUES ('${draftWaybillId}', 'WAY-DRAFT-TEST', '${customerId}', '${defaultWarehouseId}', 10000, 1200, 'DRAFT');
  `);
  const draftRmaRes = await fetch(`${baseUrl}/api/rma`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      waybillId: draftWaybillId,
      items: [{ sku, quantity: 5 }]
    })
  });
  if (draftRmaRes.ok) throw new Error('RMA for non-DELIVERED waybill should fail!');
  console.log(`  [7e SUCCESS] Rejected with HTTP ${draftRmaRes.status}: ${(await draftRmaRes.json()).message}`);

  await tenantClient.$disconnect();
  console.log('=== RMA (RETURNS) INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runRmaTest().catch((err) => {
  console.error('=== RMA (RETURNS) INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
