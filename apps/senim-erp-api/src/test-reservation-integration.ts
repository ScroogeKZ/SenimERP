import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';

async function runReservationTest() {
  console.log('=== STARTING STOCK RESERVATION LIFECYCLE INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `res_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_res_accountant',
      tenantId,
      email: 'res@senim.kz',
      roles: ['ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Trigger schema provisioning via API request
  console.log('[Test] Triggering on-demand schema provisioning...');
  const whRes = await fetch(`${baseUrl}/api/warehouses`, { headers: getAuthHeaders() });
  if (!whRes.ok) throw new Error(`GET /api/warehouses failed: ${await whRes.text()}`);
  const warehouses = await whRes.json();
  const defaultWarehouseId = warehouses[0]?.id || 'default-main-warehouse';

  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  const sku = `SKU-RES-${Date.now()}`;

  // Step 1: Initial Receipt of 50 units
  console.log(`[Test 1] Executing receipt of 50 units for ${sku}...`);
  const receiptRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku,
      quantity: 50,
      warehouseId: defaultWarehouseId,
      referenceId: 'REC-RES-01'
    })
  });
  if (!receiptRes.ok) throw new Error(`Receipt failed: ${await receiptRes.text()}`);

  let stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 1 SUCCESS] Initial Stock: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 50 || Number(stock?.reserved) !== 0) {
    throw new Error(`Expected quantity 50, reserved 0. Got: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  }

  // Step 2: Simulate deal.won event creation of Waybill 1 for 20 units
  console.log('[Test 2] Simulating deal.won event for 20 units (Waybill 1 creation)...');
  const eventConsumer = app.get(EventConsumerService);

  const customerId = `cust_res_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;

  await eventConsumer.handleDealWon({
    eventId: `evt_res_1_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: `deal_res_1_${Date.now()}`,
      customerId,
      customerName: 'Тест Резерв Клиент',
      customerBin: bin,
      amount: 20000,
      items: [
        { sku, crmProductId: 'prod_1', name: 'Резервируемый Товар', quantity: 20, price: 1000 }
      ]
    }
  });

  const waybill1 = await tenantClient.waybill.findFirst({
    where: { crmDealId: { startsWith: 'deal_res_1_' } },
    orderBy: { createdAt: 'desc' }
  });
  if (!waybill1) throw new Error('Waybill 1 creation failed');

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 2 SUCCESS] After Waybill 1 creation: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 50 || Number(stock?.reserved) !== 20) {
    throw new Error(`Expected quantity 50, reserved 20. Got: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  }

  // Step 3: Sign Waybill 1 -> status DELIVERED, quantity=30, reserved=0
  console.log(`[Test 3] Signing Waybill 1 (${waybill1.id})...`);
  const signedXml = `<signedXml><data>waybill_${waybill1.id}</data><signature iin="${bin}" bin="${bin}" name="Иванов И.И.">SERIAL_TEST_RES_1</signature></signedXml>`;
  const signRes = await fetch(`${baseUrl}/api/waybills/${waybill1.id}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml })
  });
  if (!signRes.ok) throw new Error(`Sign waybill 1 failed: ${await signRes.text()}`);

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 3 SUCCESS] After Waybill 1 sign: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 30 || Number(stock?.reserved) !== 0) {
    throw new Error(`Expected quantity 30, reserved 0. Got: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  }

  // Step 4: Create Waybill 2 for 15 units -> quantity=30, reserved=15
  console.log('[Test 4] Simulating deal.won event for 15 units (Waybill 2 creation)...');
  const deal2Id = `deal_res_2_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_res_2_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal2Id,
      customerId,
      customerName: 'Тест Резерв Клиент',
      customerBin: bin,
      amount: 15000,
      items: [
        { sku, crmProductId: 'prod_1', name: 'Резервируемый Товар', quantity: 15, price: 1000 }
      ]
    }
  });

  const waybill2 = await tenantClient.waybill.findFirst({
    where: { crmDealId: deal2Id },
    orderBy: { createdAt: 'desc' }
  });
  if (!waybill2) throw new Error('Waybill 2 creation failed');

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 4 SUCCESS] After Waybill 2 creation: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 30 || Number(stock?.reserved) !== 15) {
    throw new Error(`Expected quantity 30, reserved 15. Got: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  }

  // Step 5: Cancel Waybill 2 -> status CANCELLED, quantity=30, reserved=0
  console.log(`[Test 5] Cancelling draft Waybill 2 (${waybill2.id})...`);
  const cancelRes = await fetch(`${baseUrl}/api/waybills/${waybill2.id}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!cancelRes.ok) throw new Error(`Cancel waybill 2 failed: ${await cancelRes.text()}`);

  stock = await tenantClient.stockItem.findUnique({
    where: { sku_warehouseId: { sku, warehouseId: defaultWarehouseId } }
  });
  console.log(`[Test 5 SUCCESS] After Waybill 2 cancel: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  if (Number(stock?.quantity) !== 30 || Number(stock?.reserved) !== 0) {
    throw new Error(`Expected quantity 30, reserved 0. Got: quantity=${stock?.quantity}, reserved=${stock?.reserved}`);
  }

  // Step 6: Attempting to cancel already DELIVERED Waybill 1 -> expected 400 Bad Request
  console.log(`[Test 6] Attempting to cancel already DELIVERED Waybill 1 (${waybill1.id})...`);
  const invalidCancelRes = await fetch(`${baseUrl}/api/waybills/${waybill1.id}/cancel`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (invalidCancelRes.ok) {
    throw new Error('Cancelling a DELIVERED waybill was expected to fail, but succeeded!');
  }
  const invalidCancelErr = await invalidCancelRes.json();
  console.log(`[Test 6 SUCCESS] Invalid cancel correctly rejected with HTTP ${invalidCancelRes.status}: ${JSON.stringify(invalidCancelErr)}`);

  await tenantClient.$disconnect();
  console.log('=== STOCK RESERVATION LIFECYCLE INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runReservationTest().catch((err) => {
  console.error('=== STOCK RESERVATION LIFECYCLE INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
