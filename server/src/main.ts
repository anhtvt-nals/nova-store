import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { NextFunction, Request, Response } from 'express';

async function bootstrap() {
  // Keep an exact byte copy for signed third-party webhooks. JSON-parsing then
  // re-serializing a request would invalidate the Sumopod Svix signature.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const trustProxy = String(process.env.TRUST_PROXY || 'loopback').trim();
  if (!trustProxy || /^(true|all|\*)$/i.test(trustProxy)) {
    throw new Error('TRUST_PROXY must name explicit trusted proxy addresses or subnets; broad trust is unsafe');
  }
  // Production Nginx connects over loopback. Express will trust only that hop
  // and derive req.ip from Nginx's overwritten X-Forwarded-For value.
  app.set('trust proxy', trustProxy);
  app.setGlobalPrefix('api');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(value => value.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && (corsOrigins.includes('*') || corsOrigins.some(origin => origin.includes('localhost')))) {
    throw new Error('CORS_ORIGINS must contain explicit production origins');
  }
  app.enableCors({ origin: corsOrigins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT || 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
