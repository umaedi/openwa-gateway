import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaConversionService } from './media-conversion.service';
import { S3StorageService } from './s3-storage.service';
import { MediaStorageService } from './media-storage.service';

@Module({
  controllers: [MediaController],
  providers: [MediaConversionService, S3StorageService, MediaStorageService],
  exports: [MediaConversionService, S3StorageService, MediaStorageService],
})
export class MediaModule {}
