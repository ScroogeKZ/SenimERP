import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { TenantPrismaService } from './prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { EsfQueueService } from './esf-queue.service.js';
import { EsfWorkerService } from './esf-worker.service.js';
import { ErpController } from './erp.controller.js';

@Module({
  imports: [],
  controllers: [ErpController],
  providers: [Reflector, RolesGuard, TenantPrismaService, EventConsumerService, EsfQueueService, EsfWorkerService],
})
export class AppModule {}

