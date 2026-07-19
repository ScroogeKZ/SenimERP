import { Module } from '@nestjs/common';
import { TenantPrismaService } from './prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { ErpController } from './erp.controller.js';

@Module({
  imports: [],
  controllers: [ErpController],
  providers: [TenantPrismaService, EventConsumerService],
})
export class AppModule {}
