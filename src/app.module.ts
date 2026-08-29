import { Module, Type, DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { SessionModule } from './modules/session/session.module';
import { MessageModule } from './modules/message/message.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { EngineModule } from './engine/engine.module';
import { LoggerModule } from './common/services/logger.module';
import { EventsModule } from './modules/events/events.module';
import { ContactModule } from './modules/contact/contact.module';
import { GroupModule } from './modules/group/group.module';
import { MediaModule } from './modules/media/media.module';
import { SqlitePermissionsBoot } from './database/sqlite-file-permissions';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),

    // Main Database (always SQLite - auth + audit)
    TypeOrmModule.forRootAsync({
      name: 'main',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const synchronize = configService.get<boolean>('database.synchronize', true);
        return {
          name: 'main',
          type: 'better-sqlite3' as const,
          database: configService.get<string>('database.database', './data/main.sqlite'),
          entities: [
            __dirname + '/modules/auth/**/*.entity{.ts,.js}',
          ],
          migrations: [__dirname + '/database/migrations-main/*{.ts,.js}'],
          synchronize,
          migrationsRun: !synchronize,
          logging: configService.get<boolean>('database.logging', false),
        };
      },
    }),

    // Data Database (always SQLite for lean gateway — sessions, webhooks, messages)
    TypeOrmModule.forRootAsync({
      name: 'data',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const synchronize = configService.get<boolean>('dataDatabase.synchronize', false);
        return {
          name: 'data',
          type: 'better-sqlite3' as const,
          database: configService.get<string>('dataDatabase.database', './data/openwa.sqlite'),
          entities: [
            __dirname + '/modules/session/**/*.entity{.ts,.js}',
            __dirname + '/modules/webhook/**/*.entity{.ts,.js}',
            __dirname + '/modules/message/**/*.entity{.ts,.js}',
            __dirname + '/engine/**/*.entity{.ts,.js}',
          ],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          synchronize,
          migrationsRun: !synchronize,
          logging: configService.get<boolean>('dataDatabase.logging', false),
        };
      },
    }),

    // Rate limiting (in-memory only — no Redis)
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: 'short',
            ttl: configService.get<number>('api.rateLimit.shortTtl', 1000),
            limit: configService.get<number>('api.rateLimit.shortLimit', 10),
          },
          {
            name: 'medium',
            ttl: configService.get<number>('api.rateLimit.mediumTtl', 60000),
            limit: configService.get<number>('api.rateLimit.mediumLimit', 100),
          },
          {
            name: 'long',
            ttl: configService.get<number>('api.rateLimit.longTtl', 3600000),
            limit: configService.get<number>('api.rateLimit.longLimit', 1000),
          },
        ],
      }),
    }),

    // Core modules (9 modules only — lean gateway)
    LoggerModule,
    EventsModule,
    AuthModule,
    EngineModule,
    SessionModule,
    MessageModule,
    WebhookModule,
    HealthModule,
    ContactModule,
    GroupModule,
    MediaModule,
  ],
  providers: [SqlitePermissionsBoot],
})
export class AppModule {}
