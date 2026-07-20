import { Controller, Get, Post, Body, Param, UseGuards, Req, NotFoundException, BadRequestException } from '@nestjs/common';
import { AuthGuard, RequestWithUser } from './auth.guard.js';
import { TenantPrismaService } from './prisma.service.js';
import { EsfQueueService } from './esf-queue.service.js';
import { NCALayerService } from '@senimerp/integrations';
import { EventBusPublisher } from '@senimerp/event-bus-client';
import { IntegrationEvent, InvoicePaidPayload, ShipmentCompletedPayload, StockLevelChangedPayload } from '@senimerp/types';
import crypto from 'crypto';

@Controller('api')
@UseGuards(AuthGuard)
export class ErpController {
  private publisher = new EventBusPublisher();

  constructor(
    private readonly prismaService: TenantPrismaService,
    private readonly esfQueueService: EsfQueueService
  ) {}

  /**
   * Helper to get database client for request tenant.
   */
  private getDb(req: RequestWithUser) {
    const tenantId = req.user.tenantId;
    return this.prismaService.getClient(tenantId);
  }

  // --- Invoices ---

  @Get('invoices')
  async getInvoices(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.invoice.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('invoices/:id')
  async getInvoiceById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  @Post('invoices/:id/sign')
  async signInvoice(
    @Param('id') id: string,
    @Body('signedXml') signedXml: string,
    @Req() req: RequestWithUser
  ) {
    if (!signedXml) throw new BadRequestException('signedXml is required');
    const db = this.getDb(req);

    // Verify digital signature structure using NCALayer helper
    const certDetails = NCALayerService.verifySignature(signedXml);

    const invoice = await db.invoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('Only draft invoices can be signed');

    // Update invoice state and write signature record in a transaction
    const updated = await db.$transaction(async (tx: any) => {
      await tx.documentSignature.create({
        data: {
          invoiceId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });

      return tx.invoice.update({
        where: { id },
        data: {
          status: 'ISSUED',
          signedXml
        },
        include: { customer: true }
      });
    });

    console.log(`[ERP API] Invoice ${invoice.number} signed by ${certDetails.signedBy} (IIN: ${certDetails.iin})`);
    return updated;
  }

  @Post('invoices/:id/pay')
  async payInvoice(
    @Param('id') id: string,
    @Body('amount') amountPay: number,
    @Req() req: RequestWithUser
  ) {
    if (!amountPay || amountPay <= 0) throw new BadRequestException('Valid payment amount is required');
    const db = this.getDb(req);

    // Atomic increment and status calculation in a single UPDATE — eliminates lost update anomalies
    const rows = await db.$queryRaw<Array<any>>`
      UPDATE "Invoice"
      SET "paidAmount" = "paidAmount" + ${amountPay},
          "status" = CASE
            WHEN "paidAmount" + ${amountPay} >= "amount" THEN 'PAID'
            ELSE 'PARTIALLY_PAID'
          END,
          "updatedAt" = now()
      WHERE id = ${id}
      RETURNING *;
    `;

    if (rows.length === 0) throw new NotFoundException('Invoice not found');
    const updated = rows[0];
    const invoiceTotal = Number(updated.amount);
    const nextStatus = updated.status as 'PARTIALLY_PAID' | 'PAID';

    // Publish event back to CRM
    const paymentEvent: IntegrationEvent<InvoicePaidPayload> = {
      eventId: crypto.randomUUID(),
      eventType: 'invoice.paid',
      tenantId: req.user.tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        invoiceId: id,
        dealId: updated.crmDealId || '',
        amountPaid: amountPay,
        totalAmount: invoiceTotal,
        paymentStatus: nextStatus === 'PAID' ? 'paid' : 'partially_paid',
        erpDocumentId: id
      }
    };

    await this.publisher.publishEvent(paymentEvent);
    console.log(`[ERP API] Processed payment of ${amountPay} KZT for Invoice ${updated.number}. Status: ${nextStatus}. Fired event.`);

    return updated;
  }

  // --- Waybills ---

  @Get('waybills')
  async getWaybills(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.waybill.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('waybills/:id')
  async getWaybillById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!waybill) throw new NotFoundException('Waybill not found');
    return waybill;
  }

