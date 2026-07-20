import { signSsoToken } from '@senimerp/auth-client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function runRbacTest() {
  console.log('=== STARTING RBAC (ROLE-BASED ACCESS CONTROL) INTEGRATION TEST ===');

  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3004;
  await app.listen(port);
  console.log(`[Test] ERP API running on http://localhost:${port}`);

  const baseUrl = `http://localhost:${port}`;
  const tenantId = `rbac_tenant_${Date.now()}`;

  const makeHeaders = (roles: string[]) => {
    const ssoToken = signSsoToken({
      sub: `usr_rbac_test_${roles.join('_')}`,
      tenantId,
      email: 'rbac@senim.kz',
      roles: roles as any
    });
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ssoToken}`
    };
  };

  // Provision schema with a valid ERP role
  console.log('[Test] Provisioning tenant schema...');
  const initRes = await fetch(`${baseUrl}/api/invoices`, { headers: makeHeaders(['ERP_CEO']) });
  if (!initRes.ok) throw new Error(`Schema provisioning failed: ${initRes.status}`);

  // =========================================================================
  // SECTION 1: CRM-only roles should be DENIED all ERP endpoints (403)
  // =========================================================================
  console.log('\n--- SECTION 1: CRM_MANAGER denied access to all ERP endpoints ---');

  const crmHeaders = makeHeaders(['CRM_MANAGER']);

  const crmTests = [
    { method: 'GET', path: '/api/invoices', label: 'GET invoices' },
    { method: 'GET', path: '/api/waybills', label: 'GET waybills' },
    { method: 'GET', path: '/api/acts', label: 'GET acts' },
    { method: 'GET', path: '/api/suppliers', label: 'GET suppliers' },
    { method: 'GET', path: '/api/purchase-orders', label: 'GET purchase-orders' },
    { method: 'GET', path: '/api/stock', label: 'GET stock' },
    { method: 'GET', path: '/api/debtors', label: 'GET debtors' },
    { method: 'GET', path: '/api/supplier-invoices', label: 'GET supplier-invoices' },
    { method: 'GET', path: '/api/suppliers/debt', label: 'GET suppliers/debt' },
    { method: 'POST', path: '/api/suppliers', label: 'POST suppliers', body: { name: 'X', bin: '000' } },
    { method: 'POST', path: '/api/purchase-orders', label: 'POST purchase-orders', body: { supplierId: 'x', items: [{ sku: 'X', name: 'X', quantity: 1, price: 1 }] } },
  ];

  for (const t of crmTests) {
    const res = await fetch(`${baseUrl}${t.path}`, {
      method: t.method,
      headers: crmHeaders,
      body: (t as any).body ? JSON.stringify((t as any).body) : undefined
    });
    if (res.status !== 403) {
      throw new Error(`[FAIL] CRM_MANAGER should get 403 on ${t.label}, got ${res.status}`);
    }
    console.log(`[CRM Deny SUCCESS] ${t.label} → 403 Forbidden`);
  }

  // =========================================================================
  // SECTION 2: ERP_ACCOUNTANT can read, sign invoices/acts, pay invoices, but CANNOT create suppliers or POs
  // =========================================================================
  console.log('\n--- SECTION 2: ERP_ACCOUNTANT role boundaries ---');

  const accHeaders = makeHeaders(['ERP_ACCOUNTANT']);

  // ALLOWED: GET invoices
  const accInvRes = await fetch(`${baseUrl}/api/invoices`, { headers: accHeaders });
  if (accInvRes.status === 403) throw new Error('ERP_ACCOUNTANT should access GET /invoices');
  console.log(`[Accountant SUCCESS] GET /api/invoices → ${accInvRes.status} (allowed)`);

  // ALLOWED: GET stock
  const accStockRes = await fetch(`${baseUrl}/api/stock`, { headers: accHeaders });
  if (accStockRes.status === 403) throw new Error('ERP_ACCOUNTANT should access GET /stock');
  console.log(`[Accountant SUCCESS] GET /api/stock → ${accStockRes.status} (allowed)`);

  // DENIED: POST suppliers (requires ERP_PURCHASER or ERP_CEO)
  const accSupRes = await fetch(`${baseUrl}/api/suppliers`, {
    method: 'POST',
    headers: accHeaders,
    body: JSON.stringify({ name: 'Test', bin: '111' })
  });
  if (accSupRes.status !== 403) throw new Error(`ERP_ACCOUNTANT should be denied POST /suppliers, got ${accSupRes.status}`);
  console.log(`[Accountant SUCCESS] POST /api/suppliers → 403 Forbidden (denied correctly)`);

  // DENIED: POST purchase-orders (requires ERP_PURCHASER or ERP_CEO)
  const accPoRes = await fetch(`${baseUrl}/api/purchase-orders`, {
    method: 'POST',
    headers: accHeaders,
    body: JSON.stringify({ supplierId: 'x', items: [{ sku: 'X', name: 'X', quantity: 1, price: 1 }] })
  });
  if (accPoRes.status !== 403) throw new Error(`ERP_ACCOUNTANT should be denied POST /purchase-orders, got ${accPoRes.status}`);
  console.log(`[Accountant SUCCESS] POST /api/purchase-orders → 403 Forbidden (denied correctly)`);

  // DENIED: POST warehouse/receipts (requires ERP_WAREHOUSE_MANAGER or ERP_CEO)
  const accWhRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: accHeaders,
    body: JSON.stringify({ sku: 'X', quantity: 1 })
  });
  if (accWhRes.status !== 403) throw new Error(`ERP_ACCOUNTANT should be denied POST /warehouse/receipts, got ${accWhRes.status}`);
  console.log(`[Accountant SUCCESS] POST /api/warehouse/receipts → 403 Forbidden (denied correctly)`);

  // =========================================================================
  // SECTION 3: ERP_WAREHOUSE_MANAGER can receive goods but CANNOT sign invoices or create POs
  // =========================================================================
  console.log('\n--- SECTION 3: ERP_WAREHOUSE_MANAGER role boundaries ---');

  const whHeaders = makeHeaders(['ERP_WAREHOUSE_MANAGER']);

  // ALLOWED: GET stock
  const whStockRes = await fetch(`${baseUrl}/api/stock`, { headers: whHeaders });
  if (whStockRes.status === 403) throw new Error('ERP_WAREHOUSE_MANAGER should access GET /stock');
  console.log(`[Warehouse SUCCESS] GET /api/stock → ${whStockRes.status} (allowed)`);

  // DENIED: POST invoices/:id/sign (requires ERP_ACCOUNTANT or ERP_CEO)
  const whSignInvRes = await fetch(`${baseUrl}/api/invoices/fake-id/sign`, {
    method: 'POST',
    headers: whHeaders,
    body: JSON.stringify({ signedXml: '<fake/>' })
  });
  if (whSignInvRes.status !== 403) throw new Error(`ERP_WAREHOUSE_MANAGER should be denied POST /invoices/:id/sign, got ${whSignInvRes.status}`);
  console.log(`[Warehouse SUCCESS] POST /api/invoices/:id/sign → 403 Forbidden (denied correctly)`);

  // DENIED: POST supplier-invoices (requires ERP_ACCOUNTANT or ERP_CEO)
  const whSupInvRes = await fetch(`${baseUrl}/api/supplier-invoices`, {
    method: 'POST',
    headers: whHeaders,
    body: JSON.stringify({ supplierId: 'x', amount: 1000 })
  });
  if (whSupInvRes.status !== 403) throw new Error(`ERP_WAREHOUSE_MANAGER should be denied POST /supplier-invoices, got ${whSupInvRes.status}`);
  console.log(`[Warehouse SUCCESS] POST /api/supplier-invoices → 403 Forbidden (denied correctly)`);

  // =========================================================================
  // SECTION 4: ERP_PURCHASER can create suppliers and POs but CANNOT sign or pay
  // =========================================================================
  console.log('\n--- SECTION 4: ERP_PURCHASER role boundaries ---');

  const purHeaders = makeHeaders(['ERP_PURCHASER']);

  // ALLOWED: GET purchase-orders
  const purPoRes = await fetch(`${baseUrl}/api/purchase-orders`, { headers: purHeaders });
  if (purPoRes.status === 403) throw new Error('ERP_PURCHASER should access GET /purchase-orders');
  console.log(`[Purchaser SUCCESS] GET /api/purchase-orders → ${purPoRes.status} (allowed)`);

  // DENIED: POST invoices/:id/pay (requires ERP_ACCOUNTANT or ERP_CEO)
  const purPayRes = await fetch(`${baseUrl}/api/invoices/fake-id/pay`, {
    method: 'POST',
    headers: purHeaders,
    body: JSON.stringify({ amount: 1000 })
  });
  if (purPayRes.status !== 403) throw new Error(`ERP_PURCHASER should be denied POST /invoices/:id/pay, got ${purPayRes.status}`);
  console.log(`[Purchaser SUCCESS] POST /api/invoices/:id/pay → 403 Forbidden (denied correctly)`);

  // DENIED: POST warehouse/receipts (requires ERP_WAREHOUSE_MANAGER or ERP_CEO)
  const purWhRes = await fetch(`${baseUrl}/api/warehouse/receipts`, {
    method: 'POST',
    headers: purHeaders,
    body: JSON.stringify({ sku: 'X', quantity: 1 })
  });
  if (purWhRes.status !== 403) throw new Error(`ERP_PURCHASER should be denied POST /warehouse/receipts, got ${purWhRes.status}`);
  console.log(`[Purchaser SUCCESS] POST /api/warehouse/receipts → 403 Forbidden (denied correctly)`);

  // =========================================================================
  // SECTION 5: ERP_CEO has access to everything
  // =========================================================================
  console.log('\n--- SECTION 5: ERP_CEO universal access ---');

  const ceoHeaders = makeHeaders(['ERP_CEO']);

  const ceoTests = [
    { method: 'GET', path: '/api/invoices' },
    { method: 'GET', path: '/api/waybills' },
    { method: 'GET', path: '/api/acts' },
    { method: 'GET', path: '/api/suppliers' },
    { method: 'GET', path: '/api/purchase-orders' },
    { method: 'GET', path: '/api/stock' },
    { method: 'GET', path: '/api/debtors' },
    { method: 'GET', path: '/api/supplier-invoices' },
    { method: 'GET', path: '/api/suppliers/debt' },
  ];

  for (const t of ceoTests) {
    const res = await fetch(`${baseUrl}${t.path}`, { method: t.method, headers: ceoHeaders });
    if (res.status === 403) {
      throw new Error(`[FAIL] ERP_CEO should NOT get 403 on ${t.method} ${t.path}`);
    }
    console.log(`[CEO SUCCESS] ${t.method} ${t.path} → ${res.status} (allowed)`);
  }

  // =========================================================================
  // SECTION 6: 403 response body includes required roles
  // =========================================================================
  console.log('\n--- SECTION 6: 403 response body includes required roles ---');

  const crmDenyRes = await fetch(`${baseUrl}/api/invoices`, { headers: makeHeaders(['CRM_LEAD']) });
  const crmDenyBody = await crmDenyRes.json();
  if (crmDenyBody.statusCode !== 403 || !crmDenyBody.message.includes('Required role')) {
    throw new Error(`403 body should include required roles, got: ${JSON.stringify(crmDenyBody)}`);
  }
  console.log(`[403 Body SUCCESS] Response: ${JSON.stringify(crmDenyBody)}`);

  console.log('\n=== RBAC (ROLE-BASED ACCESS CONTROL) INTEGRATION TEST PASSED SUCCESSFULLY! ===');

  await app.close();
  process.exit(0);
}

runRbacTest().catch((err) => {
  console.error('=== RBAC INTEGRATION TEST FAILED ===', err);
  process.exit(1);
});
