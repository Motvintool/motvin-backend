import { Module } from '@nestjs/common';
import { InspirationsController } from './inspirations.controller';
import { InspirationsService } from './inspirations.service';
import { LoaderService } from './loader.service';

@Module({
  controllers: [InspirationsController],
  providers: [InspirationsService, LoaderService],
  exports: [InspirationsService],
})
export class InspirationsModule {}
