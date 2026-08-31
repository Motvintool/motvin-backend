import { Module } from '@nestjs/common';
import { IllustrationsController } from './illustrations.controller';
import { IllustrationsService } from './illustrations.service';
import { LoaderService } from './loader.service';
import { CacheService } from './cache.service';

@Module({
  controllers: [IllustrationsController],
  providers: [IllustrationsService, LoaderService, CacheService],
  exports: [IllustrationsService],
})
export class IllustrationsModule {}
