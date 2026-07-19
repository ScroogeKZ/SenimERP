import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { EventBusPublisher, EventBusSubscriber, redisConnection } from '@senimerp/event-bus-client';
import { IntegrationEvent, DealWonPayload, InvoicePaidPayload, ShipmentCompletedPayload } from '@senimerp/types';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3002;

const publisher = new EventBusPublisher(undefined, { ...redisConnection, db: 1 } as any);

// In-memory simulator of CRM deal states
const MOCK_DEALS = new Map<string, { 
  id: string; 
  status: string; 
  paymentStatus: string; 
  shipmentStatus: string; 
  amount: number;
}>();

// Initialize with a test deal so it always exists on startup for testing
MOCK_DEALS.set('deal_test_101', {
  id: 'deal_test_101',
  status: 'OPEN',
  paymentStatus: 'UNPAID',
  shipmentStatus: 'PENDING',
  amount: 450000
});

app.post('/api/deals/win', async (req, res) => {
  const { dealId, tenantId, customerId, customerName, customerBin, customerAddress, amount, items } = req.body;
  
  MOCK_DEALS.set(dealId, {
    id: dealId,
    status: 'WON',
    paymentStatus: 'UNPAID',
    shipmentStatus: 'PENDING',
    amount
  });

  const event: IntegrationEvent<DealWonPayload> = {
    eventId: crypto.randomUUID(),
    eventType: 'deal.won',
    tenantId,
    timestamp: new Date().toISOString(),
    payload: {
      dealId,
      customerId,
      customerName,
      customerBin,
      customerAddress,
      amount,
      items
    }
  };

  try {
    await publisher.publishEvent(event);
    console.log(`[CRM API] Published deal.won event: ${event.eventId} for deal ${dealId}`);
    res.json({ success: true, eventId: event.eventId, deal: MOCK_DEALS.get(dealId) });
  } catch (error) {
    console.error('[CRM API] Failed to publish event:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/deals/:id', (req, res) => {
  const deal = MOCK_DEALS.get(req.params.id);
  if (!deal) {
    return res.status(404).json({ error: 'Deal not found' });
  }
  res.json(deal);
});

// Register Event Bus Subscriber for incoming updates from ERP
new EventBusSubscriber(undefined, {
  'invoice.paid': async (event: IntegrationEvent<InvoicePaidPayload>) => {
    const { dealId, paymentStatus } = event.payload;
    if (dealId && MOCK_DEALS.has(dealId)) {
      const deal = MOCK_DEALS.get(dealId)!;
      deal.paymentStatus = paymentStatus;
      MOCK_DEALS.set(dealId, deal);
      console.log(`[CRM API Subscriber] Event 'invoice.paid' processed. Deal ${dealId} payment: ${deal.paymentStatus}`);
    }
  },
  'shipment.completed': async (event: IntegrationEvent<ShipmentCompletedPayload>) => {
    const { dealId, fulfillmentStatus } = event.payload;
    if (dealId && MOCK_DEALS.has(dealId)) {
      const deal = MOCK_DEALS.get(dealId)!;
      deal.shipmentStatus = fulfillmentStatus;
      MOCK_DEALS.set(dealId, deal);
      console.log(`[CRM API Subscriber] Event 'shipment.completed' processed. Deal ${dealId} shipment: ${deal.shipmentStatus}`);
    }
  }
}, { ...redisConnection, db: 0 } as any);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock CRM API running on http://localhost:${PORT}`);
});
