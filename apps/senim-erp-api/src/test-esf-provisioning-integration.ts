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

  // 1. Create customer and invoices directly in tenant DB after on-demand provisioning
  console.log('[Test B] Triggering on-demand schema provisioning...');
  const tenantClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=${schemaName}` } }
  });

  // Hit REST endpoint to trigger ensureTenantSchema
  const initRes = await fetch(`${baseUrl}/api/invoices`, { headers: getAuthHeaders() });
  if (!initRes.ok) throw new Error(`Initial invoice query failed: ${await initRes.text()}`);

  // Verify pre-seeded default profile has dummy companyBin ('000000000000')
  console.log('[Test B] Getting default pre-seeded TenantProfile...');
  const getProfileRes = await fetch(`${baseUrl}/api/tenant-profile`, { headers: getAuthHeaders() });
  if (!getProfileRes.ok) throw new Error(`Failed to get default tenant profile: ${await getProfileRes.text()}`);
  const defaultProfile = await getProfileRes.json();
  console.log('[Test B SUCCESS] Default profile found:', defaultProfile);
  if (defaultProfile.companyBin !== '000000000000') {
    throw new Error(`Expected default companyBin to be '000000000000', got ${defaultProfile.companyBin}`);
  }

  const customerId = `cust_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Customer" (id, name, bin) VALUES ('${customerId}', 'ТОО "ЭСФ Клиент"', '990102030405');
  `);

  const mockSignedXml = `<signedXml><data>MOCK_ESF_INVOICE</data><signature iin="850412300999" bin="850412300999" name="ТЕСТОВЫЙ ПОЛЬЗОВАТЕЛЬ">MOCK_SIGNATURE_DATA_SERIAL_001</signature></signedXml>`;

  // Helper to verify supplier BIN in generated requestXml (checking signature attribute, raw XML, or base64 data)
  const checkSupplierBinInXml = (xml: string, bin: string): boolean => {
    if (xml.includes(`bin="${bin}"`)) return true;
    if (xml.includes(`<bin>${bin}</bin>`)) return true;
    const dataMatch = xml.match(/<data>([^<]+)<\/data>/);
    if (dataMatch) {
      try {
        const decoded = Buffer.from(dataMatch[1], 'base64').toString('utf8');
        if (decoded.includes(`<bin>${bin}</bin>`)) return true;
      } catch {}
    }
    return false;
  };

  // =========================================================================
  // SCENARIO 1: Mock Mode without configured TenantProfile (Regression Case)
  // =========================================================================
  console.log('\n[Scenario 1] Testing Mock Mode (IS_ESF_MOCK=true) without configured TenantProfile...');
  process.env.IS_ESF_MOCK = 'true';
  const invMockId = `inv_mock_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${invMockId}', 'INV-MOCK-001', '${customerId}', 100000, 12000, 0, 'DRAFT', NOW());
  `);

  const retryMockRes = await fetch(`${baseUrl}/api/invoices/${invMockId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!retryMockRes.ok) throw new Error(`[Scenario 1 FAILED] ESF retry failed: ${await retryMockRes.text()}`);

  let mockEsfDoc: any = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const esfRes = await fetch(`${baseUrl}/api/invoices/${invMockId}/esf`, { headers: getAuthHeaders() });
    if (esfRes.ok) {
      mockEsfDoc = await esfRes.json();
      if (mockEsfDoc.status === 'REGISTERED') break;
    }
  }

  if (mockEsfDoc?.status !== 'REGISTERED') {
    throw new Error(`[Scenario 1 FAILED] Expected status REGISTERED, got ${mockEsfDoc?.status}`);
  }
  const mockXml = mockEsfDoc.requestXml || '';
  if (!checkSupplierBinInXml(mockXml, '990840001234')) {
    throw new Error(`[Scenario 1 FAILED] Expected fallback mock BIN 990840001234 in requestXml, got: ${mockXml}`);
  }
  console.log('[Scenario 1 SUCCESS] Mock mode without configured TenantProfile fallback working correctly!');

  // =========================================================================
  // SCENARIO 2: Production Mode (IS_ESF_MOCK=false) without configured TenantProfile (Failure Case)
  // =========================================================================
  console.log('\n[Scenario 2] Testing Production Mode (IS_ESF_MOCK=false) without configured TenantProfile...');
  process.env.IS_ESF_MOCK = 'false';
  const invProdUnconfigId = `inv_prod_unconfig_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${invProdUnconfigId}', 'INV-PROD-001', '${customerId}', 200000, 24000, 0, 'DRAFT', NOW());
  `);

  const retryProdUnconfigRes = await fetch(`${baseUrl}/api/invoices/${invProdUnconfigId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!retryProdUnconfigRes.ok) throw new Error(`[Scenario 2 FAILED] ESF retry failed: ${await retryProdUnconfigRes.text()}`);

  let prodUnconfigEsfDoc: any = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const esfRes = await fetch(`${baseUrl}/api/invoices/${invProdUnconfigId}/esf`, { headers: getAuthHeaders() });
    if (esfRes.ok) {
      prodUnconfigEsfDoc = await esfRes.json();
      if (prodUnconfigEsfDoc.status === 'FAILED') break;
    }
  }

  if (prodUnconfigEsfDoc?.status !== 'FAILED') {
    throw new Error(`[Scenario 2 FAILED] Expected EsfDocument status to be FAILED, got ${prodUnconfigEsfDoc?.status}`);
  }
  if (!prodUnconfigEsfDoc.errorMessage?.includes('TenantProfile is not configured')) {
    throw new Error(`[Scenario 2 FAILED] Expected configuration error message, got: ${prodUnconfigEsfDoc.errorMessage}`);
  }
  console.log('[Scenario 2 SUCCESS] Production mode without configured TenantProfile correctly failed with configuration error!');

  // =========================================================================
  // SCENARIO 3: Production Mode (IS_ESF_MOCK=false) with configured TenantProfile (Success Case)
  // =========================================================================
  console.log('\n[Scenario 3] Testing Production Mode (IS_ESF_MOCK=false) with configured TenantProfile...');
  const updateProfileRes = await fetch(`${baseUrl}/api/tenant-profile`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      companyName: 'ТОО Настоящий Поставщик',
      companyBin: '123456789012',
      legalAddress: 'г. Алматы, ул. Толе би 59',
      directorName: 'Иванов Иван',
      directorIin: '123456789012'
    })
  });
  if (!updateProfileRes.ok) throw new Error(`Failed to update tenant profile: ${await updateProfileRes.text()}`);
  const updatedProfile = await updateProfileRes.json();
  console.log('[Scenario 3] TenantProfile updated:', updatedProfile);

  const invProdConfigId = `inv_prod_config_${Date.now()}`;
  await tenantClient.$executeRawUnsafe(`
    INSERT INTO "${schemaName}"."Invoice" (id, number, "customerId", amount, "vatAmount", "paidAmount", status, "dueDate")
    VALUES ('${invProdConfigId}', 'INV-PROD-002', '${customerId}', 300000, 36000, 0, 'DRAFT', NOW());
  `);

  const retryProdConfigRes = await fetch(`${baseUrl}/api/invoices/${invProdConfigId}/esf/retry`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!retryProdConfigRes.ok) throw new Error(`[Scenario 3 FAILED] ESF retry failed: ${await retryProdConfigRes.text()}`);

  let prodConfigEsfDoc: any = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const esfRes = await fetch(`${baseUrl}/api/invoices/${invProdConfigId}/esf`, { headers: getAuthHeaders() });
    if (esfRes.ok) {
      prodConfigEsfDoc = await esfRes.json();
      if (prodConfigEsfDoc.status === 'REGISTERED') break;
    }
  }

  if (prodConfigEsfDoc?.status !== 'REGISTERED') {
    throw new Error(`[Scenario 3 FAILED] Expected status REGISTERED, got ${prodConfigEsfDoc?.status}`);
  }
  const prodConfigXml = prodConfigEsfDoc.requestXml || '';
  if (!checkSupplierBinInXml(prodConfigXml, '123456789012')) {
    throw new Error(`[Scenario 3 FAILED] XML request verification failed. Real supplier BIN 123456789012 not matched. Content: ${prodConfigXml}`);
  }
  if (prodConfigXml.includes('bin="990840001234"') || prodConfigXml.includes('<bin>990840001234</bin>')) {
    throw new Error(`[Scenario 3 FAILED] XML contains synthetic fallback BIN 990840001234!`);
  }
  console.log('[Scenario 3 SUCCESS] Production mode with configured TenantProfile correctly used real BIN 123456789012!');

  await tenantClient.$disconnect();

  process.env.IS_ESF_MOCK = 'true';
  console.log('\n=== ESF DOCUMENT PROVISIONING & SCHEMA PARITY TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runEsfProvisioningTest().catch((err) => {
  console.error('=== ESF DOCUMENT PROVISIONING & SCHEMA PARITY TEST FAILED ===', err);
  process.exit(1);
});
