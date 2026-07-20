import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';

async function runDiscountsTest() {
  console.log('=== STARTING LINE ITEM DISCOUNTS INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for Discounts test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `disc_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_disc_manager',
      tenantId,
      email: 'discounts@senim.kz',
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

  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  const eventConsumer = app.get(EventConsumerService);
  const customerId = `cust_disc_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;

  // Step 1: deal.won with listPrice present (Discount scenario)
  console.log('[Test 1] Simulating deal.won event with listPrice present...');
  const deal1Id = `deal_disc_1_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_1_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal1Id,
      customerId,
      customerName: 'Клиент Со Скидкой',
      customerBin: bin,
      amount: 17000,
      items: [
        { sku: 'SKU-DISC-1', crmProductId: 'prod_d1', name: 'Товар со скидкой', quantity: 10, price: 800, listPrice: 1000 },
        { sku: 'SRV-DISC-1', crmProductId: 'prod_d2', name: 'Услуга со скидкой', quantity: 2, price: 4500, listPrice: 5000 }
      ]
    }
  } as any);

  const inv1 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!inv1) throw new Error('Invoice 1 creation failed');

  const invGoodLine = inv1.items.find((i) => i.sku === 'SKU-DISC-1');
  console.log(`[Test 1] Invoice Line SKU-DISC-1: price=${invGoodLine?.price}, originalPrice=${invGoodLine?.originalPrice}, discountAmount=${invGoodLine?.discountAmount}, discountPercent=${invGoodLine?.discountPercent}`);
  if (Number(invGoodLine?.originalPrice) !== 1000 || Number(invGoodLine?.discountAmount) !== 2000 || Number(invGoodLine?.discountPercent) !== 20.00) {
    throw new Error(`Expected Invoice line SKU-DISC-1: originalPrice=1000, discountAmount=2000, discountPercent=20.00. Got: ${JSON.stringify(invGoodLine)}`);
  }

  const wb1 = await tenantClient.waybill.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!wb1) throw new Error('Waybill 1 creation failed');
  const wbGoodLine = wb1.items.find((i) => i.sku === 'SKU-DISC-1');
  console.log(`[Test 1] Waybill Line SKU-DISC-1: price=${wbGoodLine?.price}, originalPrice=${wbGoodLine?.originalPrice}, discountAmount=${wbGoodLine?.discountAmount}, discountPercent=${wbGoodLine?.discountPercent}`);
  if (Number(wbGoodLine?.originalPrice) !== 1000 || Number(wbGoodLine?.discountAmount) !== 2000 || Number(wbGoodLine?.discountPercent) !== 20.00) {
    throw new Error(`Expected Waybill line SKU-DISC-1: originalPrice=1000, discountAmount=2000, discountPercent=20.00. Got: ${JSON.stringify(wbGoodLine)}`);
  }

  const act1 = await tenantClient.serviceAct.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!act1) throw new Error('ServiceAct 1 creation failed');
  const actSrvLine = act1.items.find((i) => i.sku === 'SRV-DISC-1');
  console.log(`[Test 1] Act Line SRV-DISC-1: price=${actSrvLine?.price}, originalPrice=${actSrvLine?.originalPrice}, discountAmount=${actSrvLine?.discountAmount}, discountPercent=${actSrvLine?.discountPercent}`);
  if (Number(actSrvLine?.originalPrice) !== 5000 || Number(actSrvLine?.discountAmount) !== 1000 || Number(actSrvLine?.discountPercent) !== 10.00) {
    throw new Error(`Expected Act line SRV-DISC-1: originalPrice=5000, discountAmount=1000, discountPercent=10.00. Got: ${JSON.stringify(actSrvLine)}`);
  }
  console.log('[Test 1 SUCCESS] Discount calculation and storage verified across Invoice, Waybill, and ServiceAct!');

  // Step 2: deal.won without listPrice (listPrice missing)
  console.log('[Test 2] Simulating deal.won event with listPrice missing...');
  const deal2Id = `deal_disc_2_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_2_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal2Id,
      customerId,
      customerName: 'Клиент Без ПрайсЛиста',
      customerBin: bin,
      amount: 7500,
      items: [
        { sku: 'SKU-DISC-NOLIST', crmProductId: 'prod_nolist', name: 'Товар без listPrice', quantity: 5, price: 1500 }
      ]
    }
  } as any);

  const inv2 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal2Id },
    include: { items: true }
  });
  if (!inv2) throw new Error('Invoice 2 creation failed');
  const noListLine = inv2.items.find((i) => i.sku === 'SKU-DISC-NOLIST');
  console.log(`[Test 2] Invoice Line SKU-DISC-NOLIST: originalPrice=${noListLine?.originalPrice}, discountAmount=${noListLine?.discountAmount}, discountPercent=${noListLine?.discountPercent}`);
  if (noListLine?.originalPrice !== null || Number(noListLine?.discountAmount) !== 0 || Number(noListLine?.discountPercent) !== 0) {
    throw new Error(`Expected null originalPrice and 0 discount. Got: ${JSON.stringify(noListLine)}`);
  }
  console.log('[Test 2 SUCCESS] Missing listPrice default handling verified!');

  // Step 3: Surcharge scenario (price > listPrice)
  console.log('[Test 3] Simulating deal.won event with surcharge (price > listPrice)...');
  const deal3Id = `deal_disc_3_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_disc_3_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal3Id,
      customerId,
      customerName: 'Клиент С Наценкой',
      customerBin: bin,
      amount: 4800,
      items: [
        { sku: 'SKU-SURCHARGE', crmProductId: 'prod_sur', name: 'Товар с наценкой', quantity: 4, price: 1200, listPrice: 1000 }
      ]
    }
  } as any);

  const inv3 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal3Id },
    include: { items: true }
  });
  if (!inv3) throw new Error('Invoice 3 creation failed');
  const surchargeLine = inv3.items.find((i) => i.sku === 'SKU-SURCHARGE');
  console.log(`[Test 3] Invoice Line SKU-SURCHARGE: price=${surchargeLine?.price}, originalPrice=${surchargeLine?.originalPrice}, discountAmount=${surchargeLine?.discountAmount}, discountPercent=${surchargeLine?.discountPercent}`);
  if (Number(surchargeLine?.originalPrice) !== 1000 || Number(surchargeLine?.discountAmount) !== -800 || Number(surchargeLine?.discountPercent) !== -20.00) {
    throw new Error(`Expected surcharge line: originalPrice=1000, discountAmount=-800, discountPercent=-20.00. Got: ${JSON.stringify(surchargeLine)}`);
  }
  console.log('[Test 3 SUCCESS] Surcharge (negative discount) recorded correctly!');

  // Step 4: GET /api/reports/discounts report endpoint
  console.log('[Test 4] Calling GET /api/reports/discounts...');
  const reportRes = await fetch(`${baseUrl}/api/reports/discounts`, {
    headers: getAuthHeaders()
  });
  if (!reportRes.ok) throw new Error(`GET /api/reports/discounts failed: ${await reportRes.text()}`);
  const reportData = await reportRes.json();
  console.log(`[Test 4] Report output: ${JSON.stringify(reportData)}`);

  const customerReport = reportData.find((r: any) => r.bin === bin);
  if (!customerReport) throw new Error(`Customer report for BIN ${bin} not found in output`);

  // Total discountAmount = Invoice1 (3000) + Waybill1 (2000) + Act1 (1000) + Invoice3 (-800) + Waybill3 (-800) = 4400 KZT
  console.log(`[Test 4 SUCCESS] Customer ${customerReport.customerName} total discount: ${customerReport.totalDiscountAmount} KZT across ${customerReport.itemCount} items.`);
  if (customerReport.totalDiscountAmount !== 4400) {
    throw new Error(`Expected total discount amount 4400. Got ${customerReport.totalDiscountAmount}`);
  }

  await tenantClient.$disconnect();
  console.log('=== LINE ITEM DISCOUNTS INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runDiscountsTest().catch((err) => {
  console.error('=== LINE ITEM DISCOUNTS INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
