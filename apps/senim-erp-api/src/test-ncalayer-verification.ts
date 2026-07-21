import { NCALayerService, NCALayerVerificationError } from '@senimerp/integrations';
import forge from 'node-forge';

async function runNcaLayerVerificationTest() {
  console.log('=== STARTING NCALAYER VERIFICATION SUITE ===');

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
  let invalidStructureCaught = false;
  try {
    await NCALayerService.verifySignature('NOT_A_VALID_BASE64_CMS');
  } catch (err: any) {
    if (err instanceof NCALayerVerificationError && err.code === 'INVALID_CMS_STRUCTURE') {
      invalidStructureCaught = true;
      console.log('[Test 2 SUCCESS] Invalid CMS structure rejected with code INVALID_CMS_STRUCTURE.');
    }
  }
  if (!invalidStructureCaught) {
    throw new Error('Test 2 failed: Invalid CMS structure was not properly rejected!');
  }

  // Test 3: GOST Algorithm 501 Not Implemented rejection
  console.log('[Test 3] Testing GOST 34.310 signature rejection...');
  // Create dummy PKCS#7 structure containing GOST OID
  const gostOidAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer('1.2.398.3.10.1').getBytes())
  ]);
  const gostDer = forge.asn1.toDer(gostOidAsn1).getBytes();
  const gostBase64 = forge.util.encode64(gostDer);

  let gostCaught = false;
  try {
    await NCALayerService.verifySignature(gostBase64);
  } catch (err: any) {
    if (err instanceof NCALayerVerificationError && err.code === 'UNSUPPORTED_ALGORITHM') {
      gostCaught = true;
      console.log('[Test 3 SUCCESS] GOST 34.310 signature correctly rejected with code UNSUPPORTED_ALGORITHM.');
    }
  }
  if (!gostCaught) {
    throw new Error('Test 3 failed: GOST signature was not rejected with UNSUPPORTED_ALGORITHM!');
  }

  // Test 4: Real RSA X.509 CMS Generation and Verification
  console.log('[Test 4] Generating real RSA X.509 certificate & PKCS#7 CMS signature...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0123456789ABCDEF';
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 3600 * 1000 * 24 * 365); // 1 year valid

  cert.setSubject([
    { name: 'commonName', value: forge.util.encodeUtf8('Иванов Иван Иванович') },
    { type: '1.2.398.3.3.2.1', value: 'IIN850101300123' },
    { type: '1.2.398.3.3.2.2', value: 'BIN990240001122' }
  ]);
  cert.setIssuer([
    { name: 'commonName', value: forge.util.encodeUtf8('НУЦ РК RSA (NCA RK)') }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Create PKCS#7 SignedData
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer('Test document content to sign', 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: keys.privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256
  });
  p7.sign();
  const derBuf = forge.asn1.toDer(p7.toAsn1());
  const cmsBase64 = Buffer.from(derBuf.getBytes(), 'binary').toString('base64');

  console.log('[Test 4] Verifying generated RSA PKCS#7 CMS signature...');
  const realResult = await NCALayerService.verifySignature(cmsBase64);
  console.log('[Test 4 SUCCESS] Real RSA CMS parsed:', realResult);

  if (realResult.iin !== '850101300123' || realResult.bin !== '990240001122' || realResult.signedBy !== 'Иванов Иван Иванович') {
    throw new Error(`Real RSA CMS assertion failed! Got: ${JSON.stringify(realResult)}`);
  }

  // Test 5: Certificate Expiration Rejection
  console.log('[Test 5] Testing CERT_EXPIRED rejection...');
  let expiredCaught = false;
  try {
    await NCALayerService.verifySignature(cmsBase64, { now: new Date(Date.now() + 365 * 2 * 24 * 3600 * 1000) });
  } catch (err: any) {
    if (err instanceof NCALayerVerificationError && err.code === 'CERT_EXPIRED') {
      expiredCaught = true;
      console.log('[Test 5 SUCCESS] Expired certificate correctly rejected with CERT_EXPIRED.');
    }
  }
  if (!expiredCaught) {
    throw new Error('Test 5 failed: Expired certificate was not rejected with CERT_EXPIRED!');
  }

  console.log('=== ALL NCALAYER VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runNcaLayerVerificationTest().catch((err) => {
  console.error('=== NCALAYER VERIFICATION SUITE FAILED ===', err);
  process.exit(1);
});
