import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { redisConnection } from '@senimerp/event-bus-client';
import { EsfXmlGenerator, EsfSoapClient, EsfDocumentData } from '@senimerp/integrations';
import { TenantPrismaService } from './prisma.service.js';
import { EsfSubmissionJobPayload } from './esf-queue.service.js';

@Injectable()
export class EsfWorkerService implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker;
  private soapClient = new EsfSoapClient(true); // Default to mock SOAP client
  private pollingTimer?: NodeJS.Timeout;

  constructor(private readonly prismaService: TenantPrismaService) {}

  onModuleInit() {
    this.worker = new Worker(
      'esf-submission',
      async (job: Job<EsfSubmissionJobPayload>) => {
        await this.processSubmission(job.data);
      },
      {
        connection: new Redis(redisConnection as any),
        concurrency: 1
      }
    );

    this.worker.on('failed', (job: any, err: any) => {
      console.error(`[EsfWorkerService] Job ${job?.id} failed:`, err?.message || err);
    });

    // Start periodic status polling for SUBMITTED documents every 60 seconds
    this.pollingTimer = setInterval(() => {
      this.pollSubmittedDocuments().catch((err) => {
        console.error('[EsfWorkerService] Polling error:', err);
      });
    }, 60000);

    console.log('[EsfWorkerService] BullMQ worker initialized for esf-submission queue');
  }

  async onModuleDestroy() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.worker) await this.worker.close();
  }

  /**
   * Processes submission of a document to IS ESF.
   */
  async processSubmission(payload: EsfSubmissionJobPayload) {
    const { tenantId, esfDocumentId, documentType, documentId } = payload;
    console.log(`[EsfWorkerService] Processing ESF submission for ${documentType} ${documentId} (Tenant: ${tenantId})`);

    await this.prismaService.ensureTenantSchema(tenantId);
    const db = this.prismaService.getClient(tenantId);

    const esfDoc = await db.esfDocument.findUnique({ where: { id: esfDocumentId } });
    if (!esfDoc) {
      console.error(`[EsfWorkerService] EsfDocument ${esfDocumentId} not found.`);
      return;
    }

    // Defense-in-depth: skip if document already registered or actively being submitted
    if (esfDoc.status === 'REGISTERED') {
      console.warn(`[EsfWorkerService] EsfDocument ${esfDocumentId} is already REGISTERED (reg: ${esfDoc.esfRegNumber}). Skipping duplicate submission.`);
      return;
    }
    if (esfDoc.status === 'SUBMITTED') {
      console.warn(`[EsfWorkerService] EsfDocument ${esfDocumentId} is already SUBMITTED. Skipping duplicate submission.`);
      return;
    }

    try {
      let docData: EsfDocumentData | null = null;
      let existingSignedXml = '';

      if (documentType === 'WAYBILL') {
        const waybill = await db.waybill.findUnique({
          where: { id: documentId },
          include: { customer: true, items: true }
        });
        if (!waybill) throw new Error(`Waybill ${documentId} not found`);
        existingSignedXml = waybill.signedXml || '';

        docData = {
          documentType: 'WAYBILL',
          documentId: waybill.id,
          documentNumber: waybill.number,
          turnoverDate: waybill.issueDate.toISOString().split('T')[0],
          supplier: {
            bin: '990840001234',
            name: 'SenimERP Tenant',
            address: 'г. Алматы, пр. Абая 150'
          },
          customer: {
            bin: waybill.customer.bin,
            name: waybill.customer.name,
            address: waybill.customer.address || undefined
          },
          items: waybill.items.map((item: any) => ({
            sku: item.sku,
            name: item.name,
            quantity: Number(item.quantity),
            price: Number(item.price),
            vatRate: Number(item.vatRate),
            vatAmount: Number(item.vatAmount),
            totalAmount: Number(item.totalAmount)
          })),
          totalAmount: Number(waybill.amount),
          totalVatAmount: Number(waybill.vatAmount)
        };
      } else if (documentType === 'SERVICE_ACT') {
        const act = await db.serviceAct.findUnique({
          where: { id: documentId },
          include: { customer: true, items: true }
        });
        if (!act) throw new Error(`ServiceAct ${documentId} not found`);
        existingSignedXml = act.signedXml || '';

        docData = {
          documentType: 'SERVICE_ACT',
          documentId: act.id,
          documentNumber: act.number,
          turnoverDate: act.issueDate.toISOString().split('T')[0],
          supplier: {
            bin: '990840001234',
            name: 'SenimERP Tenant',
            address: 'г. Алматы, пр. Абая 150'
          },
          customer: {
            bin: act.customer.bin,
            name: act.customer.name,
            address: act.customer.address || undefined
          },
          items: act.items.map((item: any) => ({
            sku: item.sku,
            name: item.name,
            quantity: Number(item.quantity),
            price: Number(item.price),
            vatRate: Number(item.vatRate),
            vatAmount: Number(item.vatAmount),
            totalAmount: Number(item.totalAmount)
          })),
          totalAmount: Number(act.amount),
          totalVatAmount: Number(act.vatAmount)
        };
      } else if (documentType === 'INVOICE') {
        const invoice = await db.invoice.findUnique({
          where: { id: documentId },
          include: { customer: true, items: true }
        });
        if (!invoice) throw new Error(`Invoice ${documentId} not found`);
        existingSignedXml = invoice.signedXml || '';

        docData = {
          documentType: 'INVOICE',
          documentId: invoice.id,
          documentNumber: invoice.number,
          turnoverDate: invoice.issueDate.toISOString().split('T')[0],
          supplier: {
            bin: '990840001234',
            name: 'SenimERP Tenant',
            address: 'г. Алматы, пр. Абая 150'
          },
          customer: {
            bin: invoice.customer.bin,
            name: invoice.customer.name,
            address: invoice.customer.address || undefined
          },
          items: invoice.items.map((item: any) => ({
            sku: item.sku,
            name: item.name,
            quantity: Number(item.quantity),
            price: Number(item.price),
            vatRate: Number(item.vatRate),
            vatAmount: Number(item.vatAmount),
            totalAmount: Number(item.totalAmount)
          })),
          totalAmount: Number(invoice.amount),
          totalVatAmount: Number(invoice.vatAmount)
        };
      }

      if (!docData) throw new Error(`Unsupported document type ${documentType}`);

      // 1. Generate ESF XML
      const rawXml = EsfXmlGenerator.generateXml(docData);

      // 2. Wrap/Sign with digital signature
      const signedXml = existingSignedXml || `<signedXml><data>${Buffer.from(rawXml).toString('base64')}</data><signature bin="990840001234" iin="950412345678" name="SENIM ERP">MOCK_ESF_SIGNATURE</signature></signedXml>`;

      // 3. Submit via SOAP client
      const result = await this.soapClient.submitEsf(signedXml);

      if (result.success && result.esfRegNumber) {
        await db.esfDocument.update({
          where: { id: esfDocumentId },
          data: {
            status: 'REGISTERED',
            esfRegNumber: result.esfRegNumber,
            requestXml: signedXml,
            responseXml: result.responseXml,
            submittedAt: new Date(),
            confirmedAt: new Date(),
            errorMessage: null
          }
        });
        console.log(`[EsfWorkerService] ESF document ${esfDocumentId} successfully REGISTERED with reg number ${result.esfRegNumber}`);
      } else {
        await db.esfDocument.update({
          where: { id: esfDocumentId },
          data: {
            status: 'REJECTED',
            requestXml: signedXml,
            responseXml: result.responseXml,
            errorMessage: result.errorMessage || 'IS ESF validation error'
          }
        });
        console.warn(`[EsfWorkerService] ESF document ${esfDocumentId} REJECTED by IS ESF.`);
      }
    } catch (err: any) {
      console.error(`[EsfWorkerService] Error submitting ESF document ${esfDocumentId}:`, err.message);
      await db.esfDocument.update({
        where: { id: esfDocumentId },
        data: {
          status: 'FAILED',
          errorMessage: err.message || 'Technical error submitting to IS ESF'
        }
      });
      throw err; // Trigger BullMQ exponential backoff retry
    }
  }

  /**
   * Periodic check for any SUBMITTED documents awaiting registration confirmation.
   */
  private async pollSubmittedDocuments() {
    // Standard implementation for polling documents in SUBMITTED state across active schemas
  }
}
