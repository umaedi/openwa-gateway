import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3StorageService, UploadMediaOptions, UploadMediaResult } from './s3-storage.service';
import { createLogger } from '../../common/services/logger.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

@Injectable()
export class MediaStorageService {
  private readonly logger = createLogger('MediaStorageService');
  private readonly storageType: 'local' | 's3';
  private readonly localPath: string;

  constructor(
    private readonly s3Storage: S3StorageService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.storageType = (this.configService?.get<string>('storage.type') as 'local' | 's3') || 's3';
    this.localPath = this.configService?.get<string>('storage.localPath') || './data/media';
  }

  async saveMedia(options: UploadMediaOptions): Promise<UploadMediaResult> {
    if (this.storageType === 's3' && this.s3Storage.isConfigured()) {
      try {
        return await this.s3Storage.uploadMedia(options);
      } catch (err) {
        this.logger.error('Failed to upload media to S3/R2, falling back to local filesystem', String(err));
        return this.saveToLocal(options);
      }
    }
    return this.saveToLocal(options);
  }

  private async saveToLocal(options: UploadMediaOptions): Promise<UploadMediaResult> {
    const { data, mimetype, filename, sessionId } = options;

    let buffer: Buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data === 'string') {
      const base64Data = data.includes(';base64,') ? data.split(';base64,').pop() || data : data;
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      throw new Error('Invalid media data format: expected Buffer or base64 string');
    }

    const sessionDir = path.join(this.localPath, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const randomHex = crypto.randomBytes(6).toString('hex');
    const ext = filename?.includes('.') ? filename.split('.').pop() || 'bin' : 'bin';
    const localFilename = `${Date.now()}-${randomHex}.${ext}`;
    const filePath = path.join(sessionDir, localFilename);

    await fs.writeFile(filePath, buffer);

    const relativePath = `${sessionId}/${localFilename}`;
    const url = `/api/media/${relativePath}`;

    this.logger.debug(`Saved media locally: ${filePath} (${buffer.length} bytes)`);

    return {
      key: relativePath,
      url,
      sizeBytes: buffer.length,
      mimetype,
      filename,
    };
  }
}
