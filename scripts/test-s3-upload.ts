import { S3StorageService } from '../src/modules/media/s3-storage.service';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log('Testing S3/R2 upload...');
  console.log('S3_ENDPOINT:', process.env.S3_ENDPOINT || 'https://6256144c9e85c0e4c0fec6b378b2ac1a.r2.cloudflarestorage.com');
  console.log('S3_BUCKET:', process.env.S3_BUCKET || 'nawasena-chat');
  console.log('S3_ACCESS_KEY_ID provided:', Boolean(process.env.S3_ACCESS_KEY_ID));
  console.log('S3_SECRET_ACCESS_KEY provided:', Boolean(process.env.S3_SECRET_ACCESS_KEY));

  const s3Service = new S3StorageService();

  if (!s3Service.isConfigured()) {
    console.log('⚠️ S3StorageService is not configured (missing S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY).');
    console.log('Silakan masukkan S3_ACCESS_KEY_ID dan S3_SECRET_ACCESS_KEY di file .env untuk upload langsung ke R2.');
    return;
  }

  try {
    const sampleBuffer = Buffer.from('Ini adalah file testing upload media ke Cloudflare R2 Nawasena Chat ' + new Date().toISOString(), 'utf-8');
    const result = await s3Service.uploadMedia({
      sessionId: 'test-session-123',
      data: sampleBuffer,
      mimetype: 'text/plain',
      filename: 'test-upload.txt',
    });

    console.log('✅ Upload berhasil!');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ Upload gagal:', error);
  }
}

run();
