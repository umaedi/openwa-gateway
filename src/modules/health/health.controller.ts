import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthCheckResponseDto, LivenessResponseDto, ReadinessResponseDto } from './dto/health-response.dto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuthService } from '../auth/auth.service';
import { resolveClientIp } from '../../common/utils/ip';

interface DependencyStatus {
  status: 'up' | 'down';
}

interface HealthCheckResult {
  status: 'ok' | 'error';
  details: Record<string, DependencyStatus>;
}

const READINESS_PROBE_TIMEOUT_MS = 3000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../../../package.json') as { version: string };

@ApiTags('health')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    @InjectDataSource('main') private readonly mainDataSource: DataSource,
    @InjectDataSource('data') private readonly dataDataSource: DataSource,
    private readonly shutdownService: ShutdownService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Basic health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy', type: HealthCheckResponseDto })
  async check(@Req() req: Request): Promise<{ status: string; timestamp: string; version?: string }> {
    const body: { status: string; timestamp: string; version?: string } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
    if (await this.hasValidApiKey(req)) {
      body.version = APP_VERSION;
    }
    return body;
  }

  private async hasValidApiKey(req: Request): Promise<boolean> {
    const xApiKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];
    const rawKey =
      (typeof xApiKey === 'string' && xApiKey) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
    if (!rawKey) return false;
    try {
      const clientIp = resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
      await this.authService.validateApiKey(rawKey, clientIp);
      return true;
    } catch {
      return false;
    }
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe for Kubernetes' })
  @ApiResponse({ status: 200, description: 'Application is alive', type: LivenessResponseDto })
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — verifies the auth/audit + data databases respond' })
  @ApiResponse({ status: 200, description: 'Application is ready to accept traffic', type: ReadinessResponseDto })
  @ApiResponse({ status: 503, description: 'A required dependency is down' })
  async readiness(): Promise<HealthCheckResult> {
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({ status: 'error', details: { shutdown: { status: 'draining' } } });
    }

    const [main, data] = await Promise.all([
      this.probeDatabase(this.mainDataSource),
      this.probeDatabase(this.dataDataSource),
    ]);

    const details: Record<string, DependencyStatus> = {
      mainDatabase: { status: main },
      dataDatabase: { status: data },
    };

    if (main === 'down' || data === 'down') {
      throw new ServiceUnavailableException({ status: 'error', details });
    }

    return { status: 'ok', details };
  }

  private async probeDatabase(dataSource: DataSource): Promise<'up' | 'down'> {
    try {
      await this.withTimeout(dataSource.query('SELECT 1'), READINESS_PROBE_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness probe timed out')), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
