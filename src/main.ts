import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createDocsSiteRouter } from './app/drivers/docs/docs-site.router';
import { AppModule } from './app/modules/app.module';
import { API_KEY_HEADER, API_KEY_SECURITY } from './app/guards/api-key.guard';

// /docs es el sitio de documentacion; Swagger va aparte para no pisarlo
const SWAGGER_PATH = 'api/docs';

function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');

  if (!existsSync(envPath)) {
    return;
  }

  const fileContent = readFileSync(envPath, 'utf-8');

  for (const line of fileContent.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function bootstrap() {
  loadEnvFile();
  const app = await NestFactory.create(AppModule);
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Order API')
    .setDescription(
      'API para consultar órdenes de marketplaces y overviews agregados.',
    )
    .setVersion('1.0.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: API_KEY_HEADER,
        in: 'header',
        description:
          'API key de los procesos (POST /orders/fravega/*). Las consultas GET no la piden',
      },
      API_KEY_SECURITY,
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup(SWAGGER_PATH, app, swaggerDocument);

  if (readBooleanEnv('DOCS_SITE_ENABLED', true)) {
    const docsPath = readOptionalEnv('DOCS_SITE_PATH') ?? '/docs';
    const username = readOptionalEnv('DOCS_SITE_USER');
    const password = readOptionalEnv('DOCS_SITE_PASSWORD');

    // Con usuario y clave el sitio los pide y publica todo; sin ellos queda
    // abierto y no publica la pagina de operacion. Lee README.md y docs/ del
    // directorio de trabajo: el repo en local, /app en la imagen.
    // No pasa por el ApiKeyGuard: es un middleware de Express, no un controller.
    app.use(
      docsPath,
      createDocsSiteRouter({
        basePath: docsPath,
        rootDirectory: process.cwd(),
        credentials:
          username !== undefined && password !== undefined
            ? { username, password }
            : undefined,
      }),
    );
  }

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = readOptionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

void bootstrap();