  @Post('waybills/:id/sign')
  async signWaybill(
    @Param('id') id: string,
    @Body('signedXml') signedXml: string,
    @Req() req: RequestWithUser
  ) {
    if (!signedXml) throw new BadRequestException('signedXml is required');
    const db = this.getDb(req);
    const certDetails = NCALayerService.verifySignature(signedXml);

    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { items: true }
    });
    if (!waybill) throw new NotFoundException('Waybill not found');

    const { updated, stockChanges } = await db.$transaction(async (tx: any) => {
      await tx.documentSignature.create({
        data: {
          waybillId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });

      const waybillUpdate = await tx.waybill.update({
        where: { id },
        data: {
          status: 'DELIVERED',
          signedXml
        }
      });

      const stockChanges: Array<{ sku: string; quantity: number }> = [];

      for (const item of waybill.items) {
        const itemQty = Number(item.quantity);
        const existingStock = await tx.stockItem.findUnique({ where: { sku: item.sku } });

        let newQty = 0;
        if (!existingStock) {
          console.warn(`[ERP API] Waybill ${waybill.number} shipped SKU ${item.sku} without prior receipt. Creating StockItem with negative balance.`);
          newQty = -itemQty;
          await tx.stockItem.create({
            data: {
              sku: item.sku,
              crmProductId: item.crmProductId || null,
              quantity: newQty
            }
          });
        } else {
          const updatedStock = await tx.stockItem.update({
            where: { sku: item.sku },
            data: {
              quantity: { decrement: itemQty }
            }
          });
          newQty = Number(updatedStock.quantity);
        }

        await tx.stockMovement.create({
          data: {
            sku: item.sku,
            quantity: -itemQty,
            type: 'shipment',
            referenceId: id
          }
        });

        stockChanges.push({ sku: item.sku, quantity: newQty });
      }

      return { updated: waybillUpdate, stockChanges };
    });

    // Fire shipment completion event to CRM
    const shipmentEvent: IntegrationEvent<ShipmentCompletedPayload> = {
      eventId: crypto.randomUUID(),
      eventType: 'shipment.completed',
      tenantId: req.user.tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        waybillId: id,
        dealId: waybill.crmDealId || '',
        customerId: waybill.customerId,
        fulfillmentStatus: 'delivered',
        deliveredAt: new Date().toISOString()
      }
    };
    await this.publisher.publishEvent(shipmentEvent);

    // Fire stock level changed events for all updated SKUs
    for (const change of stockChanges) {
      const stockEvent: IntegrationEvent<StockLevelChangedPayload> = {
        eventId: crypto.randomUUID(),
        eventType: 'stock.level_changed',
        tenantId: req.user.tenantId,
        timestamp: new Date().toISOString(),
        payload: {
          sku: change.sku,
          quantity: change.quantity
        }
      };
      await this.publisher.publishEvent(stockEvent);
      console.log(`[ERP API] Fired stock.level_changed for SKU ${change.sku}: ${change.quantity}`);
    }

    console.log(`[ERP API] Waybill ${waybill.number} signed. Fired shipment.completed and stock.level_changed events.`);

    // Create EsfDocument and enqueue ESF submission for physical turnover
    const esfDoc = await db.esfDocument.upsert({
      where: { waybillId: id },
      create: { waybillId: id, status: 'PENDING' },
      update: { status: 'PENDING', errorMessage: null }
    });

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'WAYBILL',
      documentId: id
    });

    return updated;
  }

  // --- Purchasing (Suppliers & Purchase Orders) ---

  @Post('suppliers')
  async createSupplier(
    @Body('name') name: string,
    @Body('bin') bin: string | undefined,
    @Body('address') address: string | undefined,
    @Body('email') email: string | undefined,
    @Body('phone') phone: string | undefined,
    @Body('bankAccount') bankAccount: string | undefined,
    @Body('bankBik') bankBik: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!name || typeof name !== 'string') throw new BadRequestException('Supplier name is required');
    const db = this.getDb(req);
    return db.supplier.create({
      data: {
        name,
        bin: bin || null,
        address: address || null,
        email: email || null,
        phone: phone || null,
        bankAccount: bankAccount || null,
        bankBik: bankBik || null
      }
    });
  }

  @Get('suppliers')
  async getSuppliers(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.supplier.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }

  @Post('purchase-orders')
  async createPurchaseOrder(
    @Body('supplierId') supplierId: string,
    @Body('expectedDate') expectedDateStr: string | undefined,
    @Body('items') itemsData: Array<{ sku: string; crmProductId?: string; name: string; quantity: number; price: number }>,
    @Req() req: RequestWithUser
  ) {
    if (!supplierId) throw new BadRequestException('supplierId is required');
    if (!itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      throw new BadRequestException('At least one item is required in purchase order');
    }
    const db = this.getDb(req);
    const poNumber = `PO-${Date.now().toString().slice(-6)}`;
    const expectedDate = expectedDateStr ? new Date(expectedDateStr) : null;

    return db.purchaseOrder.create({
      data: {
        number: poNumber,
        supplierId,
        expectedDate,
        status: 'DRAFT',
        items: {
          create: itemsData.map((item) => ({
            sku: item.sku,
            crmProductId: item.crmProductId || null,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            receivedQty: 0
          }))
        }
      },
      include: { supplier: true, items: true }
    });
  }

  @Get('purchase-orders')
  async getPurchaseOrders(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.purchaseOrder.findMany({
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('purchase-orders/:id')
  async getPurchaseOrderById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      include: { supplier: true, items: true }
    });
    if (!po) throw new NotFoundException('Purchase Order not found');
    return po;
  }

  @Post('purchase-orders/:id/send')
  async sendPurchaseOrder(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const po = await db.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException('Purchase Order not found');
    if (po.status !== 'DRAFT') throw new BadRequestException('Only DRAFT purchase orders can be sent');

    return db.purchaseOrder.update({
      where: { id },
      data: { status: 'SENT' },
      include: { supplier: true, items: true }
    });
  }

  // --- Warehouse ---

  @Post('warehouse/receipts')
  async createReceipt(
    @Body('sku') sku: string,
    @Body('quantity') quantity: number,
    @Body('referenceId') referenceId: string | undefined,
    @Body('purchaseOrderId') purchaseOrderId: string | undefined,
    @Body('purchaseOrderItemId') purchaseOrderItemId: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!sku || typeof sku !== 'string') throw new BadRequestException('sku is required');
    if (!quantity || typeof quantity !== 'number' || quantity <= 0) {
      throw new BadRequestException('Valid positive quantity is required');
    }
    const db = this.getDb(req);

    const updatedStockItem = await db.$transaction(async (tx: any) => {
      // 1. Upsert StockItem
      const stockItem = await tx.stockItem.upsert({
        where: { sku },
        update: {
          quantity: { increment: quantity }
        },
        create: {
          sku,
          quantity
        }
      });

      // 2. Record StockMovement
      const finalReferenceId = purchaseOrderId || referenceId || null;
      await tx.stockMovement.create({
        data: {
          sku,
          quantity,
          type: 'receipt',
          referenceId: finalReferenceId
        }
      });

      // 3. Increment PurchaseOrderItem.receivedQty and recalculate PurchaseOrder.status atomically
      if (purchaseOrderId || purchaseOrderItemId) {
        let targetItemId = purchaseOrderItemId;

        if (!targetItemId && purchaseOrderId) {
          const matchingItems = await tx.purchaseOrderItem.findMany({
            where: { purchaseOrderId, sku }
          });

          if (matchingItems.length === 0) {
            throw new BadRequestException(`Purchase order item for SKU ${sku} not found in purchase order ${purchaseOrderId}`);
          }
          if (matchingItems.length > 1) {
            throw new BadRequestException(`Multiple items found for SKU ${sku} in purchase order ${purchaseOrderId}. Please specify purchaseOrderItemId.`);
          }
          targetItemId = matchingItems[0].id;
        }

        if (targetItemId) {
          const item = await tx.purchaseOrderItem.findUnique({ where: { id: targetItemId } });
          if (!item) {
            throw new BadRequestException(`Purchase order item ${targetItemId} not found`);
          }

          const prevReceived = Number(item.receivedQty);
          const orderedQty = Number(item.quantity);
          const remaining = orderedQty - prevReceived;

          if (quantity > remaining) {
            console.warn(`[ERP API] Over-delivery warning for PO item ${targetItemId} (SKU: ${sku}): Receiving +${quantity}, but remaining was ${remaining}.`);
          }

          await tx.purchaseOrderItem.update({
            where: { id: targetItemId },
            data: { receivedQty: { increment: quantity } }
          });

          // Recalculate Purchase Order status
          const poId = item.purchaseOrderId;
          const allItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: poId } });

          let allFullyReceived = true;
          let anyReceived = false;

          for (const i of allItems) {
            const rec = Number(i.receivedQty);
            const ord = Number(i.quantity);
            if (rec < ord) allFullyReceived = false;
            if (rec > 0) anyReceived = true;
          }

          const newPoStatus = allFullyReceived ? 'RECEIVED' : (anyReceived ? 'PARTIALLY_RECEIVED' : 'SENT');
          await tx.purchaseOrder.update({
            where: { id: poId },
            data: { status: newPoStatus }
          });
        }
      }

      return stockItem;
    });

    const currentQty = Number(updatedStockItem.quantity);

    // Publish stock level changed event
    const event: IntegrationEvent<StockLevelChangedPayload> = {
      eventId: crypto.randomUUID(),
      eventType: 'stock.level_changed',
      tenantId: req.user.tenantId,
      timestamp: new Date().toISOString(),
      payload: {
        sku,
        quantity: currentQty
      }
    };

    await this.publisher.publishEvent(event);
    console.log(`[ERP API] Warehouse receipt processed for SKU ${sku}: +${quantity}. New balance: ${currentQty}.`);

    return updatedStockItem;
  }


  // --- Service Acts ---

  @Get('acts')
  async getActs(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.serviceAct.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('acts/:id')
  async getActById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const act = await db.serviceAct.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!act) throw new NotFoundException('Act of work not found');
    return act;
  }

  @Post('acts/:id/sign')
  async signAct(
    @Param('id') id: string,
    @Body('signedXml') signedXml: string,
    @Req() req: RequestWithUser
  ) {
    if (!signedXml) throw new BadRequestException('signedXml is required');
    const db = this.getDb(req);
    const certDetails = NCALayerService.verifySignature(signedXml);

    const act = await db.serviceAct.findUnique({ where: { id } });
    if (!act) throw new NotFoundException('Act not found');

    const updated = await db.$transaction(async (tx: any) => {
      await tx.documentSignature.create({
        data: {
          actId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });

      return tx.serviceAct.update({
        where: { id },
        data: {
          status: 'SIGNED_BY_CUSTOMER',
          signedXml
        }
      });
    });

    console.log(`[ERP API] Service Act ${act.number} signed.`);

    // Create EsfDocument and enqueue ESF submission for service turnover
    const esfDoc = await db.esfDocument.upsert({
      where: { actId: id },
      create: { actId: id, status: 'PENDING' },
      update: { status: 'PENDING', errorMessage: null }
    });

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'SERVICE_ACT',
      documentId: id
    });

    return updated;
  }

  // --- Debt Ledger (Реестр задолженности) ---

  @Get('debtors')
  async getDebtors(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    
    // Fetch all customers, their invoices, waybills, and service acts
    const customers = await db.customer.findMany({
      include: {
        invoices: true,
        waybills: true,
        acts: true
      }
    });

    // Calculate dynamic credit/debit balances
    // Debit: Amount billed (issued invoices)
    // Credit: Amount received (paidAmount on invoices)
    // Outstanding Debt = Debit - Credit
    return customers.map((c: any) => {
      let totalBilled = 0;
      let totalPaid = 0;

      c.invoices.forEach((inv: any) => {
        if (inv.status !== 'DRAFT' && inv.status !== 'CANCELLED') {
          totalBilled += Number(inv.amount);
          totalPaid += Number(inv.paidAmount);
        }
      });

      const debt = totalBilled - totalPaid;

      return {
        customerId: c.id,
        crmId: c.crmId,
        customerName: c.name,
        bin: c.bin,
        totalBilled,
        totalPaid,
        outstandingDebt: debt,
        invoiceCount: c.invoices.length,
        waybillCount: c.waybills.length,
        actCount: c.acts.length
      };
    });
  }

  // --- IS ESF Integration Endpoints ---

  @Get('esf/:id')
  async getEsfDocument(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { id },
      include: { invoice: true, waybill: true, act: true }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found');
    return esfDoc;
  }

  @Get('invoices/:id/esf')
  async getInvoiceEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { invoiceId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this invoice');
    return esfDoc;
  }

  @Get('waybills/:id/esf')
  async getWaybillEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { waybillId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this waybill');
    return esfDoc;
  }

  @Get('acts/:id/esf')
  async getActEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { actId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this service act');
    return esfDoc;
  }

  @Post('esf/:id/retry')
  async retryEsfSubmission(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({ where: { id } });
    if (!esfDoc) throw new NotFoundException('ESF Document not found');

    const updated = await db.esfDocument.update({
      where: { id },
      data: {
        status: 'PENDING',
        errorMessage: null
      }
    });

    let documentType: 'WAYBILL' | 'SERVICE_ACT' | 'INVOICE' = 'WAYBILL';
    let documentId = '';

    if (esfDoc.waybillId) {
      documentType = 'WAYBILL';
      documentId = esfDoc.waybillId;
    } else if (esfDoc.actId) {
      documentType = 'SERVICE_ACT';
      documentId = esfDoc.actId;
    } else if (esfDoc.invoiceId) {
      documentType = 'INVOICE';
      documentId = esfDoc.invoiceId;
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType,
      documentId
    });

    console.log(`[ERP API] Manual ESF retry triggered for EsfDocument ${id}`);
    return updated;
  }

  @Post('invoices/:id/esf/retry')
  async retryInvoiceEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { invoiceId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { invoiceId: id, status: 'PENDING' }
      });
    } else {
      esfDoc = await db.esfDocument.update({
        where: { id: esfDoc.id },
        data: { status: 'PENDING', errorMessage: null }
      });
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'INVOICE',
      documentId: id
    });

    return esfDoc;
  }

  @Post('waybills/:id/esf/retry')
  async retryWaybillEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { waybillId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { waybillId: id, status: 'PENDING' }
      });
    } else {
      esfDoc = await db.esfDocument.update({
        where: { id: esfDoc.id },
        data: { status: 'PENDING', errorMessage: null }
      });
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'WAYBILL',
      documentId: id
    });

    return esfDoc;
  }

  @Post('acts/:id/esf/retry')
  async retryActEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { actId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { actId: id, status: 'PENDING' }
      });
    } else {
      esfDoc = await db.esfDocument.update({
        where: { id: esfDoc.id },
        data: { status: 'PENDING', errorMessage: null }
      });
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'SERVICE_ACT',
      documentId: id
    });

    return esfDoc;
  }

}
