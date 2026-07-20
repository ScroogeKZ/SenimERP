import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runConcurrencyTest() {
  console.log('=== STARTING TENANT PROVISIONING CONCURRENCY INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for concurrency test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `concurrent_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  // Ensure DB schema does NOT exist before test
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
      roles: ['ERP_ACCOUNTANT', 'ERP_PURCHASER']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  console.log(`\n[Test] Firing 10 SIMULTANEOUS REST requests for fresh tenant (${tenantId})...`);

  const requests = [
    fetch(`${baseUrl}/api/invoices`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/waybills`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/acts`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/suppliers`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/purchase-orders`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/supplier-invoices`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/suppliers/debt`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/debtors`, { headers: getAuthHeaders() }),
    fetch(`${baseUrl}/api/suppliers`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name: 'Concurrent Supplier 1' })
    }),
    fetch(`${baseUrl}/api/suppliers`, { headers: getAuthHeaders() })
  ];

  const results = await Promise.all(requests);

  console.log(`\n[Test] Checking responses for all 10 concurrent requests:`);
  let failedCount = 0;

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (!res.ok) {
      failedCount++;
      console.error(`[FAIL] Request #${i + 1} failed with status ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[OK] Request #${i + 1} succeeded with status ${res.status}`);
    }
  }

  if (failedCount > 0) {
    throw new Error(`Concurrency test failed: ${failedCount} out of 10 requests failed.`);
  }

  console.log('\n=== TENANT PROVISIONING CONCURRENCY TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runConcurrencyTest().catch((err) => {
  console.error('=== TENANT PROVISIONING CONCURRENCY TEST FAILED ===', err);
  process.exit(1);
});
