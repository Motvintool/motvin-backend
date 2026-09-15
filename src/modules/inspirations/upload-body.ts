import type { FastifyInstance } from 'fastify';

/**
 * Teaches Fastify to hand image uploads through as a raw Buffer.
 *
 * Without this the admin upload route receives nothing: Fastify's default
 * parsers only understand JSON and urlencoded bodies, and an image posted as
 * raw bytes would be rejected before it reached the controller.
 *
 * Registered from main.ts and from the integration test, so the test exercises
 * the same configuration the server runs.
 */

export const UPLOAD_CONTENT_TYPES = [
  'image/webp',
  'image/png',
  'image/jpeg',
  'image/avif',
  'image/gif',
  'image/svg+xml',
  'application/octet-stream',
];

export function maxUploadBytes(): number {
  return (parseInt(process.env.INSPIRATIONS_MAX_UPLOAD_MB, 10) || 25) * 1024 * 1024;
}

export function registerUploadBodyParser(instance: FastifyInstance): void {
  instance.addContentTypeParser(
    UPLOAD_CONTENT_TYPES,
    { parseAs: 'buffer', bodyLimit: maxUploadBytes() },
    (_request, body, done) => done(null, body),
  );
}
