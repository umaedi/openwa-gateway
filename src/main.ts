import './config/load-env';
// Engine reload trigger: baileys + ssrf
import { NestFactory } from '@nestjs/core';
import { INestApplication, ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ShutdownService } from './common/services/shutdown.service';
import { LoggerService, LogLevel, createLogger } from './common/services/logger.service';
import { createSwaggerConfig, dropUnexpressibleOperations, exemptPublicOperations } from './config/swagger.config';
import { registerUncaughtExceptionMonitor, registerUnhandledRejectionHandler } from './config/process-error-monitor';
import { runBootstrapOrExit } from './config/bootstrap-fatal';
import { resolveStorageRoot } from './config/storage-root';
import { applyHttpTimeouts, HttpTimeoutConfig, HttpTimeoutSink } from './config/http-timeouts';
import { applyGlobalValidation } from './config/app-validation';
import { configureApp } from './configure-app';
import {
  isSwaggerEnabled,
  isApiKeyPepperMissingInProduction,
  isNodeEnvUnset,
} from './config/bootstrap-security';

let appInstance: INestApplication | undefined;

async function bootstrap() {
  const requestedLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (requestedLevel && (Object.values(LogLevel) as string[]).includes(requestedLevel)) {
    LoggerService.setLogLevel(requestedLevel as LogLevel);
  }

  const bootstrapLogger = createLogger('Bootstrap');
  registerUnhandledRejectionHandler(bootstrapLogger);
  registerUncaughtExceptionMonitor(bootstrapLogger);

  if (isNodeEnvUnset(process.env.NODE_ENV)) {
    bootstrapLogger.warn(
      'NODE_ENV is not set: running with development defaults — the default-secret guard is skipped, ' +
        'Swagger UI is enabled, and detailed validation errors are returned. Set NODE_ENV=production for production.',
    );
  }

  if (isApiKeyPepperMissingInProduction(process.env.API_KEY_PEPPER, process.env.NODE_ENV)) {
    bootstrapLogger.warn(
      'API_KEY_PEPPER is not set in production. SHA-256 API key hashes in main.sqlite will not be peppered. ' +
        'Set API_KEY_PEPPER to a strong secret to enable HMAC-SHA256 key hashing.',
    );
  }

  resolveStorageRoot({ configured: process.env.DATA_DIR, logger: bootstrapLogger });

  const app = await NestFactory.create(AppModule, {
    logger: new LoggerService(),
    rawBody: true,
  });
  appInstance = app;

  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);
  app.get(ShutdownService).setShutdownCallback(async () => {
    await app.close();
  });

  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready'],
  });

  configureApp(app);
  applyGlobalValidation(app);

  const swaggerEnabled = isSwaggerEnabled(process.env.ENABLE_SWAGGER, process.env.NODE_ENV);
  if (swaggerEnabled) {
    const config = createSwaggerConfig();
    const document = SwaggerModule.createDocument(app, config);
    dropUnexpressibleOperations(document);
    exemptPublicOperations(document);
    SwaggerModule.setup('api/docs', app, document);
  }

  const appliedHttpTimeouts = applyHttpTimeouts(
    app.getHttpServer() as HttpTimeoutSink,
    app.get(ConfigService).get<HttpTimeoutConfig>('http')!,
  );
  bootstrapLogger.log(
    `HTTP server timeouts applied: requestTimeout=${appliedHttpTimeouts.requestTimeoutMs}ms ` +
      `headersTimeout=${appliedHttpTimeouts.headersTimeoutMs}ms keepAliveTimeout=${appliedHttpTimeouts.keepAliveTimeoutMs}ms`,
  );

  const port = process.env.PORT || 2785;
  await app.listen(port);

  const publicUrl = process.env.BASE_URL || `http://localhost:${port}`;
  console.log(`🚀 OpenWA is running on: ${publicUrl}`);
  if (swaggerEnabled) {
    console.log(`📚 Swagger docs: ${publicUrl}/api/docs`);
  }
}

void runBootstrapOrExit(bootstrap, {
  logger: createLogger('Bootstrap'),
  closeApp: () => (appInstance ? appInstance.close() : Promise.resolve()),
});
