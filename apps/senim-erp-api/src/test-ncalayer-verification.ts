import { NCALayerService, NCALayerVerificationError } from '@senimerp/integrations';
import forge from 'node-forge';
import http from 'node:http';

/**
 * Helper: Generate a self-signed RSA X.509 certificate + key pair using node-forge.
 * Returns the cert, keys, and a Base64 CMS PKCS#7 SignedData envelope.
 */
function generateRsaCmsSigned(options?: {
  notBefore?: Date;
  notAfter?: Date;
  signWithKey?: forge.pki.PrivateKey; // sign CMS with a different key than the cert's
}): { cert: forge.pki.Certificate; keys: forge.pki.KeyPair; cmsBase64: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0123456789ABCDEF';
  cert.validity.notBefore = options?.notBefore ?? new Date(Date.now() - 3600 * 1000);
  cert.validity.notAfter = options?.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);

  cert.setSubject([
    { name: 'commonName', value: forge.util.encodeUtf8('Иванов Иван Иванович') },
    { type: '1.2.398.3.3.2.1', value: 'IIN850101300123' },
    { type: '1.2.398.3.3.2.2', value: 'BIN990240001122' }
  ]);
  cert.setIssuer([
    { name: 'commonName', value: forge.util.encodeUtf8('НУЦ РК RSA (NCA RK)') }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Create PKCS#7 SignedData with authenticatedAttributes (standard for NUC RK)
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer('Test document content to sign', 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: (options?.signWithKey ?? keys.privateKey) as any,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as any }
    ]
  });
  p7.sign();

  const derBuf = forge.asn1.toDer(p7.toAsn1());
  const cmsBase64 = Buffer.from(derBuf.getBytes(), 'binary').toString('base64');

  return { cert, keys, cmsBase64 };
}

/**
 * Helper: Assert that a promise rejects with NCALayerVerificationError of the given code.
 */
async function expectVerificationError(
  label: string,
  fn: () => Promise<any>,
  expectedCode: string
): Promise<void> {
  let caught = false;
  try {
    await fn();
  } catch (err: any) {
    if (err instanceof NCALayerVerificationError && err.code === expectedCode) {
      caught = true;
      console.log(`[${label} SUCCESS] Correctly rejected with code ${expectedCode}.`);
    } else {
      throw new Error(`${label} failed: unexpected error (expected ${expectedCode}, got ${err.code || err.message})`);
    }
  }
  if (!caught) {
    throw new Error(`${label} failed: expected ${expectedCode} error but verification succeeded!`);
  }
}

