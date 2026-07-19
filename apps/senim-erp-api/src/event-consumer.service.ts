import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventBusSubscriber, redisConnection } from '@senimerp/event-bus-client';
import { DealWonPayload, ClientSyncedPayload, IntegrationEvent } from '@senimerp/types';
import { TenantPrismaService } from './prisma.service.js';

@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private subscriber!: EventBusSubscriber;

  constructor(private readonly prismaService: TenantPrismaService) {}

  onModuleInit() {
    // Start Event Bus subscriber mapping handlers
    this.subscriber = new EventBusSubscriber(undefined, {
      'deal.won': this.handleDealWon.bind(this),
      'client.created': this.handleClientSynced.bind(this),
      'client.updated': this.handleClientSynced.bind(this)
    }, { ...redisConnection, db: 1 } as any);
    console.log('[EventConsumer] BullMQ subscriber started for Integration Bus');
  }

  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.close();
    }
  }

  /**
   * Processes a client synchronization event from CRM.
   */
  async handleClientSynced(event: IntegrationEvent<ClientSyncedPayload>) {
    const { tenantId, eventId } = event;
    const { customerId, name, bin, address, email, phone } = event.payload;

    console.log(`[EventConsumer] Processing client sync event: ${eventId} (Tenant: ${tenantId})`);

    // Ensure database schema is provisioned for this tenant
    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    try {
      await db.$transaction(async (tx: any) => {
        // Idempotency check inside transaction
        await tx.processedEvent.create({
          data: {
            id: eventId,
            eventType: event.eventType
          }
        });

        // Upsert customer record
        await tx.customer.upsert({
          where: { bin },
          update: {
            crmId: customerId,
            name,
            address,
            email,
            phone
          },
          create: {
            crmId: customerId,
            name,
            bin,
            address,
            email,
            phone
          }
        });
      });

      console.log(`[EventConsumer] Customer ${name} (BIN: ${bin}) synced successfully.`);
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('id')) {
        console.warn(`[EventConsumer] Event ${eventId} was already processed. Skipping.`);
        return;
      }
      throw e;
    }
  }

  /**
   * Processes a deal won event, splitting products into Invoices, Waybills, and Service Acts.
   */
  async handleDealWon(event: IntegrationEvent<DealWonPayload>) {
    const { tenantId, eventId } = event;
    const { dealId, customerId, customerName, customerBin, customerAddress, customerEmail, customerPhone, items } = event.payload;

    console.log(`[EventConsumer] Processing deal.won event: ${eventId} (Deal: ${dealId})`);

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    try {
      // Run dynamic transaction to write all ERP documents
      await db.$transaction(async (tx: any) => {
        await tx.processedEvent.create({
          data: {
            id: eventId,
            eventType: event.eventType
          }
        });

        // 1. Ensure customer exists
      const customer = await tx.customer.upsert({
        where: { bin: customerBin },
        update: {
          crmId: customerId,
          name: customerName,
          address: customerAddress,
          email: customerEmail,
          phone: customerPhone
        },
        create: {
          crmId: customerId,
          name: customerName,
          bin: customerBin,
          address: customerAddress,
          email: customerEmail,
          phone: customerPhone
        }
      });

      // Split items into Physical Goods (Waybills) vs Services (Acts of Completed Works)
      const physicalItems = items.filter((item: any) => !item.sku.startsWith('SRV-'));
      const serviceItems = items.filter((item: any) => item.sku.startsWith('SRV-'));

      // Calculate totals for Invoice
      let totalVat = 0;
      let totalAmount = 0;

      const invoiceLines = items.map((item: any) => {
        const vatRate = item.vatRate || 12; // Standard Kazakhstani VAT
        const lineTotalExcludingVat = item.quantity * item.price;
        const lineVat = lineTotalExcludingVat * (vatRate / 100);
        const lineTotalIncludingVat = lineTotalExcludingVat + lineVat;

        totalVat += lineVat;
        totalAmount += lineTotalIncludingVat;

        return {
          sku: item.sku,
          crmProductId: item.crmProductId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          vatRate,
          vatAmount: lineVat,
          totalAmount: lineTotalIncludingVat
        };
      });

      // 2. Create payment Invoice
      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 14); // 14 days payment term

      const invoice = await tx.invoice.create({
        data: {
          number: invoiceNumber,
          customerId: customer.id,
          amount: totalAmount,
          vatAmount: totalVat,
          paidAmount: 0.00,
          status: 'DRAFT',
          dueDate,
          crmDealId: dealId,
          items: {
            create: invoiceLines
          }
        }
      });
      console.log(`[EventConsumer] Draft Invoice created: ${invoice.number} (${totalAmount} KZT)`);

      // 3. Create Waybill if there are physical goods
      if (physicalItems.length > 0) {
        let waybillVat = 0;
        let waybillTotal = 0;

        const waybillLines = physicalItems.map((item: any) => {
          const vatRate = item.vatRate || 12;
          const totalExcludingVat = item.quantity * item.price;
          const vat = totalExcludingVat * (vatRate / 100);
          const totalWithVat = totalExcludingVat + vat;

          waybillVat += vat;
          waybillTotal += totalWithVat;

          return {
            sku: item.sku,
            crmProductId: item.crmProductId,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            vatRate,
            vatAmount: vat,
            totalAmount: totalWithVat
          };
        });

        const waybillNumber = `WAY-${Date.now().toString().slice(-6)}`;
        await tx.waybill.create({
          data: {
            number: waybillNumber,
            customerId: customer.id,
            amount: waybillTotal,
            vatAmount: waybillVat,
            status: 'DRAFT',
            crmDealId: dealId,
            items: {
              create: waybillLines
            }
          }
        });
        console.log(`[EventConsumer] Draft Waybill created: ${waybillNumber} for goods.`);
      }

      // 4. Create Service Act if there are services
      if (serviceItems.length > 0) {
        let actVat = 0;
        let actTotal = 0;

        const actLines = serviceItems.map((item: any) => {
          const vatRate = item.vatRate || 12;
          const totalExcludingVat = item.quantity * item.price;
          const vat = totalExcludingVat * (vatRate / 100);
          const totalWithVat = totalExcludingVat + vat;

          actVat += vat;
          actTotal += totalWithVat;

          return {
            sku: item.sku,
            crmProductId: item.crmProductId,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            vatRate,
            vatAmount: vat,
            totalAmount: totalWithVat
          };
        });

        const actNumber = `ACT-${Date.now().toString().slice(-6)}`;
        await tx.serviceAct.create({
          data: {
            number: actNumber,
            customerId: customer.id,
            amount: actTotal,
            vatAmount: actVat,
            status: 'DRAFT',
            crmDealId: dealId,
            items: {
              create: actLines
            }
          }
        });
        console.log(`[EventConsumer] Draft Service Act created: ${actNumber} for services.`);
      }
    });

    console.log(`[EventConsumer] Event deal.won processed successfully. Database transaction completed.`);
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('id')) {
        console.warn(`[EventConsumer] Event ${eventId} was already processed. Skipping.`);
        return;
      }
      throw e;
    }
  }
}
