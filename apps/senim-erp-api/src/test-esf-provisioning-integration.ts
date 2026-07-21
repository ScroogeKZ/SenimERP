import { PrismaClient } from '@prisma/client';
import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import fs from 'fs';
import path from 'path';

async function runEsfProvisioningTest() {
  console.log('=== STARTING ESF DOCUMENT PROVISIONING & SCHEMA PARITY TEST ===');

  // =========================================================================
  // TEST SCENARIO A: Schema Parity Assertion (Strict Regex Matching)
  // =========================================================================
  console.log('[Test A] Verifying schema parity: matching schema.prisma models against prisma.service.ts DDL...');
  
  const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
  const prismaServicePath = path.resolve(process.cwd(), 'src/prisma.service.ts');

  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  const serviceContent = fs.readFileSync(prismaServicePath, 'utf8');

  // Extract all model names from schema.prisma
  const modelRegex = /^model\s+([A-Za-z0-9_]+)\s*\{/gm;
  const modelNames: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = modelRegex.exec(schemaContent)) !== null) {
    modelNames.push(match[1]);
  }

  console.log(`[Test A] Found ${modelNames.length} models in schema.prisma: ${modelNames.join(', ')}`);

  const missingModels: string[] = [];
  for (const modelName of modelNames) {
    // Exact word-boundary match for quoted table name: "${modelName}"[^a-zA-Z]
    // Prevents false positives where 'PurchaseOrder' matches 'PurchaseOrderItem'
    const exactRegex = new RegExp(`"${modelName}"[^a-zA-Z]`);
    if (!exactRegex.test(serviceContent)) {
      missingModels.push(modelName);
    }
  }

  if (missingModels.length > 0) {
    throw new Error(
      `[Schema Parity FAILED] The following ${missingModels.length} models in schema.prisma are missing in ensureTenantSchema() DDL: ${missingModels.join(', ')}`
    );
  }

  console.log(`[Test A SUCCESS] 100% of ${modelNames.length} schema models are verified in ensureTenantSchema() DDL with exact regex boundaries.`);

  // =========================================================================
  // TEST SCENARIO B: ESF Document Provisioning & Lifecycle REST Integration
  // =========================================================================
  console.log('\n[Test B] Bootstrapping SenimERP API server for ESF REST test...');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test B] ERP API running on http://localhost:${port}`);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `esf_tenant_${Date.now()}`;
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
      roles: ['ERP_ACCOUNTANT']
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  const baseUrl = `http://localhost:${port}`;

  // 1. Create customer and invoice directly in tenant DB after on-demand provisioning
  console.log('[Test B] Triggering on-demand schema provisioning...');
  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  // Hit REST endpoint to trigger ensureTenantSchema
  const initRes = await fetch(`${baseUrl}/api/invoices`, { headers: getAuthHeaders() });
  if (!initRes.ok) throw new Error(`Initial invoice query failed: ${await initRes.text()}`);

  // Get pre-seeded default profile
  console.log('[Test B] Getting default pre-seeded TenantProfile...');
  const getProfileRes = await fetch(`${baseUrl}/api/tenant-profile`, { headers: getAuthHeaders() });
  if (!getProfileRes.ok) throw new Error(`Failed to get default tenant profile: ${await getProfileRes.text()}`);
  const defaultProfile = await getProfileRes.json();
  console.log('[Test B SUCCESS] Default profile found:', defaultProfile);
  if (defaultProfile.companyBin !== '000000000000') {
    throw new Error(`Expected default companyBin to be '000000000000', got ${defaultProfile.companyBin}`);
  }

  // Update tenant profile with custom supplier details
  console.log('[Test B] Updating TenantProfile with custom supplier details...');
  const updateProfileRes = await fetch(`${baseUrl}/api/tenant-profile`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      companyName: 'ТОО Тестовый Поставщик',
      companyBin: '123456789012',
      legalAddress: 'г. Алматы, ул. Толе би 59',
      directorName: 'Иванов Иван',
      directorIin: '123456789012'
    })
  });
  if (!updateProfileRes.ok) throw new Error(`Failed to update tenant profile: ${await updateProfileRes.text()}`);
  const updatedProfile = await updateProfileRes.json();
  console.log('[Test B SUCCESS] TenantProfile updated:', updatedProfile);

  const customerId = `cust_${Date.now()}`;
  const invoiceId = `inv_${Date.now()}`;

  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'ТОО "ЭСФ Клиент"', '990102030405');
  `);
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${invoiceId}', 'INV-ESF-001', '${customerId}', 100000, 12000, 0, 'DRAFT', NOW());
  `);
  await tenantClient.$disconnect();

  // 2. Sign Invoice -> triggers EsfDocument creation on fresh tenant
  console.log('[Test B] Signing invoice to trigger EsfDocument creation...');
  const mockSignedXml = `<signedXml><data>MOCK_ESF_INVOICE</data><signature iin="850412300999" bin="850412300999" name="ТЕСТОВЫЙ ПОЛЬЗОВАТЕЛЬ">MOCK_SIGNATURE_DATA_SERIAL_001</signature></signedXml>`;

  const signRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/sign`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ signedXml: mockSignedXml })
  });

  if (!signRes.ok) {
    throw new Error(`[Test B FAILED] Invoice signing failed: ${await signRes.text()}`);
  }
  const signedInvoice = await signRes.json();
  console.log(`[Test B SUCCESS] Invoice signed. Status=${signedInvoice.status}`);

  // 2. Trigger ESF creation / retry via POST /api/invoices/:id/esf/retry
  console.log('[Test B] Triggering ESF creation/retry via POST /api/invoices/:id/esf/retry...');
  const retryRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!retryRes.ok) throw new Error(`[Test B FAILED] ESF retry failed: ${await retryRes.text()}`);
  const retriedEsf = await retryRes.json();
  console.log(`[Test B SUCCESS] EsfDocument created/retried. ID=${retriedEsf.id}, status=${retriedEsf.status}`);

  // 3. Wait up to 5 seconds for the background worker to finish submission
  console.log('[Test B] Waiting for ESF background processing to complete...');
  let esfDoc: any = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const esfRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/esf`, { headers: getAuthHeaders() });
    if (esfRes.ok) {
      esfDoc = await esfRes.json();
      if (esfDoc.status === 'REGISTERED') break;
    }
  }

  console.log(`[Test B SUCCESS] EsfDocument retrieved. ID=${esfDoc.id}, status=${esfDoc.status}`);
  if (esfDoc.status !== 'REGISTERED') {
    throw new Error(`Expected EsfDocument status to reach REGISTERED, got ${esfDoc.status}`);
  }

  // Verify that the requestXml contains custom supplier details from TenantProfile instead of placeholders
  const reqXmlDecoded = esfDoc.requestXml || '';
  console.log('[Test B] Verifying requestXml content against TenantProfile...');
  if (!reqXmlDecoded.includes('<bin>123456789012</bin>') ||
      !reqXmlDecoded.includes('<name>ТОО Тестовый Поставщик</name>') ||
      !reqXmlDecoded.includes('<address>г. Алматы, ул. Толе би 59</address>')) {
    throw new Error(`XML request verification failed. Supplier details not matched. Content: ${reqXmlDecoded}`);
  }
  console.log('[Test B SUCCESS] Supplier details in requestXml match TenantProfile exactly!');

  console.log('\n=== ESF DOCUMENT PROVISIONING & SCHEMA PARITY TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runEsfProvisioningTest().catch((err) => {
  console.error('=== ESF DOCUMENT PROVISIONING & SCHEMA PARITY TEST FAILED ===', err);
  process.exit(1);
});
