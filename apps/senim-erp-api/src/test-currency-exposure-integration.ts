import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';

async function runCurrencyExposureTest() {
  console.log('=== STARTING CURRENCY EXPOSURE INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for Currency test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `curr_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_curr_manager',
      tenantId,
      email: 'currency@senim.kz',
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
  const customerId = `cust_curr_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;
  const rateDate = new Date().toISOString();

  // Step 1: Foreign currency deal (USD)
  console.log('[Test 1] Simulating deal.won event in USD currency...');
  const deal1Id = `deal_usd_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_usd_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal1Id,
      customerId,
      customerName: 'Импортёр Клиент (USD)',
      customerBin: bin,
      amount: 672000,
      items: [
        {
          sku: 'SKU-USD-GOOD',
          crmProductId: 'prod_usd_1',
          name: 'Импортный Товар',
          quantity: 10,
          price: 50000,
          dealCurrency: 'USD',
          dealCurrencyPrice: 100.0,
          exchangeRate: 500.0,
          exchangeRateDate: rateDate
        },
        {
          sku: 'SRV-USD-SERVICE',
          crmProductId: 'prod_usd_2',
          name: 'Импортная Услуга',
          quantity: 1,
          price: 100000,
          dealCurrency: 'USD',
          dealCurrencyPrice: 200.0,
          exchangeRate: 500.0,
          exchangeRateDate: rateDate
        }
      ]
    }
  } as any);

  const inv1 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!inv1) throw new Error('USD Invoice creation failed');

  const usdGoodLine = inv1.items.find((i) => i.sku === 'SKU-USD-GOOD');
  console.log(`[Test 1] Invoice Line SKU-USD-GOOD: price(KZT)=${usdGoodLine?.price}, dealCurrency=${usdGoodLine?.dealCurrency}, dealCurrencyPrice=${usdGoodLine?.dealCurrencyPrice}, exchangeRate=${usdGoodLine?.exchangeRate}`);
  if (
    usdGoodLine?.dealCurrency !== 'USD' ||
    Number(usdGoodLine?.dealCurrencyPrice) !== 100 ||
    Number(usdGoodLine?.exchangeRate) !== 500
  ) {
    throw new Error(`USD Invoice line verification failed: ${JSON.stringify(usdGoodLine)}`);
  }

  const wb1 = await tenantClient.waybill.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!wb1) throw new Error('USD Waybill creation failed');
  const wbUsdLine = wb1.items.find((i) => i.sku === 'SKU-USD-GOOD');
  if (
    wbUsdLine?.dealCurrency !== 'USD' ||
    Number(wbUsdLine?.dealCurrencyPrice) !== 100 ||
    Number(wbUsdLine?.exchangeRate) !== 500
  ) {
    throw new Error(`USD Waybill line verification failed: ${JSON.stringify(wbUsdLine)}`);
  }

  const act1 = await tenantClient.serviceAct.findFirst({
    where: { crmDealId: deal1Id },
    include: { items: true }
  });
  if (!act1) throw new Error('USD ServiceAct creation failed');
  const actUsdLine = act1.items.find((i) => i.sku === 'SRV-USD-SERVICE');
  if (
    actUsdLine?.dealCurrency !== 'USD' ||
    Number(actUsdLine?.dealCurrencyPrice) !== 200 ||
    Number(actUsdLine?.exchangeRate) !== 500
  ) {
    throw new Error(`USD Act line verification failed: ${JSON.stringify(actUsdLine)}`);
  }
  console.log('[Test 1 SUCCESS] Foreign currency metadata transferred and stored across Invoice, Waybill, and ServiceAct!');

  // Step 2: KZT deal (currency fields missing/null)
  console.log('[Test 2] Simulating deal.won event in domestic KZT (null currency fields)...');
  const deal2Id = `deal_kzt_${Date.now()}`;
  await eventConsumer.handleDealWon({
    eventId: `evt_kzt_${Date.now()}`,
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId: deal2Id,
      customerId,
      customerName: 'Местный Клиент (KZT)',
      customerBin: bin,
      amount: 11200,
      items: [
        { sku: 'SKU-KZT-GOOD', crmProductId: 'prod_kzt', name: 'Местный Товар', quantity: 1, price: 10000 }
      ]
    }
  } as any);

  const inv2 = await tenantClient.invoice.findFirst({
    where: { crmDealId: deal2Id },
    include: { items: true }
  });
  if (!inv2) throw new Error('KZT Invoice creation failed');
  const kztLine = inv2.items.find((i) => i.sku === 'SKU-KZT-GOOD');
  console.log(`[Test 2] KZT Line: dealCurrency=${kztLine?.dealCurrency}, dealCurrencyPrice=${kztLine?.dealCurrencyPrice}, exchangeRate=${kztLine?.exchangeRate}`);
  if (kztLine?.dealCurrency !== null || kztLine?.dealCurrencyPrice !== null || kztLine?.exchangeRate !== null) {
    throw new Error(`KZT line should have null currency fields. Got: ${JSON.stringify(kztLine)}`);
  }
  console.log('[Test 2 SUCCESS] Domestic KZT null currency fields verified!');

  // Step 3: GET /api/reports/currency-exposure endpoint
  console.log('[Test 3] Calling GET /api/reports/currency-exposure...');
  const reportRes = await fetch(`${baseUrl}/api/reports/currency-exposure`, {
    headers: getAuthHeaders()
  });
  if (!reportRes.ok) throw new Error(`GET /api/reports/currency-exposure failed: ${await reportRes.text()}`);
  const reportData = await reportRes.json();
  console.log(`[Test 3] Currency Exposure Report: ${JSON.stringify(reportData)}`);

  const usdReport = reportData.find((r: any) => r.currency === 'USD');
  if (!usdReport) throw new Error('USD currency report entry missing');

  // Total USD foreign amount: Invoice1 (1000 + 200 = 1200) + Waybill1 (1000) + Act1 (200) = 2400 USD
  console.log(`[Test 3 SUCCESS] USD exposure: totalForeignAmount=${usdReport.totalForeignCurrencyAmount} USD, totalKztAmount=${usdReport.totalKztAmount} KZT across ${usdReport.lineItemCount} line items.`);
  if (usdReport.totalForeignCurrencyAmount !== 2400 || usdReport.lineItemCount !== 4) {
    throw new Error(`Expected USD total 2400 USD and 4 lines. Got ${JSON.stringify(usdReport)}`);
  }

  await tenantClient.$disconnect();
  console.log('=== CURRENCY EXPOSURE INTEGRATION TEST PASSED SUCCESSFULLY! ===');
  await app.close();
  process.exit(0);
}

runCurrencyExposureTest().catch((err) => {
  console.error('=== CURRENCY EXPOSURE INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
