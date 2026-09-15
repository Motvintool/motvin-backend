import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import compression from '@fastify/compress';
import { registerUploadBodyParser } from './modules/inspirations/upload-body';

async function bootstrap() {
  // Create NestJS app with Fastify adapter
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false, // We'll use NestJS logger
      trustProxy: true, // Behind Cloudflare
    }),
  );

  const configService = app.get(ConfigService);

  // Enable CORS. The write methods and the Authorization header are allowed
  // because the admin UI is served from a different origin than this API;
  // access itself is decided by AdminGuard, not by CORS.
  app.enableCors({
    origin: configService.get('CORS_ORIGIN') || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    maxAge: 86400,
  });

  // Screenshot uploads arrive as raw bodies on the admin API, so Fastify is
  // told to hand image bytes through untouched instead of trying to parse
  // them. The cap is enforced again in the service, which also checks that the
  // bytes really are an image.
  registerUploadBodyParser(app.getHttpAdapter().getInstance());

  // Enable gzip/brotli compression for all responses
  await app.register(compression, { encodings: ['gzip', 'deflate'] });

  // Global prefix
  app.setGlobalPrefix('api');

  // Health check endpoint (without prefix)
  app.getHttpAdapter().get('/health', (req, res) => {
    res.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    });
  });

  const port = configService.get<number>('PORT') || 3000;
  const host = configService.get<string>('HOST') || '0.0.0.0';

  await app.listen(port, host);

  console.log(`
🚀 Motiv Backend is running!
📍 URL: http://${host}:${port}
🎯 API: http://${host}:${port}/api
🏥 Health: http://${host}:${port}/health
  `);
}

bootstrap();
