import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runBiReportsTest() {
  console.log('=== STARTING BI REPORTS MODULE INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for BI Reports test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3045;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl =
    process.env.DATABASE_BASE_URL ||
    'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `bi_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // 1. Ensure clean schema setup
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`
  );
  await rawPublicClient.$disconnect();

  const getAuthHeaders = () => {
    const ssoToken = signSsoToken({
      sub: 'usr_test_bi_manager',
      tenantId,
      email: 'bi_reports@senim.kz',
      roles: ['ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // Trigger schema provisioning via warehouses GET
  console.log('[Test] Triggering on-demand schema provisioning...');
  const whRes = await fetch(`${baseUrl}/api/warehouses`, {
    headers: getAuthHeaders()
  });
  if (!whRes.ok)
    throw new Error(`GET /api/warehouses failed: ${await whRes.text()}`);

  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  // Seed test data
  console.log('[Test] Seeding Customers, Warehouses, Invoices, SupplierInvoices, StockItems...');

  const cust1 = await tenantClient.customer.create({
    data: {
      id: `cust_bi_1_${Date.now()}`,
      name: 'Альфа Корп',
      bin: `9911${Math.floor(10000000 + Math.random() * 90000000)}`
    }
  });

  const cust2 = await tenantClient.customer.create({
    data: {
      id: `cust_bi_2_${Date.now()}`,
      name: 'Бета Лтд',
      bin: `9922${Math.floor(10000000 + Math.random() * 90000000)}`
    }
  });

  const wh1 = await tenantClient.warehouse.findFirst({
    where: { isDefault: true }
  });
  const wh2 = await tenantClient.warehouse.create({
    data: {
      id: `wh_bi_2_${Date.now()}`,
      name: 'Дополнительный склад',
      code: `WH2_${Date.now()}`
    }
  });

  const now = new Date();
  const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
  const tenDaysInFuture = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
  const seventyDaysAgo = new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000);

  // Invoices
  // DRAFT invoice (should be ignored)
  await tenantClient.invoice.create({
    data: {
      id: `inv_draft_${Date.now()}`,
      number: `INV-DRAFT-${Date.now()}`,
      customerId: cust1.id,
      amount: 999999,
      vatAmount: 0,
      status: 'DRAFT',
      dueDate: tenDaysInFuture
    }
  });

  // CANCELLED invoice (should be ignored)
  await tenantClient.invoice.create({
    data: {
      id: `inv_cancelled_${Date.now()}`,
      number: `INV-CANCELLED-${Date.now()}`,
      customerId: cust1.id,
      amount: 888888,
      vatAmount: 0,
      status: 'CANCELLED',
      dueDate: tenDaysInFuture
    }
  });

  // Valid Invoice 1 (cust1, 100000 amount, 20000 paid -> 80000 outstanding, overdue 15 days -> 1-30)
  const inv1 = await tenantClient.invoice.create({
    data: {
      id: `inv_valid_1_${Date.now()}`,
      number: `INV-1-${Date.now()}`,
      customerId: cust1.id,
      amount: 100000,
      vatAmount: 12000,
      paidAmount: 20000,
      status: 'PARTIALLY_PAID',
      dueDate: fifteenDaysAgo,
      items: {
        create: [
          {
            sku: 'SKU-BI-A',
            name: 'Продукт А',
            quantity: 10,
            price: 6000,
            vatRate: 12,
            vatAmount: 7200,
            totalAmount: 60000
          },
          {
            sku: 'SKU-BI-B',
            name: 'Продукт Б',
            quantity: 5,
            price: 8000,
            vatRate: 12,
            vatAmount: 4800,
            totalAmount: 40000
          }
        ]
      }
    }
  });

  // Valid Invoice 2 (cust2, 200000 amount, 0 paid -> 200000 outstanding, due in 10 days -> current)
  const inv2 = await tenantClient.invoice.create({
    data: {
      id: `inv_valid_2_${Date.now()}`,
      number: `INV-2-${Date.now()}`,
      customerId: cust2.id,
      amount: 200000,
      vatAmount: 24000,
      paidAmount: 0,
      status: 'ISSUED',
      dueDate: tenDaysInFuture,
      items: {
        create: [
          {
            sku: 'SKU-BI-A',
            name: 'Продукт А',
            quantity: 25,
            price: 8000,
            vatRate: 12,
            vatAmount: 24000,
            totalAmount: 200000
          }
        ]
      }
    }
  });

  // Supplier Invoices
  const supplier = await tenantClient.supplier.create({
    data: {
      id: `supp_bi_1_${Date.now()}`,
      name: 'Поставщик Омега',
      bin: `8811${Math.floor(10000000 + Math.random() * 90000000)}`
    }
  });

  // Supplier invoice with no dueDate (40000 amount, 0 paid -> 40000 noDueDate)
  await tenantClient.supplierInvoice.create({
    data: {
      id: `sinv_nodue_${Date.now()}`,
      number: `SINV-NODUE-${Date.now()}`,
      supplierId: supplier.id,
      amount: 40000,
      paidAmount: 0,
      status: 'UNPAID',
      dueDate: null
    }
  });

  // Supplier invoice overdue 70 days (60000 amount, 10000 paid -> 50000 outstanding in 61-90 bucket)
  await tenantClient.supplierInvoice.create({
    data: {
      id: `sinv_overdue70_${Date.now()}`,
      number: `SINV-70-${Date.now()}`,
      supplierId: supplier.id,
      amount: 60000,
      paidAmount: 10000,
      status: 'PARTIALLY_PAID',
      dueDate: seventyDaysAgo
    }
  });

  // Stock Items
  // wh1: SKU-BI-A (qty 10, reserved 2 - normal)
  await tenantClient.stockItem.create({
    data: {
      sku: 'SKU-BI-A',
      warehouseId: wh1!.id,
      quantity: 10,
      reserved: 2
    }
  });
  // wh1: SKU-BI-B (qty 5, reserved 5 - low stock)
  await tenantClient.stockItem.create({
    data: {
      sku: 'SKU-BI-B',
      warehouseId: wh1!.id,
      quantity: 5,
      reserved: 5
    }
  });

  // wh2: SKU-BI-C (qty 2, reserved 4 - low stock)
  await tenantClient.stockItem.create({
    data: {
      sku: 'SKU-BI-C',
      warehouseId: wh2.id,
      quantity: 2,
      reserved: 4
    }
  });

  console.log('[Test] Data seeded. Beginning Endpoint Verifications...');

  // --- Module 1: GET /api/reports/revenue-trend ---
  console.log('[Test 1/7] Testing GET /api/reports/revenue-trend...');
  const revRes = await fetch(`${baseUrl}/api/reports/revenue-trend?granularity=month`, {
    headers: getAuthHeaders()
  });
  if (!revRes.ok) throw new Error(`GET revenue-trend failed: ${await revRes.text()}`);
  const revData: Array<any> = await revRes.json();
  console.log('[Test 1] Revenue Trend Response:', JSON.stringify(revData));
  if (!Array.isArray(revData) || revData.length === 0) {
    throw new Error('Expected non-empty array for revenue-trend');
  }
  const totalRev = revData.reduce((sum, item) => sum + item.revenue, 0);
  const totalInvCount = revData.reduce((sum, item) => sum + item.invoiceCount, 0);
  if (totalRev !== 300000 || totalInvCount !== 2) {
    throw new Error(`Expected revenue=300000, invoiceCount=2. Got revenue=${totalRev}, invoiceCount=${totalInvCount}`);
  }

  // --- Module 2: GET /api/reports/top-customers ---
  console.log('[Test 2/7] Testing GET /api/reports/top-customers...');
  const custRes = await fetch(`${baseUrl}/api/reports/top-customers?limit=5`, {
    headers: getAuthHeaders()
  });
  if (!custRes.ok) throw new Error(`GET top-customers failed: ${await custRes.text()}`);
  const topCustData: Array<any> = await custRes.json();
  console.log('[Test 2] Top Customers Response:', JSON.stringify(topCustData));
  if (topCustData.length !== 2) {
    throw new Error(`Expected 2 top customers, got ${topCustData.length}`);
  }
  if (topCustData[0].customerId !== cust2.id || topCustData[0].totalRevenue !== 200000) {
    throw new Error(`Expected rank 1 customer=${cust2.id} with revenue 200000. Got: ${JSON.stringify(topCustData[0])}`);
  }
  if (topCustData[1].customerId !== cust1.id || topCustData[1].totalRevenue !== 100000) {
    throw new Error(`Expected rank 2 customer=${cust1.id} with revenue 100000. Got: ${JSON.stringify(topCustData[1])}`);
  }

  // --- Module 3: GET /api/reports/top-products ---
  console.log('[Test 3/7] Testing GET /api/reports/top-products...');
  const prodRes = await fetch(`${baseUrl}/api/reports/top-products?limit=5`, {
    headers: getAuthHeaders()
  });
  if (!prodRes.ok) throw new Error(`GET top-products failed: ${await prodRes.text()}`);
  const topProdData: Array<any> = await prodRes.json();
  console.log('[Test 3] Top Products Response:', JSON.stringify(topProdData));
  if (topProdData.length !== 2) {
    throw new Error(`Expected 2 top products, got ${topProdData.length}`);
  }
  // SKU-BI-A totalRevenue = 60000 + 200000 = 260000, totalQuantity = 10 + 25 = 35
  if (topProdData[0].sku !== 'SKU-BI-A' || topProdData[0].totalRevenue !== 260000 || topProdData[0].totalQuantity !== 35) {
    throw new Error(`Expected rank 1 product SKU-BI-A revenue=260000, quantity=35. Got: ${JSON.stringify(topProdData[0])}`);
  }
  // SKU-BI-B totalRevenue = 40000, totalQuantity = 5
  if (topProdData[1].sku !== 'SKU-BI-B' || topProdData[1].totalRevenue !== 40000 || topProdData[1].totalQuantity !== 5) {
    throw new Error(`Expected rank 2 product SKU-BI-B revenue=40000, quantity=5. Got: ${JSON.stringify(topProdData[1])}`);
  }

  // --- Module 4: GET /api/reports/ar-aging ---
  console.log('[Test 4/7] Testing GET /api/reports/ar-aging...');
  const arRes = await fetch(`${baseUrl}/api/reports/ar-aging`, {
    headers: getAuthHeaders()
  });
  if (!arRes.ok) throw new Error(`GET ar-aging failed: ${await arRes.text()}`);
  const arData: any = await arRes.json();
  console.log('[Test 4] AR Aging Response:', JSON.stringify(arData));
  if (arData.totalOutstanding !== 280000) {
    throw new Error(`Expected totalOutstanding=280000. Got ${arData.totalOutstanding}`);
  }
  const currBucket = arData.buckets.find((b: any) => b.bucket === 'current');
  const b1_30 = arData.buckets.find((b: any) => b.bucket === '1-30');
  if (currBucket?.totalOutstanding !== 200000 || currBucket?.invoiceCount !== 1) {
    throw new Error(`Expected current bucket total=200000, count=1. Got: ${JSON.stringify(currBucket)}`);
  }
  if (b1_30?.totalOutstanding !== 80000 || b1_30?.invoiceCount !== 1) {
    throw new Error(`Expected 1-30 bucket total=80000, count=1. Got: ${JSON.stringify(b1_30)}`);
  }

  // --- Module 5: GET /api/reports/ap-aging ---
  console.log('[Test 5/7] Testing GET /api/reports/ap-aging...');
  const apRes = await fetch(`${baseUrl}/api/reports/ap-aging`, {
    headers: getAuthHeaders()
  });
  if (!apRes.ok) throw new Error(`GET ap-aging failed: ${await apRes.text()}`);
  const apData: any = await apRes.json();
  console.log('[Test 5] AP Aging Response:', JSON.stringify(apData));
  if (apData.totalOutstanding !== 90000) {
    throw new Error(`Expected AP totalOutstanding=90000. Got ${apData.totalOutstanding}`);
  }
  if (apData.noDueDate?.totalOutstanding !== 40000 || apData.noDueDate?.invoiceCount !== 1) {
    throw new Error(`Expected noDueDate total=40000, count=1. Got: ${JSON.stringify(apData.noDueDate)}`);
  }
  const b61_90 = apData.buckets.find((b: any) => b.bucket === '61-90');
  if (b61_90?.totalOutstanding !== 50000 || b61_90?.invoiceCount !== 1) {
    throw new Error(`Expected 61-90 bucket total=50000, count=1. Got: ${JSON.stringify(b61_90)}`);
  }

  // --- Module 6: GET /api/reports/stock-health ---
  console.log('[Test 6/7] Testing GET /api/reports/stock-health...');
  const stockRes = await fetch(`${baseUrl}/api/reports/stock-health`, {
    headers: getAuthHeaders()
  });
  if (!stockRes.ok) throw new Error(`GET stock-health failed: ${await stockRes.text()}`);
  const stockHealthData: Array<any> = await stockRes.json();
  console.log('[Test 6] Stock Health Response:', JSON.stringify(stockHealthData));
  const wh1Report = stockHealthData.find((w) => w.warehouseId === wh1!.id);
  const wh2Report = stockHealthData.find((w) => w.warehouseId === wh2.id);
  if (!wh1Report || wh1Report.totalSkuCount !== 2 || wh1Report.lowStockCount !== 1) {
    throw new Error(`Expected wh1 totalSkuCount=2, lowStockCount=1. Got: ${JSON.stringify(wh1Report)}`);
  }
  if (!wh2Report || wh2Report.totalSkuCount !== 1 || wh2Report.lowStockCount !== 1) {
    throw new Error(`Expected wh2 totalSkuCount=1, lowStockCount=1. Got: ${JSON.stringify(wh2Report)}`);
  }

  // --- Module 7: GET /api/reports/dashboard-summary ---
  console.log('[Test 7/7] Testing GET /api/reports/dashboard-summary...');
  const dashRes = await fetch(`${baseUrl}/api/reports/dashboard-summary`, {
    headers: getAuthHeaders()
  });
  if (!dashRes.ok) throw new Error(`GET dashboard-summary failed: ${await dashRes.text()}`);
  const dashData: any = await dashRes.json();
  console.log('[Test 7] Dashboard Summary Response:', JSON.stringify(dashData));
  if (dashData.revenueThisMonth !== 300000) {
    throw new Error(`Expected revenueThisMonth=300000. Got ${dashData.revenueThisMonth}`);
  }
  if (dashData.arOutstandingTotal !== 280000) {
    throw new Error(`Expected arOutstandingTotal=280000. Got ${dashData.arOutstandingTotal}`);
  }
  if (dashData.apOutstandingTotal !== 90000) {
    throw new Error(`Expected apOutstandingTotal=90000. Got ${dashData.apOutstandingTotal}`);
  }
  if (dashData.lowStockItemCount !== 2) {
    throw new Error(`Expected lowStockItemCount=2. Got ${dashData.lowStockItemCount}`);
  }

  // Cleanup
  console.log('[Test] Cleaning up test schema...');
  await tenantClient.$disconnect();
  await rawPublicClient.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`
  );
  await rawPublicClient.$disconnect();
  await app.close();

  console.log('=== ALL 7 BI REPORT MODULE TESTS PASSED SUCCESSFULLY ===');
}

runBiReportsTest().catch((err) => {
  console.error('=== TEST FAILED ===', err);
  process.exit(1);
});
