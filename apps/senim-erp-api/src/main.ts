import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable loose CORS for development and demo integration across different local ports
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Accept,Authorization',
    credentials: true,
  });

  const port = process.env.PORT || 3004;
  await app.listen(port, '0.0.0.0');
  console.log(`SenimERP API running on http://localhost:${port}`);
}

bootstrap().catch(err => {
  console.error('Fatal error bootstrapping SenimERP API:', err);
});
