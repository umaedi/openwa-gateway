import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';

export class SessionEngineLeafEvents {
  private readonly sessionRepository: Repository<Session>;
  private readonly eventsGateway: EventsGateway;
  private readonly webhookService: WebhookService;
  private readonly configService?: ConfigService;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: {
    sessionRepository: Repository<Session>;
    eventsGateway: EventsGateway;
    webhookService: WebhookService;
    configService?: ConfigService;
    logger: ReturnType<typeof createLogger>;
  }) {
    this.sessionRepository = deps.sessionRepository;
    this.eventsGateway = deps.eventsGateway;
    this.webhookService = deps.webhookService;
    this.configService = deps.configService;
    this.logger = deps.logger;
  }

  async seedStatuses(_sessionId: string, _engine: IWhatsAppEngine): Promise<void> {
    // Status store removed in lean edition
    return Promise.resolve();
  }

  async maybeAutoRejectCall(id: string, engine: IWhatsAppEngine, callId: string): Promise<void> {
    let session: Session | null;
    try {
      session = await this.sessionRepository.findOne({ where: { id } });
    } catch (err) {
      this.logger.error('Failed to reload the session for call auto-reject', String(err), {
        sessionId: id,
        action: 'call_auto_reject_error',
      });
      return;
    }
    if (session?.config?.autoRejectCalls !== true) {
      return;
    }
    try {
      await engine.rejectCall(callId);
      this.logger.log('Auto-rejected incoming call', {
        sessionId: id,
        callId,
        action: 'call_auto_rejected',
      });
    } catch (err) {
      this.logger.warn('Failed to auto-reject incoming call', {
        sessionId: id,
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
