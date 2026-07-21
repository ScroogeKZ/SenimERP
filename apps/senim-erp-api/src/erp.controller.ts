import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, Req, NotFoundException, BadRequestException, ConflictException, NotImplementedException, Inject } from '@nestjs/common';
import { AuthGuard, RequestWithUser } from './auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { Roles } from './roles.decorator.js';
import { TenantPrismaService } from './prisma.service.js';
import { EsfQueueService } from './esf-queue.service.js';
import { NCALayerService } from '@senimerp/integrations';
import { EventBusPublisher } from '@senimerp/event-bus-client';
import { IntegrationEvent, InvoicePaidPayload, ShipmentCompletedPayload, StockLevelChangedPayload } from '@senimerp/types';
import crypto from 'crypto';
import { buildSignaturePayload } from './signature-payload.js';

@Controller('api')
@UseGuards(AuthGuard, RolesGuard)
export class ErpController {
  private publisher = new EventBusPublisher();

  constructor(
    @Inject(TenantPrismaService) private readonly prismaService: TenantPrismaService,
    @Inject(EsfQueueService) private readonly esfQueueService: EsfQueueService
  ) {}

  /**
   * Helper to get database client for request tenant, ensuring schema provisioning.
   */
  private async getDb(req: RequestWithUser) {
    const tenantId = req.user.tenantId;
    return this.prismaService.getTenantClient(tenantId);
  }

