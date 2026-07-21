import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { TenantPrismaService } from './prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { IntegrationEvent } from '@senimerp/types';

async function runMarketplaceIntegrationTests() {
  console.log('=== Starting SenimERP Marketplace Integration Tests ===');

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(3004);
  const baseUrl = 'http://localhost:3004';

  const prismaService = app.get(TenantPrismaService);
  const eventConsumerService = app.get(EventConsumerService);

  const timestamp = Date.now();
  const testTenantId = `test_mkt_${timestamp}`;
  const accountId = `kaspi_acc_${timestamp}`;
  const warehouseId = `wh_mkt_${timestamp}`;

  console.log(`[Setup] Provisioning test tenant schema: ${testTenantId}`);
  await prismaService.ensureTenantSchema(testTenantId);
  const db = prismaService.getClient(testTenantId);

  try {
    // 1. Seed Warehouse and StockItems
    await db.warehouse.create({
      data: {
        id: warehouseId,
        name: 'Главный Склад Kaspi',
        code: 'MAIN_KASPI_WH',
        isDefault: true
      }
    });

    const sku1 = `SKU-MKT-LAPTOP-${timestamp}`;
    await db.stockItem.create({
      data: {
        sku: sku1,
        warehouseId: warehouseId,
        quantity: 50,
        reserved: 10
      }
    });

    // Seed historical waybill line item for product name enrichment
    const dummyCust = await db.customer.create({
      data: { name: 'Seed Customer', bin: `seed_bin_${timestamp}` }
    });
    const seedWb = await db.waybill.create({
      data: {
        number: `WAY-SEED-${timestamp}`,
        customerId: dummyCust.id,
        warehouseId: warehouseId,
        amount: 350000,
        vatAmount: 42000,
        status: 'DELIVERED',
        items: {
          create: [{
            sku: sku1,
            name: 'Ноутбук Kaspi Pro 15',
            quantity: 1,
            price: 350000,
            vatRate: 12,
            vatAmount: 42000,
            totalAmount: 392000
          }]
        }
      }
    });

    console.log('[Setup] Seeded stock item: quantity=50, reserved=10 (available=40)');

    // -------------------------------------------------------------
    // Test 1: GET /api/marketplace/kaspi/:accountId/catalog.xml
    // -------------------------------------------------------------
    console.log('\n[Test 1/5] Testing Kaspi.kz XML Catalog Export...');
    const catalogUrl = `${baseUrl}/api/marketplace/kaspi/${accountId}/catalog.xml?tenantId=${testTenantId}&warehouseId=${warehouseId}`;
    const catalogRes = await fetch(catalogUrl);

    if (!catalogRes.ok) {
      throw new Error(`Catalog request failed with HTTP ${catalogRes.status}: ${await catalogRes.text()}`);
    }

    const contentType = catalogRes.headers.get('content-type') || '';
    if (!contentType.includes('application/xml')) {
      throw new Error(`Expected Content-Type application/xml, got ${contentType}`);
    }

    const xmlText = await catalogRes.text();
    console.log('[Test 1] Generated Catalog XML Preview:\n' + xmlText.substring(0, 400) + '...\n');

    if (!xmlText.includes('<kaspi_catalog')) {
      throw new Error('XML root tag <kaspi_catalog> missing');
    }
    if (!xmlText.includes(`<merchantid>${accountId}</merchantid>`)) {
      throw new Error(`Merchant ID ${accountId} missing in XML`);
    }
    if (!xmlText.includes(`sku="${sku1}"`)) {
      throw new Error(`SKU ${sku1} missing in XML`);
    }
    if (!xmlText.includes('<model>Ноутбук Kaspi Pro 15</model>')) {
      throw new Error('Product model name missing in XML');
    }
    if (!xmlText.includes('stockCount="40"')) {
      throw new Error('Expected stockCount="40" (50 - 10) in XML');
    }
    if (!xmlText.includes('available="yes"')) {
      throw new Error('Expected available="yes" in XML');
    }
    console.log('[Test 1 SUCCESS] Kaspi XML Catalog verified successfully.');

    // -------------------------------------------------------------
    // Test 2: Order Received WITH BIN & requiresEsf: true
    // -------------------------------------------------------------
    console.log('\n[Test 2/5] Testing marketplace.order.received WITH BIN (requiresEsf: true)...');
    const order1Id = `MKT-ORD-101-${timestamp}`;
    const buyerBin1 = `990101${timestamp.toString().slice(-6)}`;

    const event1: IntegrationEvent<any> = {
      eventId: `evt_mkt_1_${timestamp}`,
      eventType: 'marketplace.order.received',
      tenantId: testTenantId,
      timestamp: new Date().toISOString(),
      payload: {
        marketplaceOrderId: order1Id,
        accountId: accountId,
        warehouseId: warehouseId,
        buyerBinIin: buyerBin1,
        buyerName: 'ТОО КаспиПартнер',
        requiresEsf: true,
        items: [{
          sku: sku1,
          quantity: 2,
          price: 350000,
          name: 'Ноутбук Kaspi Pro 15'
        }],
        totalAmount: 700000
      }
    };

    await eventConsumerService.handleMarketplaceOrderReceived(event1);

    // Verify Customer
    const cust1 = await db.customer.findUnique({ where: { bin: buyerBin1 } });
    if (!cust1 || cust1.name !== 'ТОО КаспиПартнер') {
      throw new Error(`Customer with BIN ${buyerBin1} not created correctly`);
    }

    // Verify Stock Reservation
    const stock1 = await db.stockItem.findUnique({
      where: { sku_warehouseId: { sku: sku1, warehouseId: warehouseId } }
    });
    if (Number(stock1?.reserved) !== 12) { // 10 initial + 2 reserved
      throw new Error(`Expected stock reserved=12, got ${stock1?.reserved}`);
    }

    // Verify Waybill
    const waybill1 = await db.waybill.findFirst({ where: { crmDealId: order1Id } });
    if (!waybill1 || waybill1.status !== 'DRAFT') {
      throw new Error(`Draft Waybill for order ${order1Id} not created`);
    }

    // Verify Invoice (must be created because requiresEsf === true)
    const invoice1 = await db.invoice.findFirst({ where: { crmDealId: order1Id } });
    if (!invoice1 || invoice1.status !== 'DRAFT') {
      throw new Error(`Draft Invoice for order ${order1Id} missing when requiresEsf === true`);
    }

    console.log(`[Test 2 SUCCESS] Order ${order1Id} created Waybill ${waybill1.number}, Invoice ${invoice1.number}, and reserved 2 items.`);

    // -------------------------------------------------------------
    // Test 3: Order Received WITHOUT BIN & requiresEsf: false
    // -------------------------------------------------------------
    console.log('\n[Test 3/5] Testing marketplace.order.received WITHOUT BIN (requiresEsf: false)...');
    const order2Id = `MKT-ORD-102-${timestamp}`;

    const event2: IntegrationEvent<any> = {
      eventId: `evt_mkt_2_${timestamp}`,
      eventType: 'marketplace.order.received',
      tenantId: testTenantId,
      timestamp: new Date().toISOString(),
      payload: {
        marketplaceOrderId: order2Id,
        accountId: accountId,
        warehouseId: warehouseId,
        buyerBinIin: undefined,
        buyerName: 'Аскар Серік',
        requiresEsf: false,
        items: [{
          sku: sku1,
          quantity: 3,
          price: 350000,
          name: 'Ноутбук Kaspi Pro 15'
        }],
        totalAmount: 1050000
      }
    };

    await eventConsumerService.handleMarketplaceOrderReceived(event2);

    // Verify Retail Customer
    const retailCust = await db.customer.findUnique({ where: { bin: '990000000000' } });
    if (!retailCust || retailCust.name !== 'Kaspi.kz Магазин — Розница') {
      throw new Error('Default Kaspi retail Customer not created correctly');
    }

    // Verify Stock Reservation
    const stock2 = await db.stockItem.findUnique({
      where: { sku_warehouseId: { sku: sku1, warehouseId: warehouseId } }
    });
    if (Number(stock2?.reserved) !== 15) { // 12 + 3 reserved
      throw new Error(`Expected stock reserved=15, got ${stock2?.reserved}`);
    }

    // Verify Waybill
    const waybill2 = await db.waybill.findFirst({ where: { crmDealId: order2Id } });
    if (!waybill2 || waybill2.status !== 'DRAFT') {
      throw new Error(`Draft Waybill for retail order ${order2Id} not created`);
    }

    // Verify Invoice IS NOT CREATED (because requiresEsf === false)
    const invoice2 = await db.invoice.findFirst({ where: { crmDealId: order2Id } });
    if (invoice2) {
      throw new Error(`Invoice should NOT be created for retail order ${order2Id} when requiresEsf === false`);
    }

    console.log(`[Test 3 SUCCESS] Retail order ${order2Id} created Waybill ${waybill2.number}, reserved 3 items, and correctly SKIPPED Invoice.`);

    // -------------------------------------------------------------
    // Test 4: Order Cancelled for DRAFT Waybill
    // -------------------------------------------------------------
    console.log('\n[Test 4/5] Testing marketplace.order.cancelled for DRAFT Waybill...');

    const cancelEvent4: IntegrationEvent<any> = {
      eventId: `evt_mkt_cancel_4_${timestamp}`,
      eventType: 'marketplace.order.cancelled',
      tenantId: testTenantId,
      timestamp: new Date().toISOString(),
      payload: {
        marketplaceOrderId: order2Id,
        reason: 'Покупатель отменил заказ до отправки'
      }
    };

    await eventConsumerService.handleMarketplaceOrderCancelled(cancelEvent4);

    const waybill2After = await db.waybill.findUnique({ where: { id: waybill2.id } });
    if (waybill2After?.status !== 'CANCELLED') {
      throw new Error(`Expected Waybill status CANCELLED, got ${waybill2After?.status}`);
    }

    const stock4 = await db.stockItem.findUnique({
      where: { sku_warehouseId: { sku: sku1, warehouseId: warehouseId } }
    });
    if (Number(stock4?.reserved) !== 12) { // 15 - 3 released = 12
      throw new Error(`Expected stock reserved=12 after DRAFT cancel, got ${stock4?.reserved}`);
    }

    console.log(`[Test 4 SUCCESS] DRAFT Waybill ${waybill2.number} cancelled & stock reservation released (reserved back to 12).`);

    // -------------------------------------------------------------
    // Test 5: Order Cancelled for DELIVERED Waybill (via RMA)
    // -------------------------------------------------------------
    console.log('\n[Test 5/5] Testing marketplace.order.cancelled for DELIVERED Waybill...');

    // First deliver waybill 1
    await db.waybill.update({
      where: { id: waybill1.id },
      data: { status: 'DELIVERED' }
    });

    const cancelEvent5: IntegrationEvent<any> = {
      eventId: `evt_mkt_cancel_5_${timestamp}`,
      eventType: 'marketplace.order.cancelled',
      tenantId: testTenantId,
      timestamp: new Date().toISOString(),
      payload: {
        marketplaceOrderId: order1Id,
        reason: 'Возврат товара покупателем в пункт выдачи'
      }
    };

    await eventConsumerService.handleMarketplaceOrderCancelled(cancelEvent5);

    // Verify RMA created and confirmed
    const rma = await db.rma.findFirst({
      where: { waybillId: waybill1.id },
      include: { lines: true }
    });

    if (!rma || rma.status !== 'CONFIRMED') {
      throw new Error('Confirmed RMA not created for DELIVERED order cancellation');
    }

    // Verify physical stock quantity incremented
    const stock5 = await db.stockItem.findUnique({
      where: { sku_warehouseId: { sku: sku1, warehouseId: warehouseId } }
    });
    if (Number(stock5?.quantity) !== 52) { // 50 initial + 2 returned = 52
      throw new Error(`Expected physical stock quantity=52 after RMA, got ${stock5?.quantity}`);
    }

    console.log(`[Test 5 SUCCESS] DELIVERED Waybill ${waybill1.number} cancelled via confirmed RMA ${rma.number}. Inventory restored (quantity=52).`);

  } finally {
    console.log('\n[Teardown] Cleaning up test schema...');
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${testTenantId}" CASCADE;`);
    await app.close();
  }

  console.log('\n=== ALL 5 MARKETPLACE INTEGRATION TESTS PASSED SUCCESSFULLY ===');
}

runMarketplaceIntegrationTests().catch((err) => {
  console.error('Marketplace Integration Test Failed:', err);
  process.exit(1);
});
