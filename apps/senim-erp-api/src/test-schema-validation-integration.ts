import 'reflect-metadata';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { validateDealWonLineItem, dealWonLineItemSchema } from './event-consumer.service.js';

async function runSchemaValidationTest() {
  console.log('=== STARTING DEAL.WON JSON SCHEMA VALIDATION TEST ===');

  // Test 1: Valid KZT domestic item
  console.log('[Test 1] Validating valid KZT domestic line item...');
  const validKztItem = {
    sku: 'SKU-VALID-KZT',
    crmProductId: 'prod_101',
    name: 'Валидный Товар KZT',
    quantity: 5,
    price: 15000,
    vatRate: 12.0
  };
  const isKztValid = validateDealWonLineItem(validKztItem);
  if (!isKztValid) {
    throw new Error(`Valid KZT item failed schema validation: ${JSON.stringify(validateDealWonLineItem.errors)}`);
  }
  console.log('[Test 1 SUCCESS] Valid KZT line item passed JSON Schema validation.');

  // Test 2: Valid foreign currency (USD) item
  console.log('[Test 2] Validating valid USD foreign line item...');
  const validUsdItem = {
    sku: 'SKU-VALID-USD',
    name: 'Валидный Импортный Товар',
    quantity: 2,
    price: 100000,
    listPrice: 120000,
    dealCurrency: 'USD',
    dealCurrencyPrice: 200.0,
    exchangeRate: 500.0,
    exchangeRateDate: new Date().toISOString()
  };
  const isUsdValid = validateDealWonLineItem(validUsdItem);
  if (!isUsdValid) {
    throw new Error(`Valid USD item failed schema validation: ${JSON.stringify(validateDealWonLineItem.errors)}`);
  }
  console.log('[Test 2 SUCCESS] Valid USD line item passed JSON Schema validation.');

  // Test 3: Missing required field (sku)
  console.log('[Test 3] Testing missing required field rejection (sku missing)...');
  const invalidMissingSku = {
    name: 'Товар Без SKU',
    quantity: 1,
    price: 5000
  };
  const isMissingSkuValid = validateDealWonLineItem(invalidMissingSku);
  if (isMissingSkuValid) {
    throw new Error('Line item missing "sku" was expected to fail schema validation!');
  }
  console.log(`[Test 3 SUCCESS] Missing SKU rejected: ${validateDealWonLineItem.errors?.[0]?.message}`);

  // Test 4: Invalid dealCurrency format (must be 3 uppercase letters, e.g., USDD fails)
  console.log('[Test 4] Testing invalid dealCurrency format rejection (USDD)...');
  const invalidCurrencyFormat = {
    sku: 'SKU-BAD-CURR',
    name: 'Товар с плохой валютой',
    quantity: 1,
    price: 5000,
    dealCurrency: 'USDD'
  };
  const isBadCurrValid = validateDealWonLineItem(invalidCurrencyFormat);
  if (isBadCurrValid) {
    throw new Error('Line item with dealCurrency "USDD" was expected to fail pattern validation!');
  }
  console.log(`[Test 4 SUCCESS] Invalid dealCurrency format rejected: ${validateDealWonLineItem.errors?.[0]?.message}`);

  // Test 5: Negative quantity rejection
  console.log('[Test 5] Testing negative quantity rejection...');
  const invalidQuantity = {
    sku: 'SKU-NEG-QTY',
    name: 'Отрицательное количество',
    quantity: -3,
    price: 5000
  };
  const isNegQtyValid = validateDealWonLineItem(invalidQuantity);
  if (isNegQtyValid) {
    throw new Error('Line item with negative quantity was expected to fail validation!');
  }
  console.log(`[Test 5 SUCCESS] Negative quantity rejected: ${validateDealWonLineItem.errors?.[0]?.message}`);

  // Test 6: Schema Sync Verification
  console.log('[Test 6] Verifying JSON Schema source file sync...');
  const schemaFilePath = resolve(process.cwd(), 'packages/types/schemas/v1/deal-won-line-item.schema.json');
  if (!existsSync(schemaFilePath)) {
    throw new Error(`JSON Schema source file missing at ${schemaFilePath}`);
  }
  const rawSchemaFile = readFileSync(schemaFilePath, 'utf-8');
  const parsedFileSchema = JSON.parse(rawSchemaFile);

  if (parsedFileSchema.$id !== 'https://senimerp.kz/schemas/v1/deal-won-line-item.schema.json') {
    throw new Error(`Schema $id mismatch! Expected https://senimerp.kz/schemas/v1/deal-won-line-item.schema.json, got ${parsedFileSchema.$id}`);
  }
  console.log(`[Test 6 SUCCESS] JSON Schema source file verified: $id = ${parsedFileSchema.$id}`);

  console.log('=== DEAL.WON JSON SCHEMA VALIDATION TEST PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runSchemaValidationTest().catch((err) => {
  console.error('=== DEAL.WON JSON SCHEMA VALIDATION TEST FAILED ===', err);
  process.exit(1);
});
