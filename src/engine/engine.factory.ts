import * as fs from 'fs';
import * as path from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { createLogger } from '../common/services/logger.service';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { isSafeSessionName } from '../common/utils/path-safety';
import { ensurePrivateDir } from '../common/utils/private-dir.util';

export interface EngineCreateOptions {
  sessionId: string;
  dbSessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly baileysMessageStore: BaileysMessageStoreService,
    private readonly lidMappingStore: LidMappingStoreService,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Initialized engine factory with engine: ${this.engineType}`);
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    if (!isSafeSessionName(options.sessionId)) {
      throw new Error(`Refusing to create an engine for an unsafe session name: ${JSON.stringify(options.sessionId)}`);
    }

    ensurePrivateDir(this.wwjsAuthDir(options.sessionId));
    ensurePrivateDir(this.baileysAuthDir(options.sessionId));

    if (this.engineType === 'baileys') {
      return new BaileysAdapter({
        sessionId: options.sessionId,
        dbSessionId: options.dbSessionId,
        authDir: this.configService.get<string>('engine.baileys.authDir') ?? './data/baileys',
        messageStore: this.baileysMessageStore,
        lidMappingStore: this.lidMappingStore,
      });
    }

    return new WhatsAppWebJsAdapter({
      sessionId: options.sessionId,
      sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
      puppeteer: {
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        args: this.configService.get<string[]>('engine.puppeteer.args') ?? ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: this.configService.get<string>('engine.puppeteer.executablePath'),
      },
      proxy: options.proxyUrl
        ? {
            url: options.proxyUrl,
            type: options.proxyType ?? 'http',
          }
        : undefined,
      lidMappingStore: this.lidMappingStore,
    });
  }

  async purgeSessionData(sessionName: string): Promise<void> {
    if (!isSafeSessionName(sessionName)) {
      this.logger.warn('Refusing to purge session data for an unsafe session name', {
        action: 'engine_purge_unsafe',
        sessionName: JSON.stringify(sessionName),
      });
      return;
    }
    const dirs: Array<{ engine: string; dir: string }> = [
      { engine: 'whatsapp-web.js', dir: this.wwjsAuthDir(sessionName) },
      { engine: 'baileys', dir: this.baileysAuthDir(sessionName) },
    ];
    for (const { engine, dir } of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        this.logger.log('Purged session auth directory', { action: 'engine_purge', engine, sessionName, dir });
      } catch (error) {
        this.logger.warn('Failed to purge session auth directory', {
          action: 'engine_purge_failed',
          engine,
          sessionName,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private wwjsAuthDir(sessionName: string): string {
    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions';
    return path.join(path.resolve(sessionDataPath), `session-${sessionName}`);
  }

  private baileysAuthDir(sessionName: string): string {
    const authDir = this.configService.get<string>('engine.baileys.authDir') ?? './data/baileys';
    return path.join(authDir, sessionName);
  }

  getAvailableEngines(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    features: string[];
  }> {
    return [
      {
        id: 'whatsapp-web.js',
        name: 'WhatsApp Web.js Engine',
        enabled: this.engineType === 'whatsapp-web.js',
        features: ['text', 'media', 'groups', 'status', 'reactions', 'edits'],
      },
      {
        id: 'baileys',
        name: 'Baileys Engine',
        enabled: this.engineType === 'baileys',
        features: ['text', 'media', 'groups', 'status', 'reactions', 'edits'],
      },
    ];
  }

  getCurrentEngine(): string {
    return this.engineType;
  }
}
