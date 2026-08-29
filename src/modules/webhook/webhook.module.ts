import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { Session } from '../session/entities/session.entity';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookController } from './webhook.controller';
import { WebhooksListController } from './webhooks-list.controller';
import { EngineModule } from '../../engine/engine.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Webhook, WebhookDeliveryFailure, Session], 'data'),
    EngineModule,
  ],
  controllers: [WebhookController, WebhooksListController],
  providers: [WebhookService, WebhookDeliveryService],
  exports: [WebhookService],
})
export class WebhookModule {}
