import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EventConsumerService } from './event-consumer.service.js';
import { IntegrationEvent, RefundConfirmedPayload } from '@senimerp/types';

import { TenantPrismaService } from './prisma.service.js';

async function runTest() {
  console.log('=== STARTING REFUND CONFIRMED INTEGRATION TEST ===');

  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  const port = process.env.PORT || 3008;
  await app.listen(port);

  const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
  const tenantId = `refund_tenant_${Date.now()}`;
  const schemaName = `tenant_${tenantId}`;

  const rawPublicClient = new PrismaClient({
    datasources: { db: { url: `${baseDbUrl}?schema=public` } }
  });
  await rawPublicClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  await rawPublicClient.$disconnect();

  const eventConsumer = app.get(EventConsumerService);
  const tenantPrisma = app.get(TenantPrismaService);

  // Trigger tenant schema creation
  await tenantPrisma.ensureTenantSchema(tenantId);

  const db = tenantPrisma.getClient(tenantId);

  // Create prerequisite records: Customer, Waybill/RMA, CreditNote
  const customerId = `cust_${Date.now()}`;
  const bin = `99${Math.floor(100000000 + Math.random() * 900000000)}`;
  await db.customer.create({
    data: {
      id: customerId,
      name: 'Test Customer',
      bin
    }
  });

  const waybillId = `wb_${Date.now()}`;
  await db.waybill.create({
    data: {
      id: waybillId,
      number: `WAY-${Date.now()}`,
      customerId,
      amount: 50000,
      vatAmount: 5357.14,
      status: 'DELIVERED'
    }
  });

  const rmaId = `rma_${Date.now()}`;
  await db.rma.create({
    data: {
      id: rmaId,
      number: `RMA-${Date.now()}`,
      waybillId,
      status: 'CONFIRMED'
    }
  });

  const creditNoteId = `cn_${Date.now()}`;
  const creditNote = await db.creditNote.create({
    data: {
      id: creditNoteId,
      number: `CN-${Date.now()}`,
      rmaId,
      customerId,
      amount: 50000,
      vatAmount: 5357.14,
      status: 'ISSUED'
    }
  });

  console.log(`[Test] Created CreditNote ${creditNote.id} with amount ${creditNote.amount}`);
  console.log(`[Test] Initial refundStatus=${creditNote.refundStatus}, refundedAmount=${creditNote.refundedAmount}`);

  // Partial refund event (20,000 KZT)
  const event1Id = `evt_refund_1_${Date.now()}`;
  const confirmTime1 = new Date().toISOString();
  const event1: IntegrationEvent<RefundConfirmedPayload> = {
    eventId: event1Id,
    eventType: 'refund.confirmed',
    tenantId,
    timestamp: confirmTime1,
    payload: {
      dealId: `deal_${Date.now()}`,
      creditNoteId,
      creditNoteNumber: creditNote.number,
      amount: 20000,
      provider: 'kaspi',
      referenceId: 'KASPI-REF-1001',
      confirmedAt: confirmTime1
    }
  };

  await eventConsumer.handleRefundConfirmed(event1);

  let updatedCn = await db.creditNote.findUnique({ where: { id: creditNoteId } });
  console.log(`[Test] After partial refund (20000 KZT): refundedAmount=${updatedCn?.refundedAmount}, refundStatus=${updatedCn?.refundStatus}, provider=${updatedCn?.refundProvider}, refId=${updatedCn?.refundReferenceId}`);

  if (Number(updatedCn?.refundedAmount) !== 20000 || updatedCn?.refundStatus !== 'pending') {
    throw new Error(`Partial refund assertion failed! Expected 20000 & pending, got ${updatedCn?.refundedAmount} & ${updatedCn?.refundStatus}`);
  }

  // Duplicate event test (idempotency check)
  console.log('[Test] Re-dispatching same event to test idempotency...');
  await eventConsumer.handleRefundConfirmed(event1);

  updatedCn = await db.creditNote.findUnique({ where: { id: creditNoteId } });
  if (Number(updatedCn?.refundedAmount) !== 20000) {
    throw new Error(`Idempotency check failed! Amount incremented on duplicate event to ${updatedCn?.refundedAmount}`);
  }
  console.log('[Test] Idempotency check PASSED (refundedAmount remained 20000).');

  // Final refund event (30,000 KZT remaining -> total 50,000)
  const event2Id = `evt_refund_2_${Date.now()}`;
  const confirmTime2 = new Date().toISOString();
  const event2: IntegrationEvent<RefundConfirmedPayload> = {
    eventId: event2Id,
    eventType: 'refund.confirmed',
    tenantId,
    timestamp: confirmTime2,
    payload: {
      dealId: `deal_${Date.now()}`,
      creditNoteId,
      creditNoteNumber: creditNote.number,
      amount: 30000,
      provider: 'halyk',
      referenceId: 'HALYK-REF-2002',
      confirmedAt: confirmTime2
    }
  };

  await eventConsumer.handleRefundConfirmed(event2);

  updatedCn = await db.creditNote.findUnique({ where: { id: creditNoteId } });
  console.log(`[Test] After full refund (total 50000 KZT): refundedAmount=${updatedCn?.refundedAmount}, refundStatus=${updatedCn?.refundStatus}, provider=${updatedCn?.refundProvider}, refId=${updatedCn?.refundReferenceId}`);

  if (Number(updatedCn?.refundedAmount) !== 50000 || updatedCn?.refundStatus !== 'refunded') {
    throw new Error(`Full refund assertion failed! Expected 50000 & refunded, got ${updatedCn?.refundedAmount} & ${updatedCn?.refundStatus}`);
  }

  console.log('=== REFUND CONFIRMED INTEGRATION TEST PASSED SUCCESSFULLY ===');
  await app.close();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test Failure]', err);
  process.exit(1);
});
