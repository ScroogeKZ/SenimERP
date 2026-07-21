import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { redisConnection } from '@senimerp/event-bus-client';
import { EsfXmlGenerator, EsfSoapClient, EsfDocumentData } from '@senimerp/integrations';
import { TenantPrismaService } from './prisma.service.js';
import { EsfSubmissionJobPayload } from './esf-queue.service.js';

@Injectable()
export class EsfWorkerService implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker;
  private soapClient = new EsfSoapClient(); // Default to environment-driven SOAP client
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
      // Fetch TenantProfile for this tenant to get correct supplier metadata
      const tenantProfile = await db.tenantProfile.findFirst();
      const isEsfMock = process.env.IS_ESF_MOCK !== 'false';

      if (!isEsfMock && (!tenantProfile || !tenantProfile.companyBin || tenantProfile.companyBin === '000000000000')) {
        throw new Error('TenantProfile is not configured. Please set it via PUT /api/tenant-profile before submitting to the production IS ESF endpoint.');
      }

      const isRealBin = !!(tenantProfile?.companyBin && tenantProfile.companyBin !== '000000000000');
      const supplierBin = isRealBin ? tenantProfile!.companyBin : '990840001234';
      const supplierName = tenantProfile?.companyName && tenantProfile.companyName !== tenantId ? tenantProfile.companyName : 'SenimERP Tenant';
      const supplierAddress = tenantProfile?.legalAddress || 'г. Алматы, пр. Абая 150';
      const directorIin = tenantProfile?.directorIin || '950412345678';
      const directorName = tenantProfile?.directorName || 'SENIM ERP';

      const supplier = {
        bin: supplierBin,
        name: supplierName,
        address: supplierAddress
      };

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
          supplier,
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
          supplier,
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
          supplier,
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
      } else if (documentType === 'CREDIT_NOTE') {
        const creditNote = await db.creditNote.findUnique({
          where: { id: documentId },
          include: { customer: true, items: true }
        });
        if (!creditNote) throw new Error(`CreditNote ${documentId} not found`);
        existingSignedXml = creditNote.signedXml || '';

        docData = {
          documentType: 'CREDIT_NOTE',
          documentId: creditNote.id,
          documentNumber: creditNote.number,
          turnoverDate: creditNote.issueDate.toISOString().split('T')[0],
          supplier,
          customer: {
            bin: creditNote.customer.bin,
            name: creditNote.customer.name,
            address: creditNote.customer.address || undefined
          },
          items: creditNote.items.map((item: any) => ({
            sku: item.sku,
            name: item.name,
            quantity: Number(item.quantity),
            price: Number(item.price),
            vatRate: Number(item.vatRate),
            vatAmount: Number(item.vatAmount),
            totalAmount: Number(item.totalAmount)
          })),
          totalAmount: Number(creditNote.amount),
          totalVatAmount: Number(creditNote.vatAmount)
        };
      }

      if (!docData) throw new Error(`Unsupported document type ${documentType}`);

      // 1. Generate ESF XML
      const rawXml = EsfXmlGenerator.generateXml(docData);

      // 2. Wrap/Sign with digital signature
      const signedXml = existingSignedXml || `<signedXml><data>${Buffer.from(rawXml).toString('base64')}</data><signature bin="${supplierBin}" iin="${directorIin}" name="${directorName}">MOCK_ESF_SIGNATURE</signature></signedXml>`;

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
    const baseDbUrl = process.env.DATABASE_BASE_URL || 'postgresql://postgres:postgres@localhost:5434/senimerp_dev';
    const baseClient = new PrismaClient({ datasources: { db: { url: `${baseDbUrl}?schema=public` } } });

    try {
      const schemas = await baseClient.$queryRaw<Array<{ schema_name: string }>>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%';
      `;

      for (const { schema_name } of schemas) {
        try {
          const tenantId = schema_name.replace('tenant_', '');
          const db = await this.prismaService.getTenantClient(tenantId);

          const submittedDocs = await db.esfDocument.findMany({ where: { status: 'SUBMITTED' } });

          for (const doc of submittedDocs) {
            if (!doc.esfRegNumber) continue;
            try {
              const result = await this.soapClient.checkStatus(doc.esfRegNumber);
              if (result.status !== 'SUBMITTED') {
                const updateData: any = {
                  status: result.status,
                  esfRegNumber: result.esfRegNumber || doc.esfRegNumber,
                  responseXml: result.responseXml || doc.responseXml,
                  errorMessage: result.errorMessage || null
                };
                if (result.status === 'REGISTERED') {
                  updateData.confirmedAt = new Date();
                }
                await db.esfDocument.update({
                  where: { id: doc.id },
                  data: updateData
                });
                console.log(`[EsfWorkerService] Polled EsfDocument ${doc.id}: SUBMITTED → ${result.status}`);
              }
            } catch (err: any) {
              console.error(`[EsfWorkerService] Failed to poll status for EsfDocument ${doc.id}:`, err?.message || err);
            }
          }
        } catch (tenantErr: any) {
          console.error(`[EsfWorkerService] Error polling tenant schema ${schema_name}:`, tenantErr?.message || tenantErr);
        }
      }
    } catch (err: any) {
      console.error('[EsfWorkerService] Failed to query tenant schemas for polling:', err?.message || err);
    } finally {
      await baseClient.$disconnect();
    }
  }
}
