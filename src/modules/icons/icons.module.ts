import { Module } from '@nestjs/common';
import { IconsController } from './icons.controller';
import { IconsService } from './icons.service';
import { LoaderService } from './loader.service';
import { CacheService } from './cache.service';

@Module({
  controllers: [IconsController],
  providers: [IconsService, LoaderService, CacheService],
  exports: [IconsService],
})
export class IconsModule {}
