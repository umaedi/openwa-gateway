import { S3StorageService } from './s3-storage.service';
import { MediaStorageService } from './media-storage.service';

describe('S3StorageService & MediaStorageService', () => {
  it('should initialize S3StorageService with custom or default R2 config', () => {
    const configMock = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        if (key === 'storage.s3.endpoint') return 'https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com';
        if (key === 'storage.s3.bucket') return 'nawasena-chat';
        if (key === 'storage.s3.accessKeyId') return 'test-access-key';
        if (key === 'storage.s3.secretAccessKey') return 'test-secret-key';
        return defaultVal;
      }),
    };

    const s3Service = new S3StorageService(configMock as never);
    expect(s3Service.isConfigured()).toBe(true);
  });

  it('MediaStorageService falls back to local storage when S3 is unconfigured', async () => {
    const s3ServiceUnconfigured = {
      isConfigured: () => false,
      uploadMedia: jest.fn(),
    };

    const configMock = {
      get: jest.fn((key: string) => {
        if (key === 'storage.type') return 's3';
        if (key === 'storage.localPath') return './data/media-test';
        return undefined;
      }),
    };

    const mediaStorage = new MediaStorageService(s3ServiceUnconfigured as never, configMock as never);
    const result = await mediaStorage.saveMedia({
      sessionId: 'sess-1',
      data: Buffer.from('hello-world'),
      mimetype: 'text/plain',
      filename: 'sample.txt',
    });

    expect(result.key).toContain('sess-1/');
    expect(result.url).toContain('/api/media/sess-1/');
    expect(result.sizeBytes).toBe(11);
  });

  it('uploads media successfully to S3/R2 and returns valid URL', async () => {
    const configMock = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        if (key === 'storage.s3.endpoint') return 'https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com';
        if (key === 'storage.s3.bucket') return 'nawasena-chat';
        if (key === 'storage.s3.accessKeyId') return 'test-access-key';
        if (key === 'storage.s3.secretAccessKey') return 'test-secret-key';
        return defaultVal;
      }),
    };

    const s3Service = new S3StorageService(configMock as never);
    // Mock the internal S3Client send method
    (s3Service as unknown as { s3Client: { send: jest.Mock } }).s3Client = {
      send: jest.fn().mockResolvedValue({}),
    };

    const result = await s3Service.uploadMedia({
      sessionId: 'tenant-session-1',
      data: Buffer.from('image-binary-data'),
      mimetype: 'image/png',
      filename: 'invoice.png',
    });

    expect(result.key).toMatch(/^media\/tenant-session-1\/\d{4}\/\d{2}\/\d+-.*-invoice\.png$/);
    expect(result.url).toContain('https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com/nawasena-chat/media/tenant-session-1/');
    expect(result.mimetype).toBe('image/png');
    expect(result.sizeBytes).toBe(17);
  });
});
