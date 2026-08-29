import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, QueryDeepPartialEntity, Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface PendingMessageReaperOptions {
  intervalMs: number;
  graceMs: number;
  batchSize: number;
}

export function resolvePendingMessageReaperOptions(env: NodeJS.ProcessEnv = process.env): PendingMessageReaperOptions {
  const batch = Number(env.MESSAGE_REAPER_BATCH_SIZE);
  return {
    intervalMs: resolveNonNegativeIntEnv(env.MESSAGE_REAPER_INTERVAL_MS, 10 * 60_000),
    graceMs: resolveNonNegativeIntEnv(env.MESSAGE_REAPER_GRACE_MS, 60 * 60_000),
    batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
  };
}

export interface PendingMessageReaperStats {
  scanned: number;
  reaped: number;
  failed: number;
}

@Injectable()
export class PendingMessageReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('PendingMessageReaperService');
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
  ) {}

  onModuleInit(): void {
    const opts = resolvePendingMessageReaperOptions();
    if (opts.intervalMs <= 0) {
      this.logger.log('Pending message reaper disabled (MESSAGE_REAPER_INTERVAL_MS <= 0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Pending message reaper sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(opts: PendingMessageReaperOptions, now: Date = new Date()): Promise<PendingMessageReaperStats> {
    const stats: PendingMessageReaperStats = { scanned: 0, reaped: 0, failed: 0 };
    if (this.sweeping) return stats;
    this.sweeping = true;
    try {
      const cutoff = new Date(now.getTime() - opts.graceMs);
      const rows = await this.messages.find({
        where: {
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.PENDING,
          createdAt: LessThan(cutoff),
        },
        order: { createdAt: 'ASC' },
        take: opts.batchSize,
      });
      for (const row of rows) {
        stats.scanned++;
        try {
          if (await this.reapRow(row, now)) {
            stats.reaped++;
          }
        } catch (err) {
          this.logger.error(
            'Reaping a stuck pending message failed',
            err instanceof Error ? err.message : String(err),
            { messageId: row.id, sessionId: row.sessionId, action: 'pending_message_reap_failed' },
          );
          stats.failed++;
        }
      }
      if (stats.reaped > 0) {
        this.logger.log(`Reaped ${stats.reaped} outbound message(s) stuck PENDING past the grace window`, {
          action: 'pending_messages_reaped',
        });
      }
      return stats;
    } finally {
      this.sweeping = false;
    }
  }

  private async reapRow(row: Message, now: Date): Promise<boolean> {
    const media = (row.metadata as { media?: { data?: unknown } } | undefined)?.media;
    if (media) {
      delete media.data;
    }
    row.metadata = { ...(row.metadata ?? {}), reapedAt: now.toISOString() };
    row.status = MessageStatus.FAILED;

    const reaped = await this.messages.update({ id: row.id, status: MessageStatus.PENDING }, {
      status: row.status,
      metadata: row.metadata,
    } as QueryDeepPartialEntity<Message>);
    return Boolean(reaped.affected);
  }
}
