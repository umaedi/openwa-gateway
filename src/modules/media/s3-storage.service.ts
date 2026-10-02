import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../../common/services/logger.service';
import * as crypto from 'crypto';

export interface UploadMediaResult {
  key: string;
  url: string;
  sizeBytes: number;
  mimetype: string;
  filename?: string;
}

export interface UploadMediaOptions {
  data: Buffer | string; // Buffer or Base64 string
  mimetype: string;
  filename?: string;
  sessionId: string;
}

@Injectable()
export class S3StorageService {
  private readonly logger = createLogger('S3StorageService');
  private readonly s3Client?: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly publicUrlPrefix?: string;
  private readonly enabled: boolean;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.endpoint =
      this.configService?.get<string>(
        'storage.s3.endpoint',
        'https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com',
      ) || 'https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com';
    this.bucket = this.configService?.get<string>('storage.s3.bucket', 'nawasena-chat') || 'nawasena-chat';
    const region = this.configService?.get<string>('storage.s3.region', 'auto') || 'auto';
    const accessKeyId = this.configService?.get<string>('storage.s3.accessKeyId') || process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey =
      this.configService?.get<string>('storage.s3.secretAccessKey') || process.env.S3_SECRET_ACCESS_KEY;
    this.publicUrlPrefix =
      this.configService?.get<string>('storage.s3.publicUrlPrefix') || process.env.S3_PUBLIC_URL_PREFIX;

    if (accessKeyId && secretAccessKey) {
      this.s3Client = new S3Client({
        region,
        endpoint: this.endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.enabled = true;
      this.logger.log(`Initialized S3/R2 storage for bucket "${this.bucket}" on endpoint "${this.endpoint}"`);
    } else {
      this.enabled = false;
      this.logger.warn('S3/R2 credentials not provided (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY unset)');
    }
  }

  isConfigured(): boolean {
    return this.enabled && !!this.s3Client;
  }

  /**
   * Generates a clean extension based on mimetype or filename
   */
  private getExtension(mimetype: string, filename?: string): string {
    if (filename && filename.includes('.')) {
      const ext = filename.split('.').pop();
      if (ext && ext.length <= 5) return ext.toLowerCase();
    }
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'text/plain': 'txt',
    };
    return mimeMap[mimetype] || 'bin';
  }

  /**
   * Uploads media buffer or base64 to Cloudflare R2 / S3
   */
  async uploadMedia(options: UploadMediaOptions): Promise<UploadMediaResult> {
    if (!this.s3Client) {
      throw new Error('S3/R2 client is not configured. Missing credentials.');
    }

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

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const randomHex = crypto.randomBytes(8).toString('hex');
    const ext = this.getExtension(mimetype, filename);
    let sanitizedName = filename ? filename.replace(/[^a-zA-Z0-9.-]/g, '_') : 'file';
    if (sanitizedName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      sanitizedName = sanitizedName.slice(0, -(ext.length + 1));
    }
    const key = `media/${sessionId}/${year}/${month}/${Date.now()}-${randomHex}-${sanitizedName}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    });

    await this.s3Client.send(command);

    const url = this.publicUrlPrefix
      ? `${this.publicUrlPrefix.replace(/\/$/, '')}/${key}`
      : `${this.endpoint.replace(/\/$/, '')}/${this.bucket}/${key}`;

    this.logger.debug(`Uploaded media to R2/S3: ${key} (${buffer.length} bytes)`, {
      key,
      url,
      sizeBytes: buffer.length,
      mimetype,
    });

    return {
      key,
      url,
      sizeBytes: buffer.length,
      mimetype,
      filename,
    };
  }
}
