import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { redisConnection } from '@senimerp/event-bus-client';

export interface EsfSubmissionJobPayload {
  tenantId: string;
  esfDocumentId: string;
  documentType: 'WAYBILL' | 'SERVICE_ACT' | 'INVOICE';
  documentId: string;
}

@Injectable()
export class EsfQueueService implements OnModuleDestroy {
  private queue: Queue;

  constructor() {
    // Uses standard redisConnection from event-bus-client (default db, no override)
    this.queue = new Queue('esf-submission', {
      connection: new Redis(redisConnection as any),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000 // 2s, 4s, 8s, 16s, 32s
        },
        removeOnComplete: true,
        removeOnFail: false
      }
    });
  }

  async enqueueSubmission(payload: EsfSubmissionJobPayload): Promise<void> {
    const jobId = `esf-sub-${payload.esfDocumentId}-${Date.now()}`;
    await this.queue.add('submit-esf', payload, { jobId });
    console.log(`[EsfQueueService] Enqueued ESF submission for ${payload.documentType} ${payload.documentId} (EsfDoc: ${payload.esfDocumentId})`);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
