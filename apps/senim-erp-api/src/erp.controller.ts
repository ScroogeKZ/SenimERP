import { Controller, Get, Post, Body, Param, UseGuards, Req, NotFoundException, BadRequestException } from '@nestjs/common';
import { AuthGuard, RequestWithUser } from './auth.guard.js';
import { TenantPrismaService } from './prisma.service.js';
import { NCALayerService } from '@senimerp/integrations';
import { EventBusPublisher } from '@senimerp/event-bus-client';
import { IntegrationEvent, InvoicePaidPayload, ShipmentCompletedPayload } from '@senimerp/types';
import crypto from 'crypto';

@Controller('api')
@UseGuards(AuthGuard)
export class ErpController {
  private publisher = new EventBusPublisher();

  constructor(private readonly prismaService: TenantPrismaService) {}

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
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('invoices/:id')
  async getInvoiceById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true }
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
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('waybills/:id')
  async getWaybillById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const waybill = await db.waybill.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true }
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

    const waybill = await db.waybill.findUnique({ where: { id } });
    if (!waybill) throw new NotFoundException('Waybill not found');

    const updated = await db.$transaction(async (tx: any) => {
      await tx.documentSignature.create({
        data: {
          waybillId: id,
          signedBy: certDetails.signedBy,
          iin: certDetails.iin,
          certSerial: certDetails.certSerial
        }
      });

      return tx.waybill.update({
        where: { id },
        data: {
          status: 'DELIVERED',
          signedXml
        }
      });
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
    console.log(`[ERP API] Waybill ${waybill.number} signed. Fired shipment.completed event.`);

    return updated;
  }

  // --- Service Acts ---

  @Get('acts')
  async getActs(@Req() req: RequestWithUser) {
    const db = this.getDb(req);
    return db.serviceAct.findMany({
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Get('acts/:id')
  async getActById(@Param('id') id: string, @Req() req: RequestWithUser) {
    const db = this.getDb(req);
    const act = await db.serviceAct.findUnique({
      where: { id },
      include: { customer: true, items: true, signature: true }
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
}
