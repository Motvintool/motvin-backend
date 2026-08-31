import { Module } from '@nestjs/common';
import { LogosController } from './logos.controller';
import { LogosService } from './logos.service';
import { LoaderService } from './loader.service';
import { CacheService } from './cache.service';

@Module({
  controllers: [LogosController],
  providers: [LogosService, LoaderService, CacheService],
  exports: [LogosService],
})
export class LogosModule {}
