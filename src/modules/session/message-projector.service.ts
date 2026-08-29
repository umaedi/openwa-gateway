import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Session } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { SessionLidResolver } from './session-lid-resolver.service';
import { buildMessageMetadata, storableWaMessageId } from './message-row.mapper';
import { MessageMutationProjector } from './message-mutation-projector';
import { persistHistoryMessages } from './message-history-projector';
import { isUniqueViolation } from '../../common/utils/db-errors';
import {
  IWhatsAppEngine,
  DeliveryStatus,
  IncomingMessage,
  ReactionEvent,
  EditedMessage,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';

export const ACK_RECONCILE_DELAY_MS = 750;

interface InboundPersistOutcome {
  dbMessage: Message;
  persisted: boolean;
}

@Injectable()
export class MessageProjector {
  private readonly logger = createLogger('MessageProjector');

  private readonly messageMutations = new KeyedMutationQueue((key, err) => {
    this.logger.error(`Unexpected failure applying message mutation: ${key}`, String(err));
  });

  private readonly mutationProjector: MessageMutationProjector;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly engines: EngineRegistry,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly lidResolver: SessionLidResolver,
    @Optional()
    private readonly configService?: ConfigService,
  ) {
    this.mutationProjector = new MessageMutationProjector(
      this.messageRepository,
      this.eventsGateway,
      this.webhookService,
      this.messageMutations,
      this.logger,
    );
  }

  handleInboundMessage(id: string, engine: IWhatsAppEngine, message: IncomingMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    if (message.isStatusBroadcast) return;
    if (this.shouldSkipEphemeralMessage(id, message)) return;

    this.logger.debug(`Message received from ${message.from}`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      action: 'message_received',
    });

    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    const messageData = { ...message };

    void this.projectInboundMessage(id, engine, messageData)
      .catch(err => this.logger.error(`onMessage handler failed for ${id}`, String(err)));
  }

  async persistHistoryMessages(id: string, messages: IncomingMessage[]): Promise<void> {
    if (!messages.length) return;
    await persistHistoryMessages(this.messageRepository, this.configService, id, messages, this.logger);
  }

  handleHistorySync(id: string, engine: IWhatsAppEngine, messages: IncomingMessage[]): void {
    if (!this.engines.isLive(id, engine)) return;
    if (!messages.length) return;
    void this.persistHistoryMessages(id, messages).catch(err =>
      this.logger.warn('Failed to persist history messages', {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private async persistInboundMessage(id: string, finalMessage: IncomingMessage): Promise<InboundPersistOutcome> {
    const rawFrom = finalMessage.from;
    const authorJid = finalMessage.author || finalMessage.from;
    const resolvedFrom = (await this.lidResolver.resolveSenderPhone(id, rawFrom)) || rawFrom;
    const resolvedAuthor = (await this.lidResolver.resolveSenderPhone(id, authorJid)) || authorJid;

    const dbMessage = this.messageRepository.create({
      sessionId: id,
      waMessageId: storableWaMessageId(finalMessage.id),
      chatId: resolvedFrom,
      from: resolvedFrom,
      to: finalMessage.to,
      author: resolvedAuthor !== resolvedFrom ? resolvedAuthor : undefined,
      chatName: finalMessage.chatId || undefined,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      type: finalMessage.type,
      body: finalMessage.body || '',
      metadata: buildMessageMetadata(finalMessage),
      timestamp: finalMessage.timestamp,
    });

    let persisted = false;
    try {
      await this.messageRepository.save(dbMessage);
      persisted = true;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        this.logger.error(`Failed to save incoming message ${finalMessage.id} to database`, String(err));
      }
    }

    return { dbMessage, persisted };
  }

  private async projectInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: IncomingMessage,
  ): Promise<void> {
    if (!this.engines.isLive(id, engine)) return;

    await this.persistInboundMessage(id, finalMessage);

    const webhookPayload = finalMessage as unknown as Record<string, unknown>;
    void this.webhookService.dispatch(id, 'message.received', webhookPayload);
    this.eventsGateway.emitMessage(id, webhookPayload);
  }

  handleOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    if (!message.fromMe) return;
    if (message.isStatusBroadcast) return;

    this.logger.debug(`Message sent to ${message.to}`, {
      sessionId: id,
      messageId: message.id,
      to: message.to,
      action: 'message_sent',
    });

    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    const finalMessage = { ...message };

    void (async () => {
      if (!this.engines.isLive(id, engine)) return;

      const rawTo = finalMessage.to || '';
      const resolvedTo = (await this.lidResolver.resolveSenderPhone(id, rawTo)) || rawTo;
      const resolvedAuthor = finalMessage.author
        ? (await this.lidResolver.resolveSenderPhone(id, finalMessage.author)) || finalMessage.author
        : undefined;

      const outgoing = this.messageRepository.create({
        sessionId: id,
        waMessageId: storableWaMessageId(finalMessage.id),
        chatId: resolvedTo,
        from: finalMessage.from,
        to: resolvedTo,
        author: resolvedAuthor,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        type: finalMessage.type,
        body: finalMessage.body || '',
        metadata: buildMessageMetadata(finalMessage, true),
        timestamp: finalMessage.timestamp,
      });

      try {
        await this.messageRepository.save(outgoing);
      } catch (err) {
        if (!isUniqueViolation(err)) {
          this.logger.error(`Failed to save outgoing message ${outgoing.id} to database`, String(err));
        }
      }

      const webhookPayload = finalMessage as unknown as Record<string, unknown>;
      void this.webhookService.dispatch(id, 'message.sent', webhookPayload);
      this.eventsGateway.emitMessageSent(id, webhookPayload);
    })().catch(err => this.logger.error(`onMessageCreate handler failed for ${id}`, String(err)));
  }

  handleMessageAck(id: string, engine: IWhatsAppEngine, messageId: string, status: DeliveryStatus): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
      sessionId: id,
      messageId,
      status,
      action: 'message_ack',
    });

    const newStatus = deliveryStatusToMessageStatus(status) || MessageStatus.SENT;
    const newAck = deliveryStatusToAck(status);
    const allowedPriorAcks = ackStatusTransitionFrom(newStatus);

    void (async () => {
      try {
        let updateResult = await this.messageRepository
          .createQueryBuilder()
          .update(Message)
          .set({
            status: newStatus,
          } as QueryDeepPartialEntity<Message>)
          .where('sessionId = :sessionId', { sessionId: id })
          .andWhere('waMessageId = :messageId', { messageId })
          .andWhere(
            allowedPriorAcks.length > 0 ? '(status IS NULL OR status IN (:...allowedPriorAcks))' : 'status IS NULL',
            { allowedPriorAcks },
          )
          .execute();

        if (updateResult.affected === 0) {
          await new Promise(resolve => setTimeout(resolve, ACK_RECONCILE_DELAY_MS));
          if (!this.engines.isLive(id, engine)) return;

          updateResult = await this.messageRepository
            .createQueryBuilder()
            .update(Message)
            .set({
              status: newStatus,
            } as QueryDeepPartialEntity<Message>)
            .where('sessionId = :sessionId', { sessionId: id })
            .andWhere('waMessageId = :messageId', { messageId })
            .andWhere(
              allowedPriorAcks.length > 0 ? '(status IS NULL OR status IN (:...allowedPriorAcks))' : 'status IS NULL',
              { allowedPriorAcks },
            )
            .execute();
        }
      } catch (err) {
        this.logger.warn(`Failed to update message status for ${messageId}`, {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    const ackPayload = { id, messageId, status, ack: newAck };
    this.eventsGateway.emitMessageAck(id, ackPayload);
    void this.webhookService.dispatch(id, 'message.ack', { sessionId: id, ...ackPayload });

    if (status === ('failed' as DeliveryStatus)) {
      void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
    }
  }

  handleMessageRevoked(id: string, engine: IWhatsAppEngine, message: RevokedMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message revoked: ${message.id}`, {
      sessionId: id,
      messageId: message.id,
      action: 'message_revoked',
    });

    void this.messageRepository
      .update(
        { sessionId: id, waMessageId: message.id },
        {
          metadata: () =>
            `CASE WHEN metadata IS NULL THEN '{"revoked":true}' ELSE json_set(metadata, '$.revoked', json('true')) END`,
        },
      )
      .catch(() => undefined);

    const revokedPayload = {
      messageId: message.id,
      from: message.from,
      to: message.to,
      timestamp: message.timestamp,
    };
    this.eventsGateway.emitMessageRevoked(id, revokedPayload);
    void this.webhookService.dispatch(id, 'message.revoked', { sessionId: id, ...revokedPayload });
  }

  applyReactionQueued(id: string, event: ReactionEvent): void {
    this.mutationProjector.applyReactionQueued(id, event);
  }

  applyMessageEditQueued(id: string, message: EditedMessage): void {
    this.mutationProjector.applyMessageEditQueued(id, message);
  }

  async recordOutboundMessageEdit(sessionId: string, messageId: string, body: string): Promise<void> {
    await this.mutationProjector.recordOutboundMessageEdit(sessionId, messageId, body);
  }

  private shouldSkipEphemeralMessage(id: string, message: IncomingMessage): boolean {
    if ((message.type as string) === 'e2e_notification') {
      this.logger.debug(`Skipping e2e_notification system message from ${message.from}`, { sessionId: id });
      return true;
    }
    return false;
  }
}
