import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { calculateLineAmounts, calculateLineDiscount } from './pricing.utils.js';
import { EventBusSubscriber, EventBusPublisher, redisConnection } from '@senimerp/event-bus-client';
import { DealWonPayload, DealWonLineItem, ClientSyncedPayload, IntegrationEvent, RefundConfirmedPayload, StockShortageDetectedPayload } from '@senimerp/types';
import { TenantPrismaService } from './prisma.service.js';

export const CURRENCY_MISMATCH_TOLERANCE_PERCENT = 1.0;

@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private subscriber!: EventBusSubscriber;
  private publisher = new EventBusPublisher();

  constructor(@Inject(TenantPrismaService) private readonly prismaService: TenantPrismaService) {}

  onModuleInit() {
    // Start Event Bus subscriber mapping handlers
    this.subscriber = new EventBusSubscriber(undefined, {
      'deal.won': this.handleDealWon.bind(this),
      'client.created': this.handleClientSynced.bind(this),
      'client.updated': this.handleClientSynced.bind(this),
      'marketplace.order.received': this.handleMarketplaceOrderReceived.bind(this),
      'marketplace.order.cancelled': this.handleMarketplaceOrderCancelled.bind(this),
      'refund.confirmed': this.handleRefundConfirmed.bind(this)
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

    const currencyMismatches: Array<{
      sku: string;
      price: Prisma.Decimal;
      dealCurrency: string;
      dealCurrencyPrice: Prisma.Decimal;
      exchangeRate: Prisma.Decimal;
      expectedPrice: Prisma.Decimal;
      deviationPercent: Prisma.Decimal;
    }> = [];

    for (const item of items) {
      const itemTyped = item as DealWonLineItem;
      if (typeof itemTyped.price !== 'number' || !Number.isFinite(itemTyped.price) || itemTyped.price < 0) {
        throw new Error(`Invalid price for SKU ${itemTyped.sku} in deal ${dealId}: ${itemTyped.price}`);
      }
      if (typeof itemTyped.quantity !== 'number' || !Number.isFinite(itemTyped.quantity) || itemTyped.quantity <= 0) {
        throw new Error(`Invalid quantity for SKU ${itemTyped.sku} in deal ${dealId}: ${itemTyped.quantity}`);
      }
      if (itemTyped.listPrice != null && (typeof itemTyped.listPrice !== 'number' && typeof itemTyped.listPrice !== 'string' || (typeof itemTyped.listPrice === 'number' && (!Number.isFinite(itemTyped.listPrice) || itemTyped.listPrice < 0)))) {
        throw new Error(`Invalid listPrice for SKU ${itemTyped.sku} in deal ${dealId}: ${itemTyped.listPrice}`);
      }

      // Currency cross-check if dealCurrency is present and not KZT
      if (itemTyped.dealCurrency && itemTyped.dealCurrency !== 'KZT' && itemTyped.dealCurrencyPrice != null && itemTyped.exchangeRate != null) {
        const fxPrice = new Prisma.Decimal(itemTyped.dealCurrencyPrice);
        const fxRate = new Prisma.Decimal(itemTyped.exchangeRate);
        const expectedPrice = fxPrice.mul(fxRate).toDecimalPlaces(2);
        const actualPrice = new Prisma.Decimal(itemTyped.price);

        if (expectedPrice.gt(0)) {
          const diff = actualPrice.minus(expectedPrice).abs();
          const devPercent = diff.div(expectedPrice).mul(100).toDecimalPlaces(2);
          if (devPercent.toNumber() > CURRENCY_MISMATCH_TOLERANCE_PERCENT) {
            console.warn(`[CurrencyMismatch] Deal ${dealId}, SKU ${itemTyped.sku}: price (${actualPrice}) differs from expected (${expectedPrice} = ${fxPrice} ${itemTyped.dealCurrency} x ${fxRate}) by ${devPercent}% (tolerance: ${CURRENCY_MISMATCH_TOLERANCE_PERCENT}%)`);
            currencyMismatches.push({
              sku: itemTyped.sku,
              price: actualPrice,
              dealCurrency: itemTyped.dealCurrency,
              dealCurrencyPrice: fxPrice,
              exchangeRate: fxRate,
              expectedPrice,
              deviationPercent: devPercent
            });
          }
        }
      }
    }

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    const shortageEvents: Array<{
      dealId: string;
      sku: string;
      requestedQuantity: number;
      physicalQuantity: number;
      reservedQuantity: number;
      shortageQuantity: number;
      warehouseId: string;
    }> = [];

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

        // Calculate totals for Invoice using Prisma.Decimal
        let totalVat = new Prisma.Decimal(0);
        let totalAmount = new Prisma.Decimal(0);

        const invoiceLines = items.map((item: any) => {
          const vatRate = item.vatRate || 12; // Standard Kazakhstani VAT
          const { vatAmount, totalAmount: lineTotal } = calculateLineAmounts(item.price, item.quantity, vatRate);

          totalVat = totalVat.plus(vatAmount);
          totalAmount = totalAmount.plus(lineTotal);

          const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

          return {
            sku: item.sku,
            crmProductId: item.crmProductId,
            name: item.name,
            quantity: new Prisma.Decimal(item.quantity),
            price: new Prisma.Decimal(item.price),
            originalPrice: discountInfo.originalPrice,
            discountAmount: discountInfo.discountAmount,
            discountPercent: discountInfo.discountPercent,
            dealCurrency: item.dealCurrency ?? null,
            dealCurrencyPrice: item.dealCurrencyPrice != null ? new Prisma.Decimal(item.dealCurrencyPrice) : null,
            exchangeRate: item.exchangeRate != null ? new Prisma.Decimal(item.exchangeRate) : null,
            exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
            vatRate: new Prisma.Decimal(vatRate),
            vatAmount,
            totalAmount: lineTotal
          };
        });

        totalVat = totalVat.toDecimalPlaces(2);
        totalAmount = totalAmount.toDecimalPlaces(2);

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
            paidAmount: new Prisma.Decimal(0),
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
          let waybillVat = new Prisma.Decimal(0);
          let waybillTotal = new Prisma.Decimal(0);

          const waybillLines = physicalItems.map((item: any) => {
            const vatRate = item.vatRate || 12;
            const { vatAmount, totalAmount: lineTotal } = calculateLineAmounts(item.price, item.quantity, vatRate);

            waybillVat = waybillVat.plus(vatAmount);
            waybillTotal = waybillTotal.plus(lineTotal);

            const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

            return {
              sku: item.sku,
              crmProductId: item.crmProductId,
              name: item.name,
              quantity: new Prisma.Decimal(item.quantity),
              price: new Prisma.Decimal(item.price),
              originalPrice: discountInfo.originalPrice,
              discountAmount: discountInfo.discountAmount,
              discountPercent: discountInfo.discountPercent,
              dealCurrency: item.dealCurrency ?? null,
              dealCurrencyPrice: item.dealCurrencyPrice != null ? new Prisma.Decimal(item.dealCurrencyPrice) : null,
              exchangeRate: item.exchangeRate != null ? new Prisma.Decimal(item.exchangeRate) : null,
              exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
              vatRate: new Prisma.Decimal(vatRate),
              vatAmount,
              totalAmount: lineTotal
            };
          });

          waybillVat = waybillVat.toDecimalPlaces(2);
          waybillTotal = waybillTotal.toDecimalPlaces(2);

          const [{ nextval: wbSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
            SELECT nextval('waybill_number_seq') as nextval;
          `;
          const waybillNumber = `WAY-${year}-${wbSeq.toString().padStart(4, '0')}`;
          const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
          if (!defaultWarehouse) {
            throw new Error(
              `Cannot process deal.won for deal ${dealId}: no default warehouse configured in the system`
            );
          }
          const defaultWarehouseId = defaultWarehouse.id;

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
            const lineQty = Number(line.quantity);
            const existing = await tx.stockItem.findUnique({
              where: { sku_warehouseId: { sku: line.sku, warehouseId: defaultWarehouseId } }
            });
            let physicalQty = 0;
            let reservedQty = lineQty;

            if (existing) {
              physicalQty = Number(existing.quantity);
              reservedQty = Number(existing.reserved) + lineQty;
              await tx.stockItem.update({
                where: { sku_warehouseId: { sku: line.sku, warehouseId: defaultWarehouseId } },
                data: { reserved: { increment: lineQty } }
              });
            } else {
              await tx.stockItem.create({
                data: { sku: line.sku, warehouseId: defaultWarehouseId, quantity: 0, reserved: lineQty }
              });
            }

            if (reservedQty > physicalQty) {
              const shortageQty = reservedQty - physicalQty;
              console.warn(`[EventConsumer] Over-reservation for SKU ${line.sku} at warehouse ${defaultWarehouseId}: reserved (${reservedQty}) exceeds physical quantity (${physicalQty}).`);

              shortageEvents.push({
                dealId,
                sku: line.sku,
                requestedQuantity: lineQty,
                physicalQuantity: physicalQty,
                reservedQuantity: reservedQty,
                shortageQuantity: shortageQty,
                warehouseId: defaultWarehouseId
              });
            }
          }

          console.log(`[EventConsumer] Draft Waybill created: ${waybillNumber} for goods on warehouse ${defaultWarehouseId}.`);
        }

        // 4. Create Service Act if there are services
        if (serviceItems.length > 0) {
          let actVat = new Prisma.Decimal(0);
          let actTotal = new Prisma.Decimal(0);

          const actLines = serviceItems.map((item: any) => {
            const vatRate = item.vatRate || 12;
            const { vatAmount, totalAmount: lineTotal } = calculateLineAmounts(item.price, item.quantity, vatRate);

            actVat = actVat.plus(vatAmount);
            actTotal = actTotal.plus(lineTotal);

            const discountInfo = calculateLineDiscount(item.listPrice, item.price, item.quantity);

            return {
              sku: item.sku,
              crmProductId: item.crmProductId,
              name: item.name,
              quantity: new Prisma.Decimal(item.quantity),
              price: new Prisma.Decimal(item.price),
              originalPrice: discountInfo.originalPrice,
              discountAmount: discountInfo.discountAmount,
              discountPercent: discountInfo.discountPercent,
              dealCurrency: item.dealCurrency ?? null,
              dealCurrencyPrice: item.dealCurrencyPrice != null ? new Prisma.Decimal(item.dealCurrencyPrice) : null,
              exchangeRate: item.exchangeRate != null ? new Prisma.Decimal(item.exchangeRate) : null,
              exchangeRateDate: item.exchangeRateDate ? new Date(item.exchangeRateDate) : null,
              vatRate: new Prisma.Decimal(vatRate),
              vatAmount,
              totalAmount: lineTotal
            };
          });

          actVat = actVat.toDecimalPlaces(2);
          actTotal = actTotal.toDecimalPlaces(2);

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

        for (const mismatch of currencyMismatches) {
          await tx.currencyMismatchLog.create({
            data: {
              dealId,
              sku: mismatch.sku,
              price: mismatch.price,
              dealCurrency: mismatch.dealCurrency,
              dealCurrencyPrice: mismatch.dealCurrencyPrice,
              exchangeRate: mismatch.exchangeRate,
              expectedPrice: mismatch.expectedPrice,
              deviationPercent: mismatch.deviationPercent
            }
          });
        }
      });

    console.log(`[EventConsumer] Event deal.won processed successfully. Database transaction completed.`);

    for (const shortage of shortageEvents) {
      try {
        await this.publisher.publishEvent({
          eventId: `${eventId}:shortage:${shortage.warehouseId}:${shortage.sku}`,
          eventType: 'stock.shortage_detected',
          tenantId,
          timestamp: new Date().toISOString(),
          payload: shortage
        });
      } catch (publishErr) {
        console.error(`[EventConsumer] Failed to publish stock.shortage_detected for deal ${dealId}, SKU ${shortage.sku}:`, publishErr);
      }
    }
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

  /**
   * Processes a refund confirmed event (CRM -> ERP).
   */
  async handleRefundConfirmed(event: IntegrationEvent<RefundConfirmedPayload>) {
    const { tenantId, eventId } = event;
    const { creditNoteId, amount, provider, referenceId, confirmedAt } = event.payload;

    console.log(`[EventConsumer] Processing refund confirmed event: ${eventId} (Tenant: ${tenantId})`);

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    try {
      await db.$transaction(async (tx: any) => {
        await tx.processedEvent.create({
          data: { id: eventId, eventType: event.eventType }
        });

        const cn = await tx.creditNote.findUnique({ where: { id: creditNoteId } });
        if (!cn) {
          console.warn(`[EventConsumer] CreditNote ${creditNoteId} not found, skipping refund sync`);
          return;
        }

        const priorRefunded = Number(cn.refundedAmount || 0);
        const newRefunded = priorRefunded + amount;
        const totalDue = Number(cn.amount);

        await tx.creditNote.update({
          where: { id: creditNoteId },
          data: {
            refundedAmount: newRefunded,
            refundStatus: newRefunded >= totalDue ? 'refunded' : 'pending',
            refundProvider: provider,
            refundReferenceId: referenceId,
            refundedAt: new Date(confirmedAt)
          }
        });
      });

      console.log(`[EventConsumer] CreditNote ${creditNoteId} refund recorded: ${amount} via ${provider}.`);
    } catch (e: any) {
      if (e?.code === 'P2002' && e?.meta?.target?.includes('id')) {
        console.warn(`[EventConsumer] Event ${eventId} was already processed. Skipping.`);
        return;
      }
      throw e;
    }
  }
}
