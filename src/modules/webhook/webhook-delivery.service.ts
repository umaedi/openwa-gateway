import { Injectable, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { setTimeout } from 'node:timers/promises';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { recordTerminalFailure, postWebhookPayload } from './utils/deliver-once';
import { createLogger } from '../../common/services/logger.service';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { evaluateFilters } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { MetaWebhookTransformer, MetaWebhookPayload } from './meta-webhook-transformer';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookJobData {
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  headers: Record<string, string>;
  attempt: number;
  maxRetries: number;
}

const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS = 5000;

export type WebhookDeliveryOutcome = 'delivered' | 'enqueued' | 'cancelled' | 'failed';

interface DispatchEventContext {
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
}

@Injectable()
export class WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookDelivery');
  private readonly dispatchLimiter: ConcurrencyLimiter;
  private readonly inFlightDeliveries = new Map<
    string,
    { webhookId: string; sessionId: string; event: string; idempotencyKey: string; url: string }
  >();
  private readonly pendingBookkeeping = new Set<Promise<boolean>>();

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
  ) {
    this.dispatchLimiter = new ConcurrencyLimiter(
      this.configService.get<number>('webhook.dispatchConcurrency', 16),
      this.configService.get<number>('webhook.dispatchMaxQueued', 1000),
    );
  }

  onModuleInit(): void {
    const drainMs = this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    const deliveryTimeoutMs = this.configService.get<number>('webhook.timeout', 10_000);
    if (Number.isFinite(drainMs) && Number.isFinite(deliveryTimeoutMs) && drainMs < deliveryTimeoutMs) {
      this.logger.warn(
        `WEBHOOK_SHUTDOWN_DRAIN_MS (${drainMs}ms) is shorter than WEBHOOK_TIMEOUT (${deliveryTimeoutMs}ms)`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.dispatchLimiter.close();
    const drainMs = Math.max(
      0,
      this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS),
    );
    const deadline = Date.now() + drainMs;
    while (this.dispatchLimiter.activeCount > 0 || this.pendingBookkeeping.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await setTimeout(Math.min(50, remaining));
    }
    for (const lost of this.inFlightDeliveries.values()) {
      this.logger.error('Webhook delivery abandoned during shutdown', undefined, {
        ...lost,
        action: 'webhook_delivery_abandoned_shutdown',
      });
    }
    this.inFlightDeliveries.clear();
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    const webhooks = await this.loadActiveWebhooks(sessionId, event);
    const matchingWebhooks = this.filterMatchingWebhooks(webhooks, event, data);

    const occurredAt = new Date().toISOString();
    const baseIdempotencyKey = generateIdempotencyKey(event, { ...data, sessionId }, occurredAt);

    const ctx: DispatchEventContext = { sessionId, event, baseData: data };
    await Promise.allSettled(matchingWebhooks.map(webhook => this.dispatchWithLimit(webhook, baseIdempotencyKey, ctx)));
  }

  private async loadActiveWebhooks(sessionId: string, event: string): Promise<Webhook[]> {
    try {
      return await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return [];
    }
  }

  private filterMatchingWebhooks(webhooks: Webhook[], event: string, data: Record<string, unknown>): Webhook[] {
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.resolveLid(jid) ?? null;
    const subscribed = webhooks.filter(w => w.events.includes(event) || w.events.includes('*'));
    return subscribed.filter(w => evaluateFilters(w.filters, event, data, resolveLid));
  }

  private async dispatchWithLimit(
    webhook: Webhook,
    baseIdempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
    const deliveryId = generateDeliveryId();
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${baseIdempotencyKey}:${webhook.id}`)
      .digest('hex')
      .slice(0, 32);

    const { sessionId, event } = ctx;
    const inFlightKey = `${webhook.id}:${deliveryId}`;
    this.inFlightDeliveries.set(inFlightKey, {
      webhookId: webhook.id,
      sessionId,
      event,
      idempotencyKey,
      url: webhook.url,
    });

    await this.dispatchLimiter
      .run(async () => {
        try {
          await this.deliverOne(webhook, deliveryId, idempotencyKey, ctx);
        } finally {
          this.inFlightDeliveries.delete(inFlightKey);
        }
      })
      .catch(async error => {
        this.inFlightDeliveries.delete(inFlightKey);
        const record = recordTerminalFailure(this.failureRepository, this.logger, {
          webhookId: webhook.id,
          url: webhook.url,
          sessionId: ctx.sessionId,
          event: ctx.event,
          attempts: 0,
          idempotencyKey,
          deliveryId,
          error,
        });
        this.pendingBookkeeping.add(record);
        try {
          await record;
        } finally {
          this.pendingBookkeeping.delete(record);
        }
      });
  }

  private async deliverOne(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const preflight = await this.preflightDelivery(webhook, deliveryId, idempotencyKey, ctx);
    if (!preflight || preflight === 'cancelled') return preflight ?? 'failed';

    const { body, headers, finalPayload } = preflight;
    return this.deliverDirect(webhook, finalPayload, body, headers, deliveryId, ctx);
  }

  private async preflightDelivery(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<{ finalPayload: WebhookPayload; body: string; headers: Record<string, string> } | 'cancelled' | null> {
    const { sessionId, event, baseData } = ctx;
    try {
      const metaPayload: MetaWebhookPayload = MetaWebhookTransformer.transform(sessionId, event, baseData);
      const body = JSON.stringify(metaPayload);

      const maxPayloadBytes = this.configService.get<number>(
        'webhook.maxPayloadBytes',
        DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
      );
      const payloadBytes = Buffer.byteLength(body, 'utf8');

      if (payloadBytes > maxPayloadBytes) {
        await recordTerminalFailure(this.failureRepository, this.logger, {
          webhookId: webhook.id,
          url: webhook.url,
          sessionId,
          event,
          attempts: 0,
          idempotencyKey,
          deliveryId,
          error: `Webhook payload is ${payloadBytes} bytes, exceeding cap ${maxPayloadBytes}`,
        });
        return null;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenWA-Webhook/1.0',
        'X-OpenWA-Event': event,
        'X-OpenWA-Delivery-Id': deliveryId,
        'X-OpenWA-Idempotency-Key': idempotencyKey,
        'X-OpenWA-Session-Id': sessionId,
        'X-OpenWA-Timestamp': new Date().toISOString(),
        ...this.sanitizeCustomHeaders(webhook.headers),
      };

      if (webhook.secret) {
        headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
        headers['X-Hub-Signature-256'] = `sha256=${this.generateSignature(body, webhook.secret)}`;
      }

      const finalPayload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        sessionId,
        idempotencyKey,
        deliveryId,
        data: baseData,
      };

      return { finalPayload, body, headers };
    } catch (error) {
      await recordTerminalFailure(this.failureRepository, this.logger, {
        webhookId: webhook.id,
        url: webhook.url,
        sessionId,
        event,
        attempts: 0,
        idempotencyKey,
        deliveryId,
        error,
      });
      return null;
    }
  }

  private async deliverDirect(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    headers: Record<string, string>,
    _deliveryId: string,
    _ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    try {
      await this.deliverWebhook(webhook, finalPayload, headers, body);
      return 'delivered';
    } catch (error) {
      this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_delivery_failed',
      });
      return 'failed';
    }
  }

  private async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    headers: Record<string, string>,
    body: string,
    attempt = 1,
  ): Promise<void> {
    headers['X-OpenWA-Retry-Count'] = String(attempt - 1);

    if (webhook.secret && !headers['X-OpenWA-Signature']) {
      headers['X-OpenWA-Signature'] = this.generateSignature(body, webhook.secret);
      headers['X-Hub-Signature-256'] = `sha256=${this.generateSignature(body, webhook.secret)}`;
    }

    try {
      await postWebhookPayload(webhook.url, body, headers, this.configService.get<number>('webhook.timeout', 10000));

      try {
        await this.webhookRepository.update(webhook.id, {
          lastTriggeredAt: new Date(),
        });
      } catch (bookkeepingError) {
        this.logger.error(
          `Webhook delivered to ${webhook.id} but lastTriggeredAt update failed`,
          bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
        );
      }
    } catch (error) {
      this.logger.error(`Webhook delivery failed for ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        attempt,
        deliveryId: payload.deliveryId,
        action: 'webhook_delivery_failed',
      });

      if (attempt < webhook.retryCount) {
        const delay = this.configService.get<number>('webhook.retryDelay', 5000);
        await setTimeout(delay * attempt);
        return this.deliverWebhook(webhook, payload, headers, body, attempt + 1);
      }

      await recordTerminalFailure(this.failureRepository, this.logger, {
        webhookId: webhook.id,
        url: webhook.url,
        sessionId: payload.sessionId,
        event: payload.event,
        attempts: attempt,
        idempotencyKey: payload.idempotencyKey,
        deliveryId: payload.deliveryId,
        error,
      });

      throw error;
    }
  }

  generateSignature(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  sanitizeCustomHeaders(headers?: Record<string, string> | null): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {};
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof key === 'string' && typeof value === 'string' && !key.toLowerCase().startsWith('x-openwa-')) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async redeliver(
    webhook: Webhook,
    sessionId: string,
    event: string,
    idempotencyKey: string,
    data: Record<string, unknown>,
  ): Promise<WebhookDeliveryOutcome> {
    const deliveryId = generateDeliveryId();
    return this.deliverOne(webhook, deliveryId, idempotencyKey, { sessionId, event, baseData: data });
  }
}
