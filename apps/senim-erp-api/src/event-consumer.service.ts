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
      'client.updated': this.handleClientSynced.bind(this),
      'marketplace.order.received': this.handleMarketplaceOrderReceived.bind(this),
      'marketplace.order.cancelled': this.handleMarketplaceOrderCancelled.bind(this)
    });
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

      // Helper for calculating line item discount metadata
      const calculateLineDiscount = (listPrice: number | null | undefined, unitPrice: number, quantity: number) => {
        const originalPrice = listPrice != null ? Number(listPrice) : null;
        const discountAmount = originalPrice != null ? (originalPrice - unitPrice) * quantity : 0;
        const discountPercent = originalPrice != null && originalPrice > 0 ? ((originalPrice - unitPrice) / originalPrice) * 100 : 0;
        return {
          originalPrice,
          discountAmount: Number(discountAmount.toFixed(2)),
          discountPercent: Number(discountPercent.toFixed(2))
        };
      };

      const invoiceLines = items.map((item: any) => {
        const vatRate = item.vatRate || 12; // Standard Kazakhstani VAT
        const lineTotalExcludingVat = item.quantity * item.price;
        const lineVat = lineTotalExcludingVat * (vatRate / 100);
        const lineTotalIncludingVat = lineTotalExcludingVat + lineVat;

        totalVat += lineVat;
        totalAmount += lineTotalIncludingVat;

        const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

        return {
          sku: item.sku,
          crmProductId: item.crmProductId,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          originalPrice: discountInfo.originalPrice,
          discountAmount: discountInfo.discountAmount,
          discountPercent: discountInfo.discountPercent,
          dealCurrency: item.dealCurrency ?? null,
          dealCurrencyPrice: item.dealCurrencyPrice ?? null,
          exchangeRate: item.exchangeRate ?? null,
          exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
          vatRate,
          vatAmount: lineVat,
          totalAmount: lineTotalIncludingVat
        };
      });

      // 2. Create payment Invoice
      const year = new Date().getFullYear();
      const [{ nextval: invSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
        SELECT nextval('invoice_number_seq') as nextval;
      `;
      const invoiceNumber = `INV-${year}-${invSeq.toString().padStart(4, '0')}`;
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

          const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

          return {
            sku: item.sku,
            crmProductId: item.crmProductId,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            originalPrice: discountInfo.originalPrice,
            discountAmount: discountInfo.discountAmount,
            discountPercent: discountInfo.discountPercent,
            dealCurrency: item.dealCurrency ?? null,
            dealCurrencyPrice: item.dealCurrencyPrice ?? null,
            exchangeRate: item.exchangeRate ?? null,
            exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
            vatRate,
            vatAmount: vat,
            totalAmount: totalWithVat
          };
        });

        const [{ nextval: wbSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
          SELECT nextval('waybill_number_seq') as nextval;
        `;
        const waybillNumber = `WAY-${year}-${wbSeq.toString().padStart(4, '0')}`;
        const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
        const defaultWarehouseId = defaultWarehouse?.id || 'default-main-warehouse';

        await tx.waybill.create({
          data: {
            number: waybillNumber,
            customerId: customer.id,
            warehouseId: defaultWarehouseId,
            amount: waybillTotal,
            vatAmount: waybillVat,
            status: 'DRAFT',
            crmDealId: dealId,
            items: {
              create: waybillLines
            }
          }
        });

        for (const line of waybillLines) {
          const existing = await tx.stockItem.findUnique({
            where: { sku_warehouseId: { sku: line.sku, warehouseId: defaultWarehouseId } }
          });
          if (existing) {
            await tx.stockItem.update({
              where: { sku_warehouseId: { sku: line.sku, warehouseId: defaultWarehouseId } },
              data: { reserved: { increment: line.quantity } }
            });
            if (Number(existing.reserved) + Number(line.quantity) > Number(existing.quantity)) {
              console.warn(`[EventConsumer] Over-reservation for SKU ${line.sku} at warehouse ${defaultWarehouseId}: reserved exceeds physical quantity.`);
            }
          } else {
            await tx.stockItem.create({
              data: { sku: line.sku, warehouseId: defaultWarehouseId, quantity: 0, reserved: line.quantity }
            });
            console.warn(`[EventConsumer] Reserving SKU ${line.sku} at warehouse ${defaultWarehouseId} with zero physical stock.`);
          }
        }

        console.log(`[EventConsumer] Draft Waybill created: ${waybillNumber} for goods on warehouse ${defaultWarehouseId}.`);
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

          const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

          return {
            sku: item.sku,
            crmProductId: item.crmProductId,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            originalPrice: discountInfo.originalPrice,
            discountAmount: discountInfo.discountAmount,
            discountPercent: discountInfo.discountPercent,
            dealCurrency: item.dealCurrency ?? null,
            dealCurrencyPrice: item.dealCurrencyPrice ?? null,
            exchangeRate: item.exchangeRate ?? null,
            exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
            vatRate,
            vatAmount: vat,
            totalAmount: totalWithVat
          };
        });

        const [{ nextval: actSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
          SELECT nextval('act_number_seq') as nextval;
        `;
        const actNumber = `ACT-${year}-${actSeq.toString().padStart(4, '0')}`;
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

  /**
   * Processes a marketplace.order.received event from CRM.
   */
  async handleMarketplaceOrderReceived(event: IntegrationEvent<any>) {
    const { tenantId, eventId } = event;
    const {
      marketplaceOrderId,
      accountId,
      warehouseId,
      buyerBinIin,
      buyerName,
      requiresEsf,
      items,
      totalAmount
    } = event.payload;

    console.log(`[EventConsumer] Processing marketplace.order.received event: ${eventId} (Order: ${marketplaceOrderId})`);

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    try {
      await db.$transaction(async (tx: any) => {
        await tx.processedEvent.create({
          data: {
            id: eventId,
            eventType: event.eventType
          }
        });

        // 1. Setup Customer (By BIN if provided, otherwise default Kaspi retail customer)
        const customerBin = buyerBinIin && String(buyerBinIin).trim().length > 0 ? String(buyerBinIin).trim() : '990000000000';
        const customerName = buyerBinIin && String(buyerBinIin).trim().length > 0
          ? (buyerName || 'Покупатель Kaspi')
          : 'Kaspi.kz Магазин — Розница';

        const customer = await tx.customer.upsert({
          where: { bin: customerBin },
          update: {
            name: customerName
          },
          create: {
            name: customerName,
            bin: customerBin
          }
        });

        // 2. Determine target warehouse
        let targetWarehouseId = warehouseId;
        if (!targetWarehouseId) {
          const defaultWh = await tx.warehouse.findFirst({ where: { isDefault: true } });
          targetWarehouseId = defaultWh?.id || 'default-main-warehouse';
        }

        // 3. Stock reservation for each physical item
        for (const item of items) {
          const existing = await tx.stockItem.findUnique({
            where: { sku_warehouseId: { sku: item.sku, warehouseId: targetWarehouseId } }
          });

          if (existing) {
            await tx.stockItem.update({
              where: { sku_warehouseId: { sku: item.sku, warehouseId: targetWarehouseId } },
              data: { reserved: { increment: item.quantity } }
            });
          } else {
            await tx.stockItem.create({
              data: {
                sku: item.sku,
                crmProductId: item.crmProductId || null,
                warehouseId: targetWarehouseId,
                quantity: 0,
                reserved: item.quantity
              }
            });
          }
        }

        // 4. Calculate line items totals
        let totalVat = 0;
        let calculatedTotal = 0;

        const waybillLines = items.map((item: any) => {
          const vatRate = item.vatRate || 12;
          const totalExcludingVat = item.quantity * item.price;
          const vat = totalExcludingVat * (vatRate / 100);
          const totalWithVat = totalExcludingVat + vat;

          totalVat += vat;
          calculatedTotal += totalWithVat;

          return {
            sku: item.sku,
            crmProductId: item.crmProductId || null,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            vatRate,
            vatAmount: vat,
            totalAmount: totalWithVat
          };
        });

        // 5. Create Waybill
        const year = new Date().getFullYear();
        const [{ nextval: wbSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
          SELECT nextval('waybill_number_seq') as nextval;
        `;
        const waybillNumber = `WAY-${year}-${wbSeq.toString().padStart(4, '0')}`;

        const waybill = await tx.waybill.create({
          data: {
            number: waybillNumber,
            customerId: customer.id,
            warehouseId: targetWarehouseId,
            amount: calculatedTotal || totalAmount,
            vatAmount: totalVat,
            status: 'DRAFT',
            crmDealId: marketplaceOrderId,
            items: {
              create: waybillLines
            }
          }
        });

        console.log(`[EventConsumer] Draft Waybill ${waybill.number} created for Marketplace Order ${marketplaceOrderId}. Stock reserved.`);

        // 6. Conditionally Create Invoice ONLY IF requiresEsf is true
        if (requiresEsf === true) {
          const [{ nextval: invSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
            SELECT nextval('invoice_number_seq') as nextval;
          `;
          const invoiceNumber = `INV-${year}-${invSeq.toString().padStart(4, '0')}`;
          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + 14);

          const invoice = await tx.invoice.create({
            data: {
              number: invoiceNumber,
              customerId: customer.id,
              amount: calculatedTotal || totalAmount,
              vatAmount: totalVat,
              paidAmount: 0.00,
              status: 'DRAFT',
              dueDate,
              crmDealId: marketplaceOrderId,
              items: {
                create: waybillLines
              }
            }
          });

          console.log(`[EventConsumer] Draft Invoice ${invoice.number} created for Marketplace Order ${marketplaceOrderId} (requiresEsf: true).`);
        } else {
          console.log(`[EventConsumer] Invoice skipped for Marketplace Order ${marketplaceOrderId} (requiresEsf: false).`);
        }
      });
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('id')) {
        console.warn(`[EventConsumer] Event ${eventId} was already processed. Skipping.`);
        return;
      }
      throw e;
    }
  }

  /**
   * Processes a marketplace.order.cancelled event from CRM.
   */
  async handleMarketplaceOrderCancelled(event: IntegrationEvent<any>) {
    const { tenantId, eventId } = event;
    const { marketplaceOrderId, reason } = event.payload;

    console.log(`[EventConsumer] Processing marketplace.order.cancelled event: ${eventId} (Order: ${marketplaceOrderId})`);

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    try {
      await db.$transaction(async (tx: any) => {
        await tx.processedEvent.create({
          data: {
            id: eventId,
            eventType: event.eventType
          }
        });

        // Find associated Waybill
        const waybill = await tx.waybill.findFirst({
          where: { crmDealId: marketplaceOrderId },
          include: { items: true }
        });

        if (!waybill) {
          console.warn(`[EventConsumer] Waybill for marketplace order ${marketplaceOrderId} not found. Skipping cancellation.`);
          return;
        }

        if (waybill.status === 'DRAFT') {
          // Cancel DRAFT waybill & release reserved stock
          await tx.$executeRaw`
            UPDATE "Waybill" SET status = 'CANCELLED', "updatedAt" = now()
            WHERE id = ${waybill.id} AND status = 'DRAFT';
          `;

          const targetWarehouseId = waybill.warehouseId || 'default-main-warehouse';
          for (const item of waybill.items) {
            const existingStock = await tx.stockItem.findUnique({
              where: { sku_warehouseId: { sku: item.sku, warehouseId: targetWarehouseId } }
            });
            if (existingStock) {
              await tx.stockItem.update({
                where: { sku_warehouseId: { sku: item.sku, warehouseId: targetWarehouseId } },
                data: { reserved: { decrement: Number(item.quantity) } }
              });
            }
          }
          console.log(`[EventConsumer] DRAFT Waybill ${waybill.number} cancelled & stock reservation released for order ${marketplaceOrderId}.`);
        } else if (waybill.status === 'DELIVERED') {
          // DELIVERED waybill -> Initiate RMA to return physical inventory
          const year = new Date().getFullYear();
          const [{ nextval: rmaSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
            SELECT nextval('rma_number_seq') as nextval;
          `;
          const rmaNumber = `RMA-${year}-${rmaSeq.toString().padStart(4, '0')}`;
          const targetWarehouseId = waybill.warehouseId || 'default-main-warehouse';

          const rma = await tx.rma.create({
            data: {
              number: rmaNumber,
              waybillId: waybill.id,
              reason: reason || 'Отмена доставленного заказа на маркетплейсе',
              status: 'CONFIRMED',
              confirmedAt: new Date(),
              lines: {
                create: waybill.items.map((i: any) => ({
                  sku: i.sku,
                  warehouseId: targetWarehouseId,
                  quantity: Number(i.quantity)
                }))
              }
            },
            include: { lines: true }
          });

          // Increase physical stock quantity for each returned item
          for (const line of rma.lines) {
            const lineQty = Number(line.quantity);
            const existing = await tx.stockItem.findUnique({
              where: { sku_warehouseId: { sku: line.sku, warehouseId: line.warehouseId } }
            });

            if (existing) {
              await tx.stockItem.update({
                where: { sku_warehouseId: { sku: line.sku, warehouseId: line.warehouseId } },
                data: { quantity: { increment: lineQty } }
              });
            } else {
              await tx.stockItem.create({
                data: {
                  sku: line.sku,
                  warehouseId: line.warehouseId,
                  quantity: lineQty,
                  reserved: 0
                }
              });
            }

            await tx.stockMovement.create({
              data: {
                sku: line.sku,
                warehouseId: line.warehouseId,
                quantity: lineQty,
                type: 'return',
                referenceId: rma.id
              }
            });
          }
          console.log(`[EventConsumer] DELIVERED Waybill ${waybill.number} cancelled via confirmed RMA ${rma.number}, inventory restored.`);
        }
      });
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('id')) {
        console.warn(`[EventConsumer] Event ${eventId} was already processed. Skipping.`);
        return;
      }
      throw e;
    }
  }
}
