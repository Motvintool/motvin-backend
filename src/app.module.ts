import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IconsModule } from './modules/icons/icons.module';
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
  ],
  controllers: [],
})
export class AppModule {}
