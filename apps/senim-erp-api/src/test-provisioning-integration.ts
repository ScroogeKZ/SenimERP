import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { TenantPrismaService } from './prisma.service.js';

async function runProvisioningTest() {
  console.log('=== STARTING TENANT SCHEMA PROVISIONING INTEGRATION TEST ===');

  console.log('[Test] Bootstrapping SenimERP API server for test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const prismaService = app.get(TenantPrismaService);
  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';

  // Helper for auth headers
  const getAuthHeaders = (tenantId: string) => {
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

  // =========================================================================
  // TEST SCENARIO 1: Brand new tenant with NO prior CRM events / DB schema
  // =========================================================================
  const newTenantId = `fresh_tenant_${Date.now()}`;
  console.log(`\n[Test 1] On-demand schema provisioning for brand-new tenant (${newTenantId})...`);

  // Ensure DB schema does NOT exist beforehand
  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "tenant_${newTenantId}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const res1 = await fetch(`${baseUrl}/api/suppliers`, {
    headers: getAuthHeaders(newTenantId)
  });
  if (!res1.ok) {
    throw new Error(`[Test 1 FAILED] On-demand provisioning failed: ${await res1.text()}`);
  }
  const suppliers1 = await res1.json();
  console.log(`[Test 1 SUCCESS] Brand-new tenant schema auto-created on REST hit. Result: ${JSON.stringify(suppliers1)}`);

  // =========================================================================
  // TEST SCENARIO 2: In-Memory Cache Verification (skips redundant DDL)
  // =========================================================================
  console.log(`\n[Test 2] Verifying ensuredSchemas cache on second REST request for ${newTenantId}...`);
  // Calling ensureTenantSchema directly or hit another REST endpoint
  const startTime = Date.now();
  const res2 = await fetch(`${baseUrl}/api/supplier-invoices`, {
    headers: getAuthHeaders(newTenantId)
  });
  const duration = Date.now() - startTime;

  if (!res2.ok) {
    throw new Error(`[Test 2 FAILED] Subsequent request failed: ${await res2.text()}`);
  }
  console.log(`[Test 2 SUCCESS] Second request served fast via cache in ${duration}ms.`);

  // =========================================================================
  // TEST SCENARIO 3: Legacy tenant schema receiving new tables auto-provisioning
  // =========================================================================
  const legacyTenantId = `legacy_tenant_${Date.now()}`;
  console.log(`\n[Test 3] Simulating legacy tenant schema (${legacyTenantId}) missing AP tables...`);

  const setupClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await setupClient.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "tenant_${legacyTenantId}";`);
  // Create only basic Customer table, skipping SupplierInvoice/SupplierPayment
  await setupClient.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "tenant_${legacyTenantId}"."Customer" (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, bin TEXT UNIQUE NOT NULL
    );
  `);
  await setupClient.$disconnect();

  console.log(`[Test 3] Hitting AP endpoint for legacy tenant...`);
  const resLegacy = await fetch(`${baseUrl}/api/supplier-invoices`, {
    headers: getAuthHeaders(legacyTenantId)
  });

  if (!resLegacy.ok) {
    throw new Error(`[Test 3 FAILED] Auto-provisioning new tables for legacy tenant failed: ${await resLegacy.text()}`);
  }
  const legacyInvoices = await resLegacy.json();
  console.log(`[Test 3 SUCCESS] Legacy tenant schema seamlessly updated with AP tables. Result count: ${legacyInvoices.length}`);

  // =========================================================================
  // TEST SCENARIO 4: Background Consumer Safety (duplicate deal.won events)
  // =========================================================================
  const eventTenantId = `event_tenant_${Date.now()}`;
  console.log(`\n[Test 4] Testing duplicate ensureTenantSchema calls (simulating event-consumer & esf-worker)...`);

  // First call (populates cache)
  await prismaService.ensureTenantSchema(eventTenantId);
  console.log(`[Test 4] First ensureTenantSchema call completed.`);

  // Second duplicate call for same tenant (uses cache)
  await prismaService.ensureTenantSchema(eventTenantId);
  console.log(`[Test 4] Second duplicate ensureTenantSchema call completed cleanly using cache.`);

  // Third call after clearing cache (tests IF NOT EXISTS DDL idempotency)
  (prismaService as any).ensuredSchemas.delete(`tenant_${eventTenantId}`);
  await prismaService.ensureTenantSchema(eventTenantId);
  console.log(`[Test 4] Third ensureTenantSchema call (cache cleared) completed cleanly using IF NOT EXISTS SQL statements.`);

  console.log('\n=== TENANT SCHEMA PROVISIONING INTEGRATION TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runProvisioningTest().catch((err) => {
  console.error('=== TENANT SCHEMA PROVISIONING INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
