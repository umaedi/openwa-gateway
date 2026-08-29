import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionProxyInterceptor } from './session-proxy.interceptor';
import { MessageProjector } from './message-projector.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Session, Message], 'data'),
    WebhookModule,
  ],
  controllers: [SessionController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: SessionProxyInterceptor },
    SessionService,
    SessionEngineLifecycle,
    SessionErrorStore,
    SessionRestrictionStore,
    PresenceStore,
    SessionLidResolver,
    SessionLivenessWatchdog,
    SessionOwnershipService,
    MessageProjector,
  ],
  exports: [SessionService, MessageProjector, SessionOwnershipService],
})
export class SessionModule {}
