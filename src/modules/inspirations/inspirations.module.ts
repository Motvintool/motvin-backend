import { Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { InspirationsAdminController } from './inspirations-admin.controller';
import { InspirationsAdminService } from './inspirations-admin.service';
import { InspirationsController } from './inspirations.controller';
import { InspirationsService } from './inspirations.service';
import { InspirationsWatcherService } from './inspirations-watcher.service';
import { LoaderService } from './loader.service';

@Module({
  controllers: [InspirationsAdminController, InspirationsController],
  providers: [InspirationsService, InspirationsAdminService, InspirationsWatcherService, LoaderService, AdminGuard],
  // AdminGuard is shared so MCP's admin-only usage report uses the same check.
  exports: [InspirationsService, LoaderService, AdminGuard],
})
export class InspirationsModule {}
