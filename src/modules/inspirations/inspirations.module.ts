import { Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { InspirationsAdminController } from './inspirations-admin.controller';
import { InspirationsAdminService } from './inspirations-admin.service';
import { InspirationsController } from './inspirations.controller';
import { InspirationsService } from './inspirations.service';
import { LoaderService } from './loader.service';

@Module({
  controllers: [InspirationsAdminController, InspirationsController],
  providers: [InspirationsService, InspirationsAdminService, LoaderService, AdminGuard],
  exports: [InspirationsService],
})
export class InspirationsModule {}
