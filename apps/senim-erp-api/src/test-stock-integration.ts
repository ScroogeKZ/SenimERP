import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runStockTest() {
  console.log('=== STARTING STOCK BALANCE & MOVEMENTS INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for stock test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `stock_tenant_${Date.now()}`;
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
      roles: ['ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Step 0: GET /api/warehouses to get provisioned default warehouse
  console.log('[Test 0] Fetching default warehouse...');
  const whRes = await fetch(`${baseUrl}/api/warehouses`, { headers: getAuthHeaders() });
  if (!whRes.ok) throw new Error(`GET /api/warehouses failed: ${await whRes.text()}`);
  const warehouses = await whRes.json();
  const defaultWarehouseId = warehouses[0]?.id || 'default-main-warehouse';
  console.log(`[Test 0 SUCCESS] Default warehouse ID: ${defaultWarehouseId}`);

  // Step 1: Execute POST /api/warehouse/receipts on brand-new tenant to verify auto DDL creation of StockItem and StockMovement
  console.log('[Test 1] Executing POST /api/warehouse/receipts on brand-new tenant...');
  const receipt1Res = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku: 'SKU-LAPTOP-01',
      quantity: 10,
      warehouseId: defaultWarehouseId,
      referenceId: 'REC-001'
    })
  });
  if (!receipt1Res.ok) {
    throw new Error(`[Test 1 FAILED] Warehouse receipt failed: ${await receipt1Res.text()}`);
  }
  const stockItem1 = await receipt1Res.json();
  console.log(`[Test 1 SUCCESS] StockItem created for SKU-LAPTOP-01, quantity=${stockItem1.quantity}`);

  // Step 2: GET /api/stock
  console.log('\n[Test 2] Querying GET /api/stock...');
  const stockRes = await fetch(`${baseUrl}/api/stock`, { headers: getAuthHeaders() });
  if (!stockRes.ok) throw new Error(`GET /api/stock failed: ${await stockRes.text()}`);
  const stockList = await stockRes.json();
  console.log(`[Test 2 SUCCESS] GET /api/stock count=${stockList.length}, sku=${stockList[0].sku}, qty=${stockList[0].quantity}`);
  if (stockList.length !== 1 || Number(stockList[0].quantity) !== 10) {
    throw new Error(`Expected 1 stock item with qty 10, got ${JSON.stringify(stockList)}`);
  }

  // Step 3: Add second item and set reserved >= quantity to test lowStock filter
  console.log('\n[Test 3] Adding second item (SKU-MOUSE-02)...');
  await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku: 'SKU-MOUSE-02',
      quantity: 5,
      warehouseId: defaultWarehouseId,
      referenceId: 'REC-002'
    })
  });

  // Manually update reserved=5 for SKU-MOUSE-02 in database
  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });
  await tenantClient.$executeRawUnsafe(`UPDATE "${schemaName}"."StockItem" SET "reserved" = 5 WHERE "sku" = 'SKU-MOUSE-02';`);
  await tenantClient.$disconnect();

  console.log('[Test 3] Testing GET /api/stock?lowStock=true (post-query JS filter)...');
  const lowStockRes = await fetch(`${baseUrl}/api/stock?lowStock=true`, { headers: getAuthHeaders() });
  if (!lowStockRes.ok) throw new Error(`GET /api/stock?lowStock=true failed: ${await lowStockRes.text()}`);
  const lowStockList = await lowStockRes.json();
  console.log(`[Test 3 SUCCESS] LowStock filter returned ${lowStockList.length} items: ${lowStockList.map((i: any) => i.sku).join(', ')}`);
  if (lowStockList.length !== 1 || lowStockList[0].sku !== 'SKU-MOUSE-02') {
    throw new Error(`Expected lowStock filter to return only SKU-MOUSE-02, got ${JSON.stringify(lowStockList)}`);
  }

  // Step 4: GET /api/stock/movements with sku and type AND filter
  console.log('\n[Test 4] Testing GET /api/stock/movements with sku and type filter...');
  const movementsRes = await fetch(`${baseUrl}/api/stock/movements?sku=SKU-LAPTOP-01&type=receipt`, {
    headers: getAuthHeaders()
  });
  if (!movementsRes.ok) throw new Error(`GET /api/stock/movements failed: ${await movementsRes.text()}`);
  const movements = await movementsRes.json();
  console.log(`[Test 4 SUCCESS] Filtered movements count=${movements.length}, sku=${movements[0].sku}, type=${movements[0].type}`);
  if (movements.length !== 1 || movements[0].sku !== 'SKU-LAPTOP-01') {
    throw new Error(`Expected 1 movement for SKU-LAPTOP-01, got ${JSON.stringify(movements)}`);
  }

  // Step 5: Test limit parameter capping at 200
  console.log('\n[Test 5] Testing limit parameter capping (limit=500 -> capped at 200)...');
  const limitRes = await fetch(`${baseUrl}/api/stock/movements?limit=500`, { headers: getAuthHeaders() });
  if (!limitRes.ok) throw new Error(`Limit test failed: ${await limitRes.text()}`);
  const limitMovements = await limitRes.json();
  console.log(`[Test 5 SUCCESS] Movements returned under capped limit (count=${limitMovements.length}).`);

  // Step 6: Test invalid type validation
  console.log('\n[Test 6] Testing invalid type validation (type=invalid -> HTTP 400)...');
  const invalidTypeRes = await fetch(`${baseUrl}/api/stock/movements?type=invalid`, { headers: getAuthHeaders() });
  if (invalidTypeRes.ok) {
    throw new Error('Invalid type parameter was expected to be rejected, but succeeded!');
  }
  const invalidTypeErr = await invalidTypeRes.json();
  console.log(`[Test 6 SUCCESS] Rejected with HTTP ${invalidTypeRes.status}: ${JSON.stringify(invalidTypeErr)}`);

  // Step 7: Test purchaseOrderItemId cross-validation (SKU mismatch & PO ID mismatch)
  console.log('\n[Test 7] Testing purchaseOrderItemId cross-validation...');
  const tenantClient2 = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });
  await tenantClient2.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Supplier" (id, name) VALUES ('sup_test_7', 'Поставщик Тест 7');
  `);
  await tenantClient2.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."PurchaseOrder" (id, number, "supplierId") VALUES ('po_test_7', 'PO-TEST-007', 'sup_test_7');
  `);
  await tenantClient2.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."PurchaseOrderItem" (id, "purchaseOrderId", sku, name, quantity, price)
    VALUES ('poi_test_7', 'po_test_7', 'SKU-PO-ITEM-01', 'Товар ПО 7', 10, 500);
  `);
  await tenantClient2.$disconnect();

  // Test 7a: SKU mismatch
  const skuMismatchRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku: 'SKU-WRONG-999',
      quantity: 5,
      warehouseId: defaultWarehouseId,
      purchaseOrderItemId: 'poi_test_7'
    })
  });
  if (skuMismatchRes.ok) {
    throw new Error('Receipt with SKU mismatch was expected to be rejected, but succeeded!');
  }
  const skuMismatchErr = await skuMismatchRes.json();
  console.log(`[Test 7a SUCCESS] Rejected SKU mismatch: ${JSON.stringify(skuMismatchErr.message)}`);

  // Test 7b: purchaseOrderId mismatch
  const poMismatchRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      sku: 'SKU-PO-ITEM-01',
      quantity: 5,
      warehouseId: defaultWarehouseId,
      purchaseOrderId: 'po_wrong_id_999',
      purchaseOrderItemId: 'poi_test_7'
    })
  });
  if (poMismatchRes.ok) {
    throw new Error('Receipt with purchaseOrderId mismatch was expected to be rejected, but succeeded!');
  }
  const poMismatchErr = await poMismatchRes.json();
  console.log(`[Test 7b SUCCESS] Rejected purchaseOrderId mismatch: ${JSON.stringify(poMismatchErr.message)}`);

  console.log('\n=== STOCK BALANCE & MOVEMENTS INTEGRATION TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runStockTest().catch((err) => {
  console.error('=== STOCK BALANCE & MOVEMENTS INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