  // --- Invoices ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('invoices')
  async getInvoices(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.invoice.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('invoices/:id')
  async getInvoiceById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Get('invoices/:id/sign-payload')
  async getInvoiceSignPayload(
    @Param('id') id: string,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const payload = buildSignaturePayload('INVOICE', invoice, supplierBin);
    return { payload };
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('invoices/:id/sign')
  async signInvoice(
    @Param('id') id: string,
    @Body('signedCms') signedCms: string | undefined,
    @Body('signedXml') signedXml: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const rawPayload = signedCms || signedXml;
    if (!rawPayload) throw new BadRequestException('signedCms or signedXml payload is required');
    const db = await this.getDb(req);

    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('Only draft invoices can be signed');

    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const expectedContent = buildSignaturePayload('INVOICE', invoice, supplierBin);

    let certDetails;
    try {
      certDetails = await NCALayerService.verifySignature(rawPayload, { expectedContent });
    } catch (err: any) {
      if (err.code === 'UNSUPPORTED_ALGORITHM') {
        throw new NotImplementedException(err.message);
      }
      throw new BadRequestException(err.message || 'Signature verification failed');
    }

    let updated: any = null;

    // Update invoice state and write signature record in an atomic transaction
    await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Invoice"
        SET "status" = 'ISSUED',
            "signedXml" = ${signedXml},
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" = 'DRAFT'
        RETURNING *;
      `;

      if (rows.length === 0) {
        const existing = await tx.invoice.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Invoice not found');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException('Only draft invoices can be signed');
        }
        throw new BadRequestException('Invoice signing cannot be processed');
      }

      updated = rows[0];

      await tx.documentSignature.create({
        data: {
          invoiceId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });
    });

    console.log(`[ERP API] Invoice ${updated.number} signed by ${certDetails.signedBy} (IIN: ${certDetails.iin})`);
    return db.invoice.findUnique({
      where: { id },
      include: { customer: true }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('invoices/:id/pay')
  async payInvoice(
    @Param('id') id: string,
    @Body('amount') amountPay: number,
    @Body('method') method: string | undefined,
    @Body('referenceId') referenceId: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!amountPay || typeof amountPay !== 'number' || amountPay <= 0) {
      throw new BadRequestException('Valid positive payment amount is required');
    }
    const db = await this.getDb(req);

    let updated: any = null;

    // Atomic transaction: UPDATE with WHERE conditions eliminating overpayment & cancelled statuses, and INSERT into InvoicePayment
    await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Invoice"
        SET "paidAmount" = "paidAmount" + ${amountPay},
            "status" = CASE
              WHEN "paidAmount" + ${amountPay} >= "amount" - 0.0001 THEN 'PAID'
              ELSE 'PARTIALLY_PAID'
            END,
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" != 'CANCELLED'
          AND "paidAmount" + ${amountPay} <= "amount" + 0.0001
        RETURNING *;
      `;

      if (rows.length === 0) {
        // Diagnostic SELECT to determine exact error reason for zero rows updated
        const existing = await tx.invoice.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Invoice not found');
        }
        if (existing.status === 'CANCELLED') {
          throw new BadRequestException('Cannot make payment on a cancelled invoice');
        }
        const currentPaid = Number(existing.paidAmount);
        const totalAmount = Number(existing.amount);
        if (currentPaid + amountPay > totalAmount + 0.0001) {
          throw new BadRequestException('Payment amount exceeds remaining invoice balance');
        }
        throw new BadRequestException('Invoice payment cannot be processed');
      }

      updated = rows[0];

      // Insert itemized payment history entry
      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount: amountPay,
          method: method || null,
          referenceId: referenceId || null
        }
      });
    });

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
        erpDocumentId: id,
        method: method || undefined,
        referenceId: referenceId || undefined
      }
    };

    await this.publisher.publishEvent(paymentEvent);
    console.log(`[ERP API] Processed payment of ${amountPay} KZT for Invoice ${updated.number}. Status: ${nextStatus}. Fired event.`);

    return db.invoice.findUnique({
      where: { id },
      include: {
        customer: true,
        items: true,
        payments: true
      }
    });
  }

  // --- Waybills ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('waybills')
  async getWaybills(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.waybill.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('waybills/:id')
  async getWaybillById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!waybill) throw new NotFoundException('Waybill not found');
    return waybill;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Get('waybills/:id/sign-payload')
  async getWaybillSignPayload(
    @Param('id') id: string,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!waybill) throw new NotFoundException('Waybill not found');
    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const payload = buildSignaturePayload('WAYBILL', waybill, supplierBin);
    return { payload };
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('waybills/:id/sign')
  async signWaybill(
    @Param('id') id: string,
    @Body('signedCms') signedCms: string | undefined,
    @Body('signedXml') signedXml: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const rawPayload = signedCms || signedXml;
    if (!rawPayload) throw new BadRequestException('signedCms or signedXml payload is required');
    const db = await this.getDb(req);

    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
    if (!waybill) throw new NotFoundException('Waybill not found');
    if (waybill.status !== 'DRAFT') throw new BadRequestException('Only draft waybills can be signed');

    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const expectedContent = buildSignaturePayload('WAYBILL', waybill, supplierBin);

    let certDetails;
    try {
      certDetails = await NCALayerService.verifySignature(rawPayload, { expectedContent });
    } catch (err: any) {
      if (err.code === 'UNSUPPORTED_ALGORITHM') {
        throw new NotImplementedException(err.message);
      }
      throw new BadRequestException(err.message || 'Signature verification failed');
    }

    const { updated, stockChanges } = await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Waybill"
        SET "status" = 'DELIVERED',
            "signedXml" = ${signedXml},
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" = 'DRAFT'
        RETURNING *;
      `;

      if (rows.length === 0) {
        const existing = await tx.waybill.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Waybill not found');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException('Only draft waybills can be signed');
        }
        throw new BadRequestException('Waybill signing cannot be processed');
      }

      const waybillUpdate = rows[0];

      await tx.documentSignature.create({
        data: {
          waybillId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });

      const stockChanges: Array<{ sku: string; quantity: number }> = [];
      const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
      const targetWarehouseId = waybill.warehouseId || defaultWarehouse?.id || 'default-main-warehouse';

      for (const item of waybill.items) {
        const itemQty = Number(item.quantity);
        const existingStock = await tx.stockItem.findUnique({
          where: {
            sku_warehouseId: {
              sku: item.sku,
              warehouseId: targetWarehouseId
            }
          }
        });

        let newQty = 0;
        if (!existingStock) {
          console.warn(`[ERP API] Waybill ${waybill.number} shipped SKU ${item.sku} without prior receipt. Creating StockItem with negative balance.`);
          newQty = -itemQty;
          await tx.stockItem.create({
            data: {
              sku: item.sku,
              warehouseId: targetWarehouseId,
              crmProductId: item.crmProductId || null,
              quantity: newQty
            }
          });
        } else {
          const updatedStock = await tx.stockItem.update({
            where: {
              sku_warehouseId: {
                sku: item.sku,
                warehouseId: targetWarehouseId
              }
            },
            data: {
              quantity: { decrement: itemQty },
              reserved: { decrement: itemQty }
            }
          });
          newQty = Number(updatedStock.quantity);
        }

        await tx.stockMovement.create({
          data: {
            sku: item.sku,
            warehouseId: targetWarehouseId,
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

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('waybills/:id/cancel')
  async cancelWaybill(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const waybill = await db.waybill.findUnique({ where: { id }, include: { items: true } });
    if (!waybill) throw new NotFoundException('Waybill not found');

    return db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Waybill" SET status = 'CANCELLED', "updatedAt" = now()
        WHERE id = ${id} AND status = 'DRAFT'
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException('Only draft waybills can be cancelled');
      }

      const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
      const targetWarehouseId = waybill.warehouseId || defaultWarehouse?.id || 'default-main-warehouse';
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
      return rows[0];
    });
  }

  // --- RMA (Returns) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('rma')
  async createRma(
    @Body('waybillId') waybillId: string,
    @Body('reason') reason: string | undefined,
    @Body('items') items: Array<{ sku: string; quantity: number }>,
    @Req() req: RequestWithUser
  ) {
    if (!waybillId || typeof waybillId !== 'string') {
      throw new BadRequestException('waybillId is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('At least one return item is required');
    }

    const db = await this.getDb(req);
    const waybill = await db.waybill.findUnique({
      where: { id: waybillId },
      include: {
        items: true,
        rmas: {
          include: { lines: true }
        }
      }
    });

    if (!waybill) {
      throw new NotFoundException('Waybill not found');
    }
    if (waybill.status !== 'DELIVERED') {
      throw new BadRequestException('Returns are only allowed for DELIVERED waybills');
    }

    const defaultWarehouse = await db.warehouse.findFirst({ where: { isDefault: true } });
    const targetWarehouseId = waybill.warehouseId || defaultWarehouse?.id || 'default-main-warehouse';

    for (const item of items) {
      if (!item.sku || typeof item.quantity !== 'number' || item.quantity <= 0) {
        throw new BadRequestException(`Invalid return item format or non-positive quantity for SKU ${item.sku}`);
      }

      const shippedItem = waybill.items.find((i: any) => i.sku === item.sku);
      if (!shippedItem) {
        throw new BadRequestException(`SKU ${item.sku} was not shipped in waybill ${waybill.number}`);
      }

      const shippedQty = Number(shippedItem.quantity);
      let existingReturnedQty = 0;

      for (const rma of waybill.rmas) {
        if (rma.status === 'DRAFT' || rma.status === 'CONFIRMED') {
          for (const line of rma.lines) {
            if (line.sku === item.sku) {
              existingReturnedQty += Number(line.quantity);
            }
          }
        }
      }

      if (existingReturnedQty + item.quantity > shippedQty) {
        throw new BadRequestException(
          `Return quantity ${item.quantity} for SKU ${item.sku} exceeds max allowable return of ${shippedQty - existingReturnedQty} (shipped: ${shippedQty}, already in RMA: ${existingReturnedQty})`
        );
      }
    }

    const year = new Date().getFullYear();
    const [{ nextval: rmaSeq }] = await db.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('rma_number_seq') as nextval;
    `;
    const rmaNumber = `RMA-${year}-${rmaSeq.toString().padStart(4, '0')}`;

    return db.rma.create({
      data: {
        number: rmaNumber,
        waybillId,
        reason: reason || null,
        status: 'DRAFT',
        lines: {
          create: items.map((i) => {
            const shippedItem = waybill.items.find((si: any) => si.sku === i.sku);
            const price = Number(shippedItem?.price || 0);
            const vatRate = Number(shippedItem?.vatRate || 0);
            const qty = Number(i.quantity);
            const lineVat = Number((price * qty * (vatRate / 100)).toFixed(2));
            const lineTotal = Number((price * qty + lineVat).toFixed(2));
            return {
              sku: i.sku,
              warehouseId: targetWarehouseId,
              quantity: qty,
              price,
              vatRate,
              vatAmount: lineVat,
              totalAmount: lineTotal
            };
          })
        }
      },
      include: {
        lines: true
      }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('rma/:id/confirm')
  async confirmRma(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const rma = await db.rma.findUnique({
      where: { id },
      include: { lines: true, waybill: { include: { items: true } } }
    });
    if (!rma) throw new NotFoundException('RMA not found');

    return db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Rma" SET status = 'CONFIRMED', "confirmedAt" = now(), "updatedAt" = now()
        WHERE id = ${id} AND status = 'DRAFT'
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException('Only draft RMA requests can be confirmed');
      }

      for (const line of rma.lines) {
        const lineQty = Number(line.quantity);
        const existing = await tx.stockItem.findUnique({
          where: {
            sku_warehouseId: {
              sku: line.sku,
              warehouseId: line.warehouseId
            }
          }
        });

        if (existing) {
          await tx.stockItem.update({
            where: {
              sku_warehouseId: {
                sku: line.sku,
                warehouseId: line.warehouseId
              }
            },
            data: {
              quantity: { increment: lineQty }
            }
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

      // Create CreditNote in DRAFT status
      const invoice = rma.waybill?.crmDealId
        ? await tx.invoice.findFirst({
            where: {
              crmDealId: rma.waybill.crmDealId,
              status: { notIn: ['DRAFT', 'CANCELLED'] }
            }
          })
        : null;

      let cnAmount = 0;
      let cnVatAmount = 0;
      for (const line of rma.lines) {
        const wbItem = rma.waybill?.items?.find((wi: any) => wi.sku === line.sku);
        const price = line.price != null ? Number(line.price) : Number(wbItem?.price || 0);
        const vatRate = line.vatRate != null ? Number(line.vatRate) : Number(wbItem?.vatRate || 0);
        const qty = Number(line.quantity);
        const lineVat = line.vatAmount != null ? Number(line.vatAmount) : Number((price * qty * (vatRate / 100)).toFixed(2));
        const lineTotal = line.totalAmount != null ? Number(line.totalAmount) : Number((price * qty + lineVat).toFixed(2));

        cnAmount += lineTotal;
        cnVatAmount += lineVat;
      }
      cnAmount = Number(cnAmount.toFixed(2));
      cnVatAmount = Number(cnVatAmount.toFixed(2));

      const year = new Date().getFullYear();
      const [{ nextval: cnSeq }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
        SELECT nextval('credit_note_number_seq') as nextval;
      `;
      const cnNumber = `CN-${year}-${cnSeq.toString().padStart(4, '0')}`;

      const creditNote = await tx.creditNote.create({
        data: {
          number: cnNumber,
          rmaId: rma.id,
          invoiceId: invoice?.id || null,
          customerId: rma.waybill.customerId,
          amount: cnAmount,
          vatAmount: cnVatAmount,
          status: 'DRAFT',
          items: {
            create: rma.lines.map((line: any) => {
              const wbItem = rma.waybill?.items?.find((wi: any) => wi.sku === line.sku);
              const price = line.price != null ? Number(line.price) : Number(wbItem?.price || 0);
              const vatRate = line.vatRate != null ? Number(line.vatRate) : Number(wbItem?.vatRate || 0);
              const qty = Number(line.quantity);
              const lineVat = line.vatAmount != null ? Number(line.vatAmount) : Number((price * qty * (vatRate / 100)).toFixed(2));
              const lineTotal = line.totalAmount != null ? Number(line.totalAmount) : Number((price * qty + lineVat).toFixed(2));

              return {
                sku: line.sku,
                crmProductId: wbItem?.crmProductId || null,
                name: wbItem?.name || line.sku,
                quantity: qty,
                price,
                vatRate,
                vatAmount: lineVat,
                totalAmount: lineTotal
              };
            })
          }
        },
        include: { items: true }
      });

      return {
        ...rows[0],
        creditNote
      };
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('rma/:id/cancel')
  async cancelRma(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const rma = await db.rma.findUnique({ where: { id } });
    if (!rma) throw new NotFoundException('RMA not found');

    return db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "Rma" SET status = 'CANCELLED', "updatedAt" = now()
        WHERE id = ${id} AND status = 'DRAFT'
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException('Only draft RMA requests can be cancelled');
      }

      return rows[0];
    });
  }

  // --- Credit Notes ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('credit-notes')
  async getCreditNotes(
    @Query('customerId') customerId: string | undefined,
    @Query('rmaId') rmaId: string | undefined,
    @Query('invoiceId') invoiceId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (rmaId) where.rmaId = rmaId;
    if (invoiceId) where.invoiceId = invoiceId;
    if (status) where.status = status;

    let limit = 50;
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 200);
    }

    return db.creditNote.findMany({
      where,
      include: { customer: true, items: true, esfDocument: true, signature: true },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('credit-notes/:id')
  async getCreditNoteById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const cn = await db.creditNote.findUnique({
      where: { id },
      include: { customer: true, items: true, rma: true, invoice: true, esfDocument: true, signature: true }
    });
    if (!cn) throw new NotFoundException('CreditNote not found');
    return cn;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Get('credit-notes/:id/sign-payload')
  async getCreditNoteSignPayload(
    @Param('id') id: string,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    const cn = await db.creditNote.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!cn) throw new NotFoundException('CreditNote not found');
    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const payload = buildSignaturePayload('CREDIT_NOTE', cn, supplierBin);
    return { payload };
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('credit-notes/:id/sign')
  async signCreditNote(
    @Param('id') id: string,
    @Body('signedCms') signedCms: string | undefined,
    @Body('signedXml') signedXml: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const rawPayload = signedCms || signedXml;
    if (!rawPayload) throw new BadRequestException('signedCms or signedXml payload is required');
    const db = await this.getDb(req);

    const cn = await db.creditNote.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!cn) throw new NotFoundException('CreditNote not found');
    if (cn.status !== 'DRAFT') throw new BadRequestException('Only draft credit notes can be signed');

    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const expectedContent = buildSignaturePayload('CREDIT_NOTE', cn, supplierBin);

    let certDetails;
    try {
      certDetails = await NCALayerService.verifySignature(rawPayload, { expectedContent });
    } catch (err: any) {
      if (err.code === 'UNSUPPORTED_ALGORITHM') {
        throw new NotImplementedException(err.message);
      }
      throw new BadRequestException(err.message || 'Signature verification failed');
    }

    let updated: any = null;

    await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "CreditNote"
        SET "status" = 'ISSUED',
            "signedXml" = ${signedXml},
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" = 'DRAFT'
        RETURNING *;
      `;

      if (rows.length === 0) {
        const existing = await tx.creditNote.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('CreditNote not found');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException('Only draft credit notes can be signed');
        }
        throw new BadRequestException('CreditNote signing cannot be processed');
      }

      updated = rows[0];

      await tx.documentSignature.create({
        data: {
          creditNoteId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });
    });

    const esfDoc = await db.esfDocument.upsert({
      where: { creditNoteId: id },
      create: { creditNoteId: id, status: 'PENDING' },
      update: { status: 'PENDING', errorMessage: null }
    });

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'CREDIT_NOTE',
      documentId: id
    });

    console.log(`[ERP API] CreditNote ${updated.number} signed by ${certDetails.signedBy} (IIN: ${certDetails.iin})`);
    return db.creditNote.findUnique({
      where: { id },
      include: { customer: true, items: true, esfDocument: true, signature: true }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Get('credit-notes/:id/esf')
  async getCreditNoteEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const cn = await db.creditNote.findUnique({ where: { id } });
    if (!cn) throw new NotFoundException('CreditNote not found');

    const esfDoc = await db.esfDocument.findUnique({ where: { creditNoteId: id } });
    if (!esfDoc) throw new NotFoundException('ESF document record not found for CreditNote');
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('credit-notes/:id/esf/retry')
  async retryCreditNoteEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const cn = await db.creditNote.findUnique({ where: { id } });
    if (!cn) throw new NotFoundException('CreditNote not found');

    const esfDoc = await db.esfDocument.findUnique({ where: { creditNoteId: id } });
    if (!esfDoc) throw new NotFoundException('ESF document record not found for CreditNote');

    await db.esfDocument.update({
      where: { id: esfDoc.id },
      data: { status: 'PENDING', errorMessage: null }
    });

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc.id,
      documentType: 'CREDIT_NOTE',
      documentId: id
    });

    return { message: 'ESF submission retried', esfDocumentId: esfDoc.id };
  }

  // --- Purchasing (Suppliers & Purchase Orders) ---

  @Roles('ERP_PURCHASER', 'ERP_CEO')
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
    const db = await this.getDb(req);
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

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('suppliers')
  async getSuppliers(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.supplier.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_PURCHASER', 'ERP_CEO')
  @Post('purchase-orders')
  async createPurchaseOrder(
    @Body('supplierId') supplierId: string,
    @Body('warehouseId') warehouseId: string | undefined,
    @Body('expectedDate') expectedDateStr: string | undefined,
    @Body('items') itemsData: Array<{ sku: string; crmProductId?: string; name: string; quantity: number; price: number }>,
    @Req() req: RequestWithUser
  ) {
    if (!supplierId) throw new BadRequestException('supplierId is required');
    if (!itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      throw new BadRequestException('At least one item is required in purchase order');
    }
    const db = await this.getDb(req);

    let targetWarehouseId = warehouseId;
    if (!targetWarehouseId) {
      const defaultWh = await db.warehouse.findFirst({ where: { isDefault: true } });
      targetWarehouseId = defaultWh?.id;
    }

    const year = new Date().getFullYear();
    const [{ nextval: poSeq }] = await db.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('po_number_seq') as nextval;
    `;
    const poNumber = `PO-${year}-${poSeq.toString().padStart(4, '0')}`;
    const expectedDate = expectedDateStr ? new Date(expectedDateStr) : null;

    try {
      return await db.purchaseOrder.create({
        data: {
          number: poNumber,
          supplierId,
          warehouseId: targetWarehouseId || null,
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
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('Purchase order number collision, please retry');
      }
      throw e;
    }
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('purchase-orders')
  async getPurchaseOrders(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.purchaseOrder.findMany({
      include: { supplier: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('purchase-orders/:id')
  async getPurchaseOrderById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      include: { supplier: true, items: true }
    });
    if (!po) throw new NotFoundException('Purchase Order not found');
    return po;
  }

  @Roles('ERP_PURCHASER', 'ERP_CEO')
  @Post('purchase-orders/:id/send')
  async sendPurchaseOrder(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
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

  @Roles('ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('warehouses')
  async createWarehouse(
    @Body('name') name: string,
    @Body('code') code: string,
    @Body('isDefault') isDefault: boolean | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!name || typeof name !== 'string') throw new BadRequestException('name is required');
    if (!code || typeof code !== 'string') throw new BadRequestException('code is required');
    const db = await this.getDb(req);

    if (isDefault) {
      return db.$transaction(async (tx: any) => {
        await tx.warehouse.updateMany({
          where: { isDefault: true },
          data: { isDefault: false }
        });
        return tx.warehouse.create({
          data: {
            name,
            code,
            isDefault: true
          }
        });
      });
    }

    return db.warehouse.create({
      data: {
        name,
        code,
        isDefault: false
      }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('warehouses')
  async getWarehouses(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.warehouse.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_WAREHOUSE_MANAGER', 'ERP_CEO')
  @Post('warehouse/receipts')
  async createReceipt(
    @Body('sku') sku: string,
    @Body('quantity') quantity: number,
    @Body('warehouseId') warehouseId: string,
    @Body('referenceId') referenceId: string | undefined,
    @Body('purchaseOrderId') purchaseOrderId: string | undefined,
    @Body('purchaseOrderItemId') purchaseOrderItemId: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!sku || typeof sku !== 'string') throw new BadRequestException('sku is required');
    if (!quantity || typeof quantity !== 'number' || quantity <= 0) {
      throw new BadRequestException('Valid positive quantity is required');
    }
    if (!warehouseId || typeof warehouseId !== 'string') {
      throw new BadRequestException('warehouseId is required');
    }
    const db = await this.getDb(req);

    const updatedStockItem = await db.$transaction(async (tx: any) => {
      // 1. Upsert StockItem
      const stockItem = await tx.stockItem.upsert({
        where: {
          sku_warehouseId: {
            sku,
            warehouseId
          }
        },
        update: {
          quantity: { increment: quantity }
        },
        create: {
          sku,
          warehouseId,
          quantity
        }
      });

      // 2. Record StockMovement
      const finalReferenceId = purchaseOrderId || referenceId || null;
      await tx.stockMovement.create({
        data: {
          sku,
          warehouseId,
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

          if (item.sku !== sku) {
            throw new BadRequestException(
              `Purchase order item ${targetItemId} is for SKU ${item.sku}, but receipt is for SKU ${sku}`
            );
          }

          if (purchaseOrderId && item.purchaseOrderId !== purchaseOrderId) {
            throw new BadRequestException(
              `Purchase order item ${targetItemId} does not belong to purchase order ${purchaseOrderId}`
            );
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

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('stock')
  async getStock(
    @Query('sku') sku: string | undefined,
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('lowStock') lowStockStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);

    const where: any = {};
    if (sku && typeof sku === 'string') {
      where.sku = sku;
    }
    if (warehouseId && typeof warehouseId === 'string') {
      where.warehouseId = warehouseId;
    }

    const items = await db.stockItem.findMany({
      where,
      orderBy: { sku: 'asc' }
    });

    const isLowStock = lowStockStr === 'true' || lowStockStr === '1';
    if (isLowStock) {
      // In-memory post-query JS filter: quantity <= reserved (Prisma field-to-field comparison workaround)
      return items.filter((item: any) => Number(item.quantity) <= Number(item.reserved));
    }

    return items;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('stock/movements')
  async getStockMovements(
    @Query('sku') sku: string | undefined,
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('type') type: string | undefined,
    @Query('referenceId') referenceId: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (type && type !== 'receipt' && type !== 'shipment' && type !== 'return') {
      throw new BadRequestException("type must be either 'receipt', 'shipment', or 'return'");
    }

    const db = await this.getDb(req);

    const where: any = {};
    if (sku && typeof sku === 'string') {
      where.sku = sku;
    }
    if (warehouseId && typeof warehouseId === 'string') {
      where.warehouseId = warehouseId;
    }
    if (type) {
      where.type = type;
    }
    if (referenceId && typeof referenceId === 'string') {
      where.referenceId = referenceId;
    }

    let limit = 50;
    if (limitStr) {
      const parsedLimit = parseInt(limitStr, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = Math.min(parsedLimit, 200);
      }
    }

    return db.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  // --- Service Acts ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('acts')
  async getActs(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.serviceAct.findMany({
      include: { customer: true, esfDocument: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('acts/:id')
  async getActById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const act = await db.serviceAct.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true, esfDocument: true }
    });
    if (!act) throw new NotFoundException('Act of work not found');
    return act;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Get('acts/:id/sign-payload')
  async getActSignPayload(
    @Param('id') id: string,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    const act = await db.serviceAct.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!act) throw new NotFoundException('Act of work not found');
    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const payload = buildSignaturePayload('ACT', act, supplierBin);
    return { payload };
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('acts/:id/sign')
  async signAct(
    @Param('id') id: string,
    @Body('signedCms') signedCms: string | undefined,
    @Body('signedXml') signedXml: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const rawPayload = signedCms || signedXml;
    if (!rawPayload) throw new BadRequestException('signedCms or signedXml payload is required');
    const db = await this.getDb(req);

    const act = await db.serviceAct.findUnique({
      where: { id },
      include: { customer: true }
    });
    if (!act) throw new NotFoundException('Act of work not found');
    if (act.status !== 'DRAFT') throw new BadRequestException('Only draft service acts can be signed');

    const profile = await db.tenantProfile.findFirst();
    const supplierBin = profile?.companyBin || '000000000000';
    const expectedContent = buildSignaturePayload('ACT', act, supplierBin);

    let certDetails;
    try {
      certDetails = await NCALayerService.verifySignature(rawPayload, { expectedContent });
    } catch (err: any) {
      if (err.code === 'UNSUPPORTED_ALGORITHM') {
        throw new NotImplementedException(err.message);
      }
      throw new BadRequestException(err.message || 'Signature verification failed');
    }

    let updated: any = null;

    await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "ServiceAct"
        SET "status" = 'SIGNED_BY_CUSTOMER',
            "signedXml" = ${signedXml},
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" = 'DRAFT'
        RETURNING *;
      `;

      if (rows.length === 0) {
        const existing = await tx.serviceAct.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Act not found');
        }
        if (existing.status !== 'DRAFT') {
          throw new BadRequestException('Only draft acts can be signed');
        }
        throw new BadRequestException('Act signing cannot be processed');
      }

      updated = rows[0];

      await tx.documentSignature.create({
        data: {
          actId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });
    });

    console.log(`[ERP API] Service Act ${updated.number} signed.`);

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

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('debtors')
  async getDebtors(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    
    // Fetch all customers, their invoices, waybills, service acts, and credit notes
    const customers = await db.customer.findMany({
      include: {
        invoices: true,
        waybills: true,
        acts: true,
        creditNotes: true
      }
    });

    // Calculate dynamic credit/debit balances
    // Debit: Amount billed (issued invoices)
    // Credit: Amount received (paidAmount) + Amount credited (ISSUED credit notes)
    // Outstanding Debt = Debit - Credit
    return customers.map((c: any) => {
      let totalBilled = 0;
      let totalPaid = 0;
      let totalCredited = 0;

      c.invoices.forEach((inv: any) => {
        if (inv.status !== 'DRAFT' && inv.status !== 'CANCELLED') {
          totalBilled += Number(inv.amount);
          totalPaid += Number(inv.paidAmount);
        }
      });

      c.creditNotes?.forEach((cn: any) => {
        if (cn.status === 'ISSUED') {
          totalCredited += Number(cn.amount);
        }
      });

      const debt = totalBilled - totalPaid - totalCredited;

      return {
        customerId: c.id,
        crmId: c.crmId,
        customerName: c.name,
        bin: c.bin,
        totalBilled,
        totalPaid,
        totalCredited,
        outstandingDebt: debt,
        invoiceCount: c.invoices.length,
        waybillCount: c.waybills.length,
        actCount: c.acts.length,
        creditNoteCount: c.creditNotes?.length || 0
      };
    });
  }

  // --- Supplier Invoices (AP) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('supplier-invoices')
  async createSupplierInvoice(
    @Body('supplierId') supplierId: string,
    @Body('purchaseOrderId') purchaseOrderId: string | undefined,
    @Body('amount') amount: number,
    @Body('dueDate') dueDateStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (!supplierId || typeof supplierId !== 'string') {
      throw new BadRequestException('supplierId is required');
    }
    if (amount === undefined || amount === null || typeof amount !== 'number' || amount <= 0) {
      throw new BadRequestException('Valid positive amount is required');
    }

    const db = await this.getDb(req);

    const supplier = await db.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) {
      throw new NotFoundException('Supplier not found');
    }

    if (purchaseOrderId) {
      const po = await db.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
      if (!po) {
        throw new NotFoundException('Purchase Order not found');
      }
      if (po.supplierId !== supplierId) {
        throw new BadRequestException(
          `Purchase order ${purchaseOrderId} belongs to a different supplier`
        );
      }
    }

    const year = new Date().getFullYear();
    const [{ nextval: supInvSeq }] = await db.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('supplier_invoice_number_seq') as nextval;
    `;
    const invoiceNumber = `SUP-INV-${year}-${supInvSeq.toString().padStart(4, '0')}`;
    const dueDate = dueDateStr ? new Date(dueDateStr) : null;

    try {
      return await db.supplierInvoice.create({
        data: {
          number: invoiceNumber,
          supplierId,
          purchaseOrderId: purchaseOrderId || null,
          amount,
          paidAmount: 0.00,
          status: 'UNPAID',
          dueDate
        },
        include: {
          supplier: true,
          purchaseOrder: true,
          payments: true
        }
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('Supplier invoice number collision, please retry');
      }
      throw e;
    }
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('supplier-invoices')
  async getSupplierInvoices(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return db.supplierInvoice.findMany({
      include: {
        supplier: true,
        purchaseOrder: true,
        payments: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('supplier-invoices/:id')
  async getSupplierInvoiceById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const invoice = await db.supplierInvoice.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseOrder: true,
        payments: true
      }
    });
    if (!invoice) throw new NotFoundException('Supplier invoice not found');
    return invoice;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('supplier-invoices/:id/pay')
  async paySupplierInvoice(
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('method') method: string | undefined,
    @Body('referenceId') referenceId: string | undefined,
    @Req() req: RequestWithUser
  ) {
    if (amount === undefined || amount === null || typeof amount !== 'number' || amount <= 0) {
      throw new BadRequestException('Valid positive payment amount is required');
    }

    const db = await this.getDb(req);

    // Atomic transaction: UPDATE with WHERE conditions eliminating overpayment & cancelled statuses, preventing TOCTOU race conditions
    await db.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<any>>`
        UPDATE "SupplierInvoice"
        SET "paidAmount" = "paidAmount" + ${amount},
            "status" = CASE
              WHEN "paidAmount" + ${amount} >= "amount" - 0.0001 THEN 'PAID'
              WHEN "paidAmount" + ${amount} <= 0.0001 THEN 'UNPAID'
              ELSE 'PARTIALLY_PAID'
            END,
            "updatedAt" = now()
        WHERE id = ${id}
          AND "status" != 'CANCELLED'
          AND "paidAmount" + ${amount} <= "amount" + 0.0001
        RETURNING *;
      `;

      if (rows.length === 0) {
        // Diagnostic SELECT to determine exact error reason for zero rows updated
        const existing = await tx.supplierInvoice.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Supplier invoice not found');
        }
        if (existing.status === 'CANCELLED') {
          throw new BadRequestException('Cannot make payment on a cancelled invoice');
        }
        const currentPaid = Number(existing.paidAmount);
        const totalAmount = Number(existing.amount);
        if (currentPaid + amount > totalAmount + 0.0001) {
          throw new BadRequestException('Payment amount exceeds remaining invoice balance');
        }
        throw new BadRequestException('Supplier invoice payment cannot be processed');
      }

      // Record itemized payment history entry
      await tx.supplierPayment.create({
        data: {
          supplierInvoiceId: id,
          amount,
          method: method || null,
          referenceId: referenceId || null
        }
      });
    });

    return db.supplierInvoice.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseOrder: true,
        payments: true
      }
    });
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('suppliers/debt')
  async getSuppliersDebt(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const suppliers = await db.supplier.findMany({
      include: {
        supplierInvoices: true
      }
    });

    return suppliers.map((s: any) => {
      let totalBilled = 0;
      let totalPaid = 0;

      s.supplierInvoices.forEach((inv: any) => {
        if (inv.status !== 'CANCELLED') {
          totalBilled += Number(inv.amount);
          totalPaid += Number(inv.paidAmount);
        }
      });

      const debt = totalBilled - totalPaid;

      return {
        supplierId: s.id,
        supplierName: s.name,
        bin: s.bin,
        totalBilled,
        totalPaid,
        debt,
        invoiceCount: s.supplierInvoices.length
      };
    });
  }

  // --- IS ESF Integration Endpoints ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('esf/:id')
  async getEsfDocument(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { id },
      include: { invoice: true, waybill: true, act: true }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found');
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('invoices/:id/esf')
  async getInvoiceEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { invoiceId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this invoice');
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('waybills/:id/esf')
  async getWaybillEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { waybillId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this waybill');
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('acts/:id/esf')
  async getActEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const esfDoc = await db.esfDocument.findUnique({
      where: { actId: id }
    });
    if (!esfDoc) throw new NotFoundException('ESF Document not found for this service act');
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('esf/:id/retry')
  async retryEsfSubmission(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);

    // Atomic status guard: only allow retry for FAILED, REJECTED, or stuck PENDING documents
    const rows = await db.$queryRaw<Array<any>>`
      UPDATE "EsfDocument"
      SET "status" = 'PENDING', "errorMessage" = NULL, "updatedAt" = now()
      WHERE "id" = ${id}
        AND "status" IN ('FAILED', 'REJECTED', 'PENDING')
      RETURNING *;
    `;

    if (rows.length === 0) {
      const existing = await db.esfDocument.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('ESF Document not found');
      throw new BadRequestException(`ESF document is already ${existing.status} and cannot be retried`);
    }

    const esfDoc = rows[0];
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
    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('invoices/:id/esf/retry')
  async retryInvoiceEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { invoiceId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { invoiceId: id, status: 'PENDING' }
      });
    } else {
      // Atomic status guard: block retry for REGISTERED/SUBMITTED
      const rows = await db.$queryRaw<Array<any>>`
        UPDATE "EsfDocument"
        SET "status" = 'PENDING', "errorMessage" = NULL, "updatedAt" = now()
        WHERE "id" = ${esfDoc.id}
          AND "status" IN ('FAILED', 'REJECTED', 'PENDING')
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException(`ESF document is already ${esfDoc.status} and cannot be retried`);
      }
      esfDoc = rows[0];
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc!.id,
      documentType: 'INVOICE',
      documentId: id
    });

    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('waybills/:id/esf/retry')
  async retryWaybillEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { waybillId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { waybillId: id, status: 'PENDING' }
      });
    } else {
      // Atomic status guard: block retry for REGISTERED/SUBMITTED
      const rows = await db.$queryRaw<Array<any>>`
        UPDATE "EsfDocument"
        SET "status" = 'PENDING', "errorMessage" = NULL, "updatedAt" = now()
        WHERE "id" = ${esfDoc.id}
          AND "status" IN ('FAILED', 'REJECTED', 'PENDING')
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException(`ESF document is already ${esfDoc.status} and cannot be retried`);
      }
      esfDoc = rows[0];
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc!.id,
      documentType: 'WAYBILL',
      documentId: id
    });

    return esfDoc;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Post('acts/:id/esf/retry')
  async retryActEsf(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    let esfDoc = await db.esfDocument.findUnique({ where: { actId: id } });

    if (!esfDoc) {
      esfDoc = await db.esfDocument.create({
        data: { actId: id, status: 'PENDING' }
      });
    } else {
      // Atomic status guard: block retry for REGISTERED/SUBMITTED
      const rows = await db.$queryRaw<Array<any>>`
        UPDATE "EsfDocument"
        SET "status" = 'PENDING', "errorMessage" = NULL, "updatedAt" = now()
        WHERE "id" = ${esfDoc.id}
          AND "status" IN ('FAILED', 'REJECTED', 'PENDING')
        RETURNING *;
      `;
      if (rows.length === 0) {
        throw new BadRequestException(`ESF document is already ${esfDoc.status} and cannot be retried`);
      }
      esfDoc = rows[0];
    }

    await this.esfQueueService.enqueueSubmission({
      tenantId: req.user.tenantId,
      esfDocumentId: esfDoc!.id,
      documentType: 'SERVICE_ACT',
      documentId: id
    });

    return esfDoc;
  }

  // --- Reports (Discounts) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/discounts')
  async getDiscountReport(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);

    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;

    const customers = await db.customer.findMany();

    const invoices = await db.invoice.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const waybills = await db.waybill.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const acts = await db.serviceAct.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const discountMap = new Map<string, { customerId: string; customerName: string; bin: string; totalDiscountAmount: number; itemCount: number }>();

    for (const c of customers) {
      discountMap.set(c.id, {
        customerId: c.id,
        customerName: c.name,
        bin: c.bin,
        totalDiscountAmount: 0,
        itemCount: 0
      });
    }

    const processItems = (customerId: string, items: Array<any>) => {
      let entry = discountMap.get(customerId);
      if (!entry) {
        entry = { customerId, customerName: 'Unknown', bin: '', totalDiscountAmount: 0, itemCount: 0 };
        discountMap.set(customerId, entry);
      }
      for (const item of items) {
        const discountAmt = Number(item.discountAmount || 0);
        entry.totalDiscountAmount += discountAmt;
        if (discountAmt !== 0) {
          entry.itemCount += 1;
        }
      }
    };

    for (const inv of invoices) processItems(inv.customerId, inv.items);
    for (const wb of waybills) processItems(wb.customerId, wb.items);
    for (const act of acts) processItems(act.customerId, act.items);

    return Array.from(discountMap.values()).map((r) => ({
      ...r,
      totalDiscountAmount: Number(r.totalDiscountAmount.toFixed(2))
    }));
  }

  // --- Reports (Currency Exposure) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/currency-exposure')
  async getCurrencyExposureReport(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);

    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;

    const invoices = await db.invoice.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const waybills = await db.waybill.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const acts = await db.serviceAct.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });

    const currencyMap = new Map<string, {
      currency: string;
      totalKztAmount: number;
      totalForeignCurrencyAmount: number;
      lineItemCount: number;
    }>();

    const processItems = (items: Array<any>) => {
      for (const item of items) {
        if (!item.dealCurrency) continue;
        let entry = currencyMap.get(item.dealCurrency);
        if (!entry) {
          entry = {
            currency: item.dealCurrency,
            totalKztAmount: 0,
            totalForeignCurrencyAmount: 0,
            lineItemCount: 0
          };
          currencyMap.set(item.dealCurrency, entry);
        }

        const kztAmt = Number(item.totalAmount || 0);
        const foreignPrice = Number(item.dealCurrencyPrice || 0);
        const qty = Number(item.quantity || 0);

        entry.totalKztAmount += kztAmt;
        entry.totalForeignCurrencyAmount += foreignPrice * qty;
        entry.lineItemCount += 1;
      }
    };

    for (const inv of invoices) processItems(inv.items);
    for (const wb of waybills) processItems(wb.items);
    for (const act of acts) processItems(act.items);

    return Array.from(currencyMap.values()).map((r) => ({
      currency: r.currency,
      totalKztAmount: Number(r.totalKztAmount.toFixed(2)),
      totalForeignCurrencyAmount: Number(r.totalForeignCurrencyAmount.toFixed(4)),
      lineItemCount: r.lineItemCount
    }));
  }

  // --- BI Reports: Module 1 (Revenue Trend) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/revenue-trend')
  async getRevenueTrend(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('granularity') granularity: string | undefined,
    @Req() req: RequestWithUser
  ) {
    try {
      const db = await this.getDb(req);
      return await this.calculateRevenueTrend(db, from, to, granularity);
    } catch (err: any) {
      console.error('[ERP API] getRevenueTrend error:', err);
      throw err;
    }
  }

  private async calculateRevenueTrend(
    db: any,
    from?: string,
    to?: string,
    granularity: string = 'month'
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    const gran = (granularity || 'month').toLowerCase();

    const allInvoices = await db.invoice.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      }
    });
    const invoices = allInvoices.filter(
      (inv: any) => inv.status !== 'DRAFT' && inv.status !== 'CANCELLED'
    );

    const allCreditNotes = await db.creditNote.findMany({
      where: {
        status: 'ISSUED',
        issueDate: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      }
    });

    const periodMap = new Map<string, { grossRevenue: number; returns: number; invoiceCount: number; creditNoteCount: number }>();

    for (const inv of invoices) {
      const dt = new Date(inv.createdAt);
      let period = '';
      if (gran === 'day') {
        period = dt.toISOString().slice(0, 10);
      } else if (gran === 'week') {
        period = getIsoWeekString(dt);
      } else {
        period = dt.toISOString().slice(0, 7);
      }

      let entry = periodMap.get(period);
      if (!entry) {
        entry = { grossRevenue: 0, returns: 0, invoiceCount: 0, creditNoteCount: 0 };
        periodMap.set(period, entry);
      }

      entry.grossRevenue += Number(inv.amount || 0);
      entry.invoiceCount += 1;
    }

    for (const cn of allCreditNotes) {
      const dt = new Date(cn.issueDate);
      let period = '';
      if (gran === 'day') {
        period = dt.toISOString().slice(0, 10);
      } else if (gran === 'week') {
        period = getIsoWeekString(dt);
      } else {
        period = dt.toISOString().slice(0, 7);
      }

      let entry = periodMap.get(period);
      if (!entry) {
        entry = { grossRevenue: 0, returns: 0, invoiceCount: 0, creditNoteCount: 0 };
        periodMap.set(period, entry);
      }

      entry.returns += Number(cn.amount || 0);
      entry.creditNoteCount += 1;
    }

    return Array.from(periodMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => {
        const gross = Number(data.grossRevenue.toFixed(2));
        const ret = Number(data.returns.toFixed(2));
        return {
          period,
          revenue: gross,
          returns: ret,
          netRevenue: Number((gross - ret).toFixed(2)),
          invoiceCount: data.invoiceCount,
          creditNoteCount: data.creditNoteCount
        };
      });
  }

  // --- BI Reports: Module 2 (Top Customers) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/top-customers')
  async getTopCustomers(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    return this.calculateTopCustomers(db, from, to, limitStr);
  }

  private async calculateTopCustomers(
    db: any,
    from?: string,
    to?: string,
    limitStr?: string
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    let limit = limitStr ? parseInt(limitStr, 10) : 10;
    if (isNaN(limit) || limit <= 0) limit = 10;

    const allInvoices = await db.invoice.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      }
    });
    const invoices = allInvoices.filter(
      (inv: any) => inv.status !== 'DRAFT' && inv.status !== 'CANCELLED'
    );

    const customers = await db.customer.findMany();
    const custMap = new Map<string, { id: string; name: string; bin: string }>();
    for (const c of customers) {
      custMap.set(c.id, { id: c.id, name: c.name, bin: c.bin });
    }

    const aggMap = new Map<string, {
      customerId: string;
      customerName: string;
      bin: string;
      totalRevenue: number;
      invoiceCount: number;
    }>();

    for (const inv of invoices) {
      let entry = aggMap.get(inv.customerId);
      if (!entry) {
        const cInfo = custMap.get(inv.customerId);
        entry = {
          customerId: inv.customerId,
          customerName: cInfo?.name || 'Unknown',
          bin: cInfo?.bin || '',
          totalRevenue: 0,
          invoiceCount: 0
        };
        aggMap.set(inv.customerId, entry);
      }

      entry.totalRevenue += Number(inv.amount || 0);
      entry.invoiceCount += 1;
    }

    return Array.from(aggMap.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, limit)
      .map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        bin: r.bin,
        totalRevenue: Number(r.totalRevenue.toFixed(2)),
        invoiceCount: r.invoiceCount
      }));
  }

  // --- BI Reports: Module 3 (Top Products) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/top-products')
  async getTopProducts(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Req() req: RequestWithUser
  ) {
    const db = await this.getDb(req);
    return this.calculateTopProducts(db, from, to, limitStr);
  }

  private async calculateTopProducts(
    db: any,
    from?: string,
    to?: string,
    limitStr?: string
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    let limit = limitStr ? parseInt(limitStr, 10) : 10;
    if (isNaN(limit) || limit <= 0) limit = 10;

    const allInvoices = await db.invoice.findMany({
      where: {
        createdAt: {
          ...(fromDate && { gte: fromDate }),
          ...(toDate && { lte: toDate })
        }
      },
      include: { items: true }
    });
    const invoices = allInvoices.filter(
      (inv: any) => inv.status !== 'DRAFT' && inv.status !== 'CANCELLED'
    );

    const productMap = new Map<string, {
      sku: string;
      name: string;
      totalRevenue: number;
      totalQuantity: number;
    }>();

    for (const inv of invoices) {
      for (const item of inv.items) {
        let entry = productMap.get(item.sku);
        if (!entry) {
          entry = {
            sku: item.sku,
            name: item.name,
            totalRevenue: 0,
            totalQuantity: 0
          };
          productMap.set(item.sku, entry);
        } else if (item.name) {
          entry.name = item.name;
        }

        entry.totalRevenue += Number(item.totalAmount || 0);
        entry.totalQuantity += Number(item.quantity || 0);
      }
    }

    return Array.from(productMap.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, limit)
      .map((r) => ({
        sku: r.sku,
        name: r.name,
        totalRevenue: Number(r.totalRevenue.toFixed(2)),
        totalQuantity: Number(r.totalQuantity.toFixed(3))
      }));
  }

  // --- BI Reports: Module 4 (AR Aging) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/ar-aging')
  async getArAging(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return this.calculateArAging(db);
  }

  private async calculateArAging(db: any) {
    const allInvoices = await db.invoice.findMany();
    const invoices = allInvoices.filter(
      (inv: any) => inv.status !== 'DRAFT' && inv.status !== 'CANCELLED'
    );

    const now = new Date();
    const bucketsMap: Record<string, { totalOutstanding: number; invoiceCount: number }> = {
      current: { totalOutstanding: 0, invoiceCount: 0 },
      '1-30': { totalOutstanding: 0, invoiceCount: 0 },
      '31-60': { totalOutstanding: 0, invoiceCount: 0 },
      '61-90': { totalOutstanding: 0, invoiceCount: 0 },
      '90+': { totalOutstanding: 0, invoiceCount: 0 }
    };

    let totalSum = 0;

    for (const inv of invoices) {
      const outstanding = Number(inv.amount || 0) - Number(inv.paidAmount || 0);
      if (outstanding <= 0) continue;

      totalSum += outstanding;
      const dueDate = new Date(inv.dueDate);
      const diffMs = now.getTime() - dueDate.getTime();
      const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      let key = 'current';
      if (daysOverdue <= 0) {
        key = 'current';
      } else if (daysOverdue <= 30) {
        key = '1-30';
      } else if (daysOverdue <= 60) {
        key = '31-60';
      } else if (daysOverdue <= 90) {
        key = '61-90';
      } else {
        key = '90+';
      }

      bucketsMap[key].totalOutstanding += outstanding;
      bucketsMap[key].invoiceCount += 1;
    }

    const bucketKeys = ['current', '1-30', '31-60', '61-90', '90+'];
    const buckets = bucketKeys.map((key) => ({
      bucket: key,
      totalOutstanding: Number(bucketsMap[key].totalOutstanding.toFixed(2)),
      invoiceCount: bucketsMap[key].invoiceCount
    }));

    return {
      buckets,
      totalOutstanding: Number(totalSum.toFixed(2))
    };
  }

  // --- BI Reports: Module 5 (AP Aging) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/ap-aging')
  async getApAging(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return this.calculateApAging(db);
  }

  private async calculateApAging(db: any) {
    const allSupplierInvoices = await db.supplierInvoice.findMany();
    const supplierInvoices = allSupplierInvoices.filter(
      (inv: any) => inv.status !== 'CANCELLED' && inv.status !== 'PAID'
    );

    const now = new Date();
    const bucketsMap: Record<string, { totalOutstanding: number; invoiceCount: number }> = {
      current: { totalOutstanding: 0, invoiceCount: 0 },
      '1-30': { totalOutstanding: 0, invoiceCount: 0 },
      '31-60': { totalOutstanding: 0, invoiceCount: 0 },
      '61-90': { totalOutstanding: 0, invoiceCount: 0 },
      '90+': { totalOutstanding: 0, invoiceCount: 0 }
    };

    let noDueDateTotal = 0;
    let noDueDateCount = 0;
    let totalSum = 0;

    for (const inv of supplierInvoices) {
      const outstanding = Number(inv.amount || 0) - Number(inv.paidAmount || 0);
      if (outstanding <= 0) continue;

      totalSum += outstanding;

      if (!inv.dueDate) {
        noDueDateTotal += outstanding;
        noDueDateCount += 1;
        continue;
      }

      const dueDate = new Date(inv.dueDate);
      const diffMs = now.getTime() - dueDate.getTime();
      const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      let key = 'current';
      if (daysOverdue <= 0) {
        key = 'current';
      } else if (daysOverdue <= 30) {
        key = '1-30';
      } else if (daysOverdue <= 60) {
        key = '31-60';
      } else if (daysOverdue <= 90) {
        key = '61-90';
      } else {
        key = '90+';
      }

      bucketsMap[key].totalOutstanding += outstanding;
      bucketsMap[key].invoiceCount += 1;
    }

    const bucketKeys = ['current', '1-30', '31-60', '61-90', '90+'];
    const buckets = bucketKeys.map((key) => ({
      bucket: key,
      totalOutstanding: Number(bucketsMap[key].totalOutstanding.toFixed(2)),
      invoiceCount: bucketsMap[key].invoiceCount
    }));

    return {
      buckets,
      noDueDate: {
        totalOutstanding: Number(noDueDateTotal.toFixed(2)),
        invoiceCount: noDueDateCount
      },
      totalOutstanding: Number(totalSum.toFixed(2))
    };
  }

  // --- BI Reports: Module 6 (Stock Health) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/stock-health')
  async getStockHealth(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    return this.calculateStockHealth(db);
  }

  private async calculateStockHealth(db: any) {
    const warehouses = await db.warehouse.findMany();
    const stockItems = await db.stockItem.findMany();

    const whStockMap = new Map<string, any[]>();
    for (const item of stockItems) {
      let list = whStockMap.get(item.warehouseId);
      if (!list) {
        list = [];
        whStockMap.set(item.warehouseId, list);
      }
      list.push(item);
    }

    return warehouses.map((wh: any) => {
      const items = whStockMap.get(wh.id) || [];
      const uniqueSkus = new Set<string>();
      let totalQuantity = 0;
      let totalReserved = 0;
      let lowStockCount = 0;

      for (const item of items) {
        uniqueSkus.add(item.sku);
        const qty = Number(item.quantity || 0);
        const res = Number(item.reserved || 0);
        totalQuantity += qty;
        totalReserved += res;
        if (res >= qty) {
          lowStockCount += 1;
        }
      }

      return {
        warehouseId: wh.id,
        warehouseName: wh.name,
        totalSkuCount: uniqueSkus.size,
        totalQuantity: Number(totalQuantity.toFixed(3)),
        totalReserved: Number(totalReserved.toFixed(3)),
        lowStockCount
      };
    });
  }

  // --- BI Reports: Module 7 (Dashboard Summary) ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('reports/dashboard-summary')
  async getDashboardSummary(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const fromIso = startOfMonth.toISOString();
    const toIso = endOfMonth.toISOString();

    const revTrend = await this.calculateRevenueTrend(db, fromIso, toIso, 'month');
    const revenueThisMonth = revTrend.reduce((acc: number, curr: any) => acc + curr.revenue, 0);

    const arAging = await this.calculateArAging(db);
    const arOutstandingTotal = arAging.totalOutstanding;

    const apAging = await this.calculateApAging(db);
    const apOutstandingTotal = apAging.totalOutstanding;

    const stockHealth = await this.calculateStockHealth(db);
    const lowStockItemCount = stockHealth.reduce((acc: number, curr: any) => acc + curr.lowStockCount, 0);

    const discountReport = await this.getDiscountReport(fromIso, toIso, req);
    const discountGivenThisMonth = discountReport.reduce((acc: number, curr: any) => acc + curr.totalDiscountAmount, 0);

    const currencyReport = await this.getCurrencyExposureReport(undefined, undefined, req);
    const currencyExposureCurrencies = currencyReport
      .filter((c) => c.totalKztAmount > 0 || c.totalForeignCurrencyAmount > 0)
      .map((c) => c.currency);

    return {
      revenueThisMonth: Number(revenueThisMonth.toFixed(2)),
      arOutstandingTotal: Number(arOutstandingTotal.toFixed(2)),
      apOutstandingTotal: Number(apOutstandingTotal.toFixed(2)),
      lowStockItemCount,
      discountGivenThisMonth: Number(discountGivenThisMonth.toFixed(2)),
      currencyExposureCurrencies
    };
  }

  // --- Tenant Profile ---

  @Roles('ERP_ACCOUNTANT', 'ERP_WAREHOUSE_MANAGER', 'ERP_PURCHASER', 'ERP_CEO')
  @Get('tenant-profile')
  async getTenantProfile(@Req() req: RequestWithUser) {
    const db = await this.getDb(req);
    const profile = await db.tenantProfile.findFirst();
    if (!profile) {
      throw new NotFoundException('Tenant profile not found');
    }
    return profile;
  }

  @Roles('ERP_ACCOUNTANT', 'ERP_CEO')
  @Put('tenant-profile')
  async updateTenantProfile(
    @Req() req: RequestWithUser,
    @Body() body: {
      companyName?: string;
      companyBin?: string;
      legalAddress?: string;
      directorName?: string;
      directorIin?: string;
    }
  ) {
    const db = await this.getDb(req);
    const profile = await db.tenantProfile.findFirst();
    
    if (!body.companyName || !body.companyBin) {
      throw new BadRequestException('companyName and companyBin are required');
    }

    if (profile) {
      return db.tenantProfile.update({
        where: { id: profile.id },
        data: {
          companyName: body.companyName,
          companyBin: body.companyBin,
          legalAddress: body.legalAddress,
          directorName: body.directorName,
          directorIin: body.directorIin
        }
      });
    } else {
      return db.tenantProfile.create({
        data: {
          id: 'tenant_profile',
          companyName: body.companyName,
          companyBin: body.companyBin,
          legalAddress: body.legalAddress,
          directorName: body.directorName,
          directorIin: body.directorIin
        }
      });
    }
  }
}

function getIsoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const weekStr = weekNo < 10 ? `0${weekNo}` : `${weekNo}`;
  return `${d.getUTCFullYear()}-W${weekStr}`;
}
