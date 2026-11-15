import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IconsModule } from './modules/icons/icons.module';
import { LogosModule } from './modules/logos/logos.module';
import { IllustrationsModule } from './modules/illustrations/illustrations.module';
import { InspirationsModule } from './modules/inspirations/inspirations.module';
import configuration from './config/configuration';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Feature modules
    IconsModule,
    LogosModule,
    IllustrationsModule,
    InspirationsModule,
  ],
  controllers: [],
})
export class AppModule {}
