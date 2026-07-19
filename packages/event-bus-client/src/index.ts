import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { IntegrationEvent } from '@senimerp/types';

// Read configuration or default to our docker-compose ports
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6382', 10);

export const redisConnection: ConnectionOptions = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null, // Critical configuration flag required by BullMQ
};

/**
 * Publisher class to dispatch events onto the Integration Bus.
 */
export class EventBusPublisher {
  private queue: Queue;

  constructor(queueName = 'integration-bus', connectionOpts?: ConnectionOptions) {
    this.queue = new Queue(queueName, {
      connection: new Redis((connectionOpts || redisConnection) as any),
      defaultJobOptions: {
        attempts: 3, // Retry 3 times
        backoff: {
          type: 'exponential',
          delay: 2000, // 2s, 4s, 8s backoff
        },
        removeOnComplete: true, // Clear memory for successful runs
        removeOnFail: false,    // Keep failed jobs for manual DLQ tracking
      },
    });
  }

  /**
   * Publishes an event to the integration bus.
   * Leverages BullMQ jobId for deduplication (idempotency).
   */
  async publishEvent<T>(event: IntegrationEvent<T>): Promise<void> {
    await this.queue.add(event.eventType, event, { jobId: event.eventId });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export type EventHandler<T = any> = (event: IntegrationEvent<T>) => Promise<void>;

/**
 * Subscriber class to consume events from the Integration Bus.
 */
export class EventBusSubscriber {
  private worker: Worker;

  constructor(
    queueName = 'integration-bus',
    handlers: Record<string, EventHandler>,
    connectionOpts?: ConnectionOptions
  ) {
    const redisConn = connectionOpts || redisConnection;
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const event = job.data as IntegrationEvent;
        const handler = handlers[event.eventType];
        if (handler) {
          await handler(event);
        } else {
          console.warn(`No handler registered for event type: ${event.eventType} on queue ${queueName}`);
          const forwardCount = (event as any)._forwardCount || 0;
          if (forwardCount < 10) {
            const forwardedEvent = {
              ...event,
              _forwardCount: forwardCount + 1,
            };
            const queue = new Queue(queueName, {
              connection: new Redis(redisConn as any),
            });
            await queue.add(event.eventType, forwardedEvent, {
              jobId: `${event.eventId}-fwd-${forwardCount + 1}`,
              delay: 200,
            });
            await queue.close();
          } else {
            console.error(`Event ${event.eventId} (type: ${event.eventType}) exceeded max forward attempts. Discarding.`);
          }
        }
      },
      {
        connection: new Redis(redisConn as any),
        concurrency: 1, // Handle sequentially (context cache protection)
      }
    );

    this.worker.on('failed', (job, err) => {
      console.error(`[EventBus] Event ${job?.id} (${job?.name}) failed:`, err.message);
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