async function runNcaLayerVerificationTest() {
  console.log('=== STARTING NCALAYER VERIFICATION SUITE ===');

  // ─────────────── POSITIVE (HAPPY-PATH) TESTS ───────────────

  // Test 1: Mock XML Signature verification
  console.log('[Test 1] Testing legacy Mock XML verification...');
  const mockXml = '<signedXml iin="123456789012" bin="987654321098" name="Тестовый Подписант"><signature>SERIAL_TEST123456</signature></signedXml>';
  const mockResult = await NCALayerService.verifySignature(mockXml);
  console.log('[Test 1 SUCCESS] Mock XML parsed:', mockResult);
  if (mockResult.iin !== '123456789012' || mockResult.signedBy !== 'Тестовый Подписант' || mockResult.certSerial !== 'TEST123456') {
    throw new Error(`Mock XML assertion failed! Got: ${JSON.stringify(mockResult)}`);
  }

  // Test 2: Invalid CMS structure rejection
  console.log('[Test 2] Testing invalid CMS structure rejection...');
  await expectVerificationError('Test 2', () => NCALayerService.verifySignature('NOT_A_VALID_BASE64_CMS'), 'INVALID_CMS_STRUCTURE');

  // Test 3: GOST Algorithm 501 Not Implemented rejection
  console.log('[Test 3] Testing GOST 34.310 signature rejection...');
  const gostOidAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.398.3.10.1').getBytes())
  ]);
  const gostDer = forge.asn1.toDer(gostOidAsn1).getBytes();
  const gostBase64 = forge.util.encode64(gostDer);
  await expectVerificationError('Test 3', () => NCALayerService.verifySignature(gostBase64), 'UNSUPPORTED_ALGORITHM');

  // Test 4: Real RSA X.509 CMS Generation and Verification (happy path)
  console.log('[Test 4] Generating real RSA X.509 certificate & PKCS#7 CMS signature...');
  const defaultExpectedContent = 'Test document content to sign';
  const { cmsBase64, cert: validCert } = generateRsaCmsSigned();

  console.log('[Test 4] Verifying generated RSA PKCS#7 CMS signature...');
  const realResult = await NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent });
  console.log('[Test 4 SUCCESS] Real RSA CMS parsed:', realResult);

  if (realResult.iin !== '850101300123' || realResult.bin !== '990240001122' || realResult.signedBy !== 'Иванов Иван Иванович') {
    throw new Error(`Real RSA CMS assertion failed! Got: ${JSON.stringify(realResult)}`);
  }

  // Test 5: Certificate Expiration Rejection
  console.log('[Test 5] Testing CERT_EXPIRED rejection...');
  await expectVerificationError(
    'Test 5',
    () => NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent, now: new Date(Date.now() + 365 * 2 * 24 * 3600 * 1000) }),
    'CERT_EXPIRED'
  );

  // ─────────────── NEGATIVE (SECURITY) TESTS ───────────────

  // Test 6: Corrupted/tampered signature bytes → SIGNATURE_INVALID
  console.log('[Test 6] Testing corrupted signature bytes rejection...');
  {
    const cmsBuffer = Buffer.from(cmsBase64, 'base64');
    const corrupted = Buffer.from(cmsBuffer);
    // Corrupt signature octets: flip bits in the last 32 bytes (RSA signature area)
    for (let i = corrupted.length - 32; i < corrupted.length; i++) {
      corrupted[i] = corrupted[i] ^ 0xFF;
    }
    const corruptedBase64 = corrupted.toString('base64');
    await expectVerificationError(
      'Test 6',
      () => NCALayerService.verifySignature(corruptedBase64, { expectedContent: defaultExpectedContent }),
      'SIGNATURE_INVALID'
    );
  }

  // Test 7: Mismatched cert/key pair → SIGNATURE_INVALID
  // Sign CMS with keyA's private key, but embed keyB's certificate (with keyB's public key)
  console.log('[Test 7] Testing mismatched cert/key pair rejection...');
  {
    const keysA = forge.pki.rsa.generateKeyPair(2048);
    // Generate CMS using keysA private key but a cert containing a different public key
    const { cmsBase64: mismatchedCms } = generateRsaCmsSigned({
      signWithKey: keysA.privateKey // sign with keysA, but cert contains the default keysB public key
    });
    await expectVerificationError('Test 7', () => NCALayerService.verifySignature(mismatchedCms, { expectedContent: defaultExpectedContent }), 'SIGNATURE_INVALID');
  }

  // Test 8: Untrusted CA root → CHAIN_UNTRUSTED
  // Create a test root CA cert and configure NCA_ROOT_CERT_RSA_PATH to point at it,
  // then verify CMS signed by a cert from a different (non-trusted) root
  console.log('[Test 8] Testing untrusted CA root rejection...');
  {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Generate "trusted" root CA
    const rootKeys = forge.pki.rsa.generateKeyPair(2048);
    const rootCert = forge.pki.createCertificate();
    rootCert.publicKey = rootKeys.publicKey;
    rootCert.serialNumber = 'AAFF00';
    rootCert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
    rootCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    rootCert.setSubject([{ name: 'commonName', value: 'Test Trusted Root CA' }]);
    rootCert.setIssuer([{ name: 'commonName', value: 'Test Trusted Root CA' }]);
    const basicConstraintsExt = {
      name: 'basicConstraints',
      cA: true
    };
    rootCert.setExtensions([basicConstraintsExt]);
    rootCert.sign(rootKeys.privateKey, forge.md.sha256.create());
    const rootPem = forge.pki.certificateToPem(rootCert);

    // Write trusted root to temp file
    const tmpDir = os.tmpdir();
    const rootPath = path.join(tmpDir, `test-nca-root-${Date.now()}.pem`);
    fs.writeFileSync(rootPath, rootPem);

    // Set env vars to enable production-mode trust chain verification
    const origMock = process.env.NCALAYER_MOCK;
    const origRootPath = process.env.NCA_ROOT_CERT_RSA_PATH;
    const origOcsp = process.env.NCA_OCSP_URL;
    const origCrl = process.env.NCA_CRL_URL;

    try {
      process.env.NCALAYER_MOCK = 'true'; // keep mock to skip OCSP for this specific test
      process.env.NCA_ROOT_CERT_RSA_PATH = rootPath;

      // CMS was signed with a self-signed cert (not signed by our trusted root)
      await expectVerificationError('Test 8', () => NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent }), 'CHAIN_UNTRUSTED');
    } finally {
      // Restore original env vars
      if (origMock !== undefined) process.env.NCALAYER_MOCK = origMock;
      else delete process.env.NCALAYER_MOCK;
      if (origRootPath !== undefined) process.env.NCA_ROOT_CERT_RSA_PATH = origRootPath;
      else delete process.env.NCA_ROOT_CERT_RSA_PATH;
      if (origOcsp !== undefined) process.env.NCA_OCSP_URL = origOcsp;
      else delete process.env.NCA_OCSP_URL;
      if (origCrl !== undefined) process.env.NCA_CRL_URL = origCrl;
      else delete process.env.NCA_CRL_URL;

      try { fs.unlinkSync(rootPath); } catch {}
    }
  }

  // Test 9: Missing CA config in production mode → CHAIN_UNTRUSTED
  console.log('[Test 9] Testing missing CA config in production mode...');
  {
    const origMock = process.env.NCALAYER_MOCK;
    const origRootPath = process.env.NCA_ROOT_CERT_RSA_PATH;
    const origOcsp = process.env.NCA_OCSP_URL;
    const origCrl = process.env.NCA_CRL_URL;

    try {
      process.env.NCALAYER_MOCK = 'false';
      delete process.env.NCA_ROOT_CERT_RSA_PATH;
      delete process.env.NCA_OCSP_URL;
      delete process.env.NCA_CRL_URL;

      await expectVerificationError('Test 9', () => NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent }), 'CHAIN_UNTRUSTED');
    } finally {
      if (origMock !== undefined) process.env.NCALAYER_MOCK = origMock;
      else delete process.env.NCALAYER_MOCK;
      if (origRootPath !== undefined) process.env.NCA_ROOT_CERT_RSA_PATH = origRootPath;
      else delete process.env.NCA_ROOT_CERT_RSA_PATH;
      if (origOcsp !== undefined) process.env.NCA_OCSP_URL = origOcsp;
      else delete process.env.NCA_OCSP_URL;
      if (origCrl !== undefined) process.env.NCA_CRL_URL = origCrl;
      else delete process.env.NCA_CRL_URL;
    }
  }

  // Test 10: Revoked certificate via mock OCSP server → CERT_REVOKED
  console.log('[Test 10] Testing revoked certificate via mock OCSP server...');
  {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/ocsp-response' });
      res.end('REVOKED');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const ocspUrl = `http://127.0.0.1:${addr.port}`;

    const origMock = process.env.NCALAYER_MOCK;
    const origOcsp = process.env.NCA_OCSP_URL;

    try {
      process.env.NCALAYER_MOCK = 'true'; // keep mock to skip trust chain for this test
      process.env.NCA_OCSP_URL = ocspUrl;

      await expectVerificationError('Test 10', () => NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent }), 'CERT_REVOKED');
    } finally {
      if (origMock !== undefined) process.env.NCALAYER_MOCK = origMock;
      else delete process.env.NCALAYER_MOCK;
      if (origOcsp !== undefined) process.env.NCA_OCSP_URL = origOcsp;
      else delete process.env.NCA_OCSP_URL;
      server.close();
    }
  }

  // Test 11: OCSP server timeout / unavailable → REVOCATION_CHECK_FAILED
  console.log('[Test 11] Testing OCSP timeout/failure → REVOCATION_CHECK_FAILED...');
  {
    // Start a server that never responds (hangs)
    const server = http.createServer((_req, _res) => {
      // Intentionally never respond — simulate timeout
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const ocspUrl = `http://127.0.0.1:${addr.port}`;

    const origMock = process.env.NCALAYER_MOCK;
    const origOcsp = process.env.NCA_OCSP_URL;
    const origTimeout = process.env.NCA_REVOCATION_CHECK_TIMEOUT_MS;

    try {
      process.env.NCALAYER_MOCK = 'true'; // skip trust chain
      process.env.NCA_OCSP_URL = ocspUrl;
      process.env.NCA_REVOCATION_CHECK_TIMEOUT_MS = '500'; // 500ms timeout

      await expectVerificationError('Test 11', () => NCALayerService.verifySignature(cmsBase64, { expectedContent: defaultExpectedContent }), 'REVOCATION_CHECK_FAILED');
    } finally {
      if (origMock !== undefined) process.env.NCALAYER_MOCK = origMock;
      else delete process.env.NCALAYER_MOCK;
      if (origOcsp !== undefined) process.env.NCA_OCSP_URL = origOcsp;
      else delete process.env.NCA_OCSP_URL;
      if (origTimeout !== undefined) process.env.NCA_REVOCATION_CHECK_TIMEOUT_MS = origTimeout;
      else delete process.env.NCA_REVOCATION_CHECK_TIMEOUT_MS;
      server.close();
    }
  }

  // Test 12: CMS content mismatch → CONTENT_MISMATCH
  console.log('[Test 12] Testing CMS signature with mismatched content payload...');
  await expectVerificationError(
    'Test 12',
    () => NCALayerService.verifySignature(cmsBase64, { expectedContent: 'WRONG_PAYLOAD_STRING' }),
    'CONTENT_MISMATCH'
  );

  // Test 13: Missing expectedContent option for CMS signature → CONTENT_MISMATCH
  console.log('[Test 13] Testing CMS signature with missing expectedContent option...');
  await expectVerificationError(
    'Test 13',
    () => NCALayerService.verifySignature(cmsBase64),
    'CONTENT_MISMATCH'
  );

  console.log('=== ALL 13 NCALAYER VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runNcaLayerVerificationTest().catch((err) => {
  console.error('=== NCALAYER VERIFICATION SUITE FAILED ===', err);
  process.exit(1);
});
