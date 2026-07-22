import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as eventBusClient from '@senimerp/event-bus-client';

// Stub EventBusPublisher class before importing EventConsumerService to prevent Redis connections
(eventBusClient as any).EventBusPublisher = class MockEventBusPublisher {
  async publishEvent() {}
  async close() {}
};

import { EventConsumerService } from './event-consumer.service.js';

describe('EventConsumerService - handleDealWon (stock.shortage_detected)', () => {
  let service: EventConsumerService;
  let mockPrismaService: any;
  let mockDbClient: any;
  let mockPublisher: any;
  let mockTx: any;

  const sampleEvent: any = {
    eventId: 'evt-deal-won-123',
    eventType: 'deal.won',
    tenantId: 'tenant-456',
    timestamp: new Date().toISOString(),
    payload: {
      dealId: 'deal-789',
      customerId: 'cust-1',
      customerName: 'Test LLC',
      customerBin: '123456789012',
      customerAddress: 'Almaty',
      customerEmail: 'test@example.com',
      customerPhone: '+77001112233',
      items: [
        {
          sku: 'ITEM-SHORT',
          crmProductId: 'prod-1',
          name: 'Item Shortage Test',
          quantity: 10,
          price: 1000
        }
      ]
    }
  };

  beforeEach(() => {
    mockTx = {
      processedEvent: { create: mock.fn(async () => ({})) },
      customer: { upsert: mock.fn(async () => ({ id: 'cust-db-id' })) },
      invoice: { create: mock.fn(async () => ({ number: 'INV-2026-0001' })) },
      waybill: { create: mock.fn(async () => ({ number: 'WAY-2026-0001' })) },
      serviceAct: { create: mock.fn(async () => ({ number: 'ACT-2026-0001' })) },
      warehouse: { findFirst: mock.fn(async () => ({ id: 'wh-main' })) },
      stockItem: {
        findUnique: mock.fn(async () => ({ quantity: 3, reserved: 0 })), // physical=3, reserved will become 10 -> shortage=7
        update: mock.fn(async () => ({})),
        create: mock.fn(async () => ({}))
      },
      $queryRaw: mock.fn(async () => [{ nextval: BigInt(1) }])
    };

    mockDbClient = {
      $transaction: mock.fn(async (cb: any) => cb(mockTx))
    };

    mockPrismaService = {
      ensureTenantSchema: mock.fn(async () => {}),
      getClient: mock.fn(() => mockDbClient)
    };

    service = new EventConsumerService(mockPrismaService);

    mockPublisher = {
      publishEvent: mock.fn(async () => {})
    };
    (service as any).publisher = mockPublisher;
  });

  it('Test-Case 1: Successful scenario with shortage - publishes event after transaction commit with deterministic eventId', async () => {
    let transactionCommitted = false;

    mockDbClient.$transaction = mock.fn(async (cb: any) => {
      const res = await cb(mockTx);
      transactionCommitted = true;
      return res;
    });

    await service.handleDealWon(sampleEvent);

    // Verify transaction completed before publishEvent was called
    assert.strictEqual(transactionCommitted, true, 'Transaction should have committed');
    assert.strictEqual(mockPublisher.publishEvent.mock.callCount(), 1);

    const publishedArg = mockPublisher.publishEvent.mock.calls[0].arguments[0];
    assert.strictEqual(publishedArg.eventId, 'evt-deal-won-123:shortage:wh-main:ITEM-SHORT');
    assert.strictEqual(publishedArg.eventType, 'stock.shortage_detected');
    assert.strictEqual(publishedArg.tenantId, 'tenant-456');
    assert.deepStrictEqual(publishedArg.payload, {
      dealId: 'deal-789',
      sku: 'ITEM-SHORT',
      requestedQuantity: 10,
      physicalQuantity: 3,
      reservedQuantity: 10,
      shortageQuantity: 7,
      warehouseId: 'wh-main'
    });
  });

  it('Test-Case 2: Rollback after shortage detected - does NOT publish shortage event if transaction fails', async () => {
    // Simulate error during Service Act step (after waybill/reservation step)
    mockTx.serviceAct.create = mock.fn(async () => {
      throw new Error('ServiceAct database error!');
    });

    // Add a service item to trigger Service Act creation
    const eventWithService = {
      ...sampleEvent,
      payload: {
        ...sampleEvent.payload,
        items: [
          ...sampleEvent.payload.items,
          { sku: 'SRV-CONSULT', name: 'Consulting', quantity: 1, price: 5000 }
        ]
      }
    };

    await assert.rejects(async () => {
      await service.handleDealWon(eventWithService);
    }, /ServiceAct database error!/);

    // Assert that publishEvent was NEVER called because transaction rolled back
    assert.strictEqual(mockPublisher.publishEvent.mock.callCount(), 0);
  });

  it('Test-Case 3: Retry with same eventId produces identical deterministic shortage eventId for BullMQ deduplication', async () => {
    await service.handleDealWon(sampleEvent);

    const firstPublishEventId = mockPublisher.publishEvent.mock.calls[0].arguments[0].eventId;

    // Reset mock counts
    mockPublisher.publishEvent.mock.resetCalls();

    // Call handleDealWon again with the exact same incoming event
    await service.handleDealWon(sampleEvent);

    const secondPublishEventId = mockPublisher.publishEvent.mock.calls[0].arguments[0].eventId;

    assert.strictEqual(firstPublishEventId, 'evt-deal-won-123:shortage:wh-main:ITEM-SHORT');
    assert.strictEqual(secondPublishEventId, firstPublishEventId, 'eventId must be deterministic across retries');
  });

  it('Test-Case 4: Multiple shortage SKUs in one deal - publishes multiple events with unique deterministic IDs post-commit', async () => {
    const multiShortageEvent = {
      ...sampleEvent,
      payload: {
        ...sampleEvent.payload,
        items: [
          { sku: 'SKU-A', quantity: 5, price: 100 },
          { sku: 'SKU-B', quantity: 8, price: 200 }
        ]
      }
    };

    mockTx.stockItem.findUnique = mock.fn(async ({ where }: any) => {
      if (where.sku_warehouseId.sku === 'SKU-A') {
        return { quantity: 2, reserved: 0 }; // physical=2, reserved=5 -> shortage=3
      }
      if (where.sku_warehouseId.sku === 'SKU-B') {
        return { quantity: 1, reserved: 0 }; // physical=1, reserved=8 -> shortage=7
      }
      return null;
    });

    await service.handleDealWon(multiShortageEvent);

    assert.strictEqual(mockPublisher.publishEvent.mock.callCount(), 2);

    const firstEvent = mockPublisher.publishEvent.mock.calls[0].arguments[0];
    const secondEvent = mockPublisher.publishEvent.mock.calls[1].arguments[0];

    assert.strictEqual(firstEvent.eventId, 'evt-deal-won-123:shortage:wh-main:SKU-A');
    assert.strictEqual(firstEvent.payload.sku, 'SKU-A');
    assert.strictEqual(firstEvent.payload.shortageQuantity, 3);

    assert.strictEqual(secondEvent.eventId, 'evt-deal-won-123:shortage:wh-main:SKU-B');
    assert.strictEqual(secondEvent.payload.sku, 'SKU-B');
    assert.strictEqual(secondEvent.payload.shortageQuantity, 7);
  });

  it('Test-Case 5: Publisher failure does not throw or fail the handler', async () => {
    mockPublisher.publishEvent = mock.fn(async () => {
      throw new Error('Redis connection failed!');
    });

    // Should complete cleanly without throwing exception
    await service.handleDealWon(sampleEvent);

    assert.strictEqual(mockPublisher.publishEvent.mock.callCount(), 1);
  });
});
