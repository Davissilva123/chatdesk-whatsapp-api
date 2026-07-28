import express from 'express';
import cors from 'cors';
import { apiKeyAuth } from './src/middleware/auth.js';
import sessionRoutes from './src/routes/session.js';
import qrcodeRoutes from './src/routes/qrcode.js';
import statusRoutes from './src/routes/status.js';
import sendRoutes from './src/routes/send.js';
import webhookRoutes from './src/routes/webhook.js';
import healthRoutes from './src/routes/health.js';

// Setup Mock Env
process.env.API_KEY = 'test-key-123';
process.env.PORT = '3005';

const app = express();
app.use(cors());
app.use(express.json());

// Public health
app.use('/api/health', healthRoutes);

// Auth rules
app.use('/api', apiKeyAuth);
app.use('/api', sessionRoutes);
app.use('/api', qrcodeRoutes);
app.use('/api', statusRoutes);
app.use('/api', sendRoutes);
app.use('/api', webhookRoutes);

async function runTests() {
  const server = app.listen(3005, async () => {
    console.log('\n--- Iniciando Verificações do Servidor ---');
    let passed = 0;
    let failed = 0;

    const assert = (condition, message) => {
      if (condition) {
        console.log(`[PASS] ${message}`);
        passed++;
      } else {
        console.error(`[FAIL] ${message}`);
        failed++;
      }
    };

    try {
      // Test 1: Health Check (No Auth)
      const resHealth = await fetch('http://localhost:3005/api/health');
      const dataHealth = await resHealth.json();
      assert(resHealth.status === 200 && dataHealth.status === 'ok', 'GET /api/health retorna status 200 e status "ok"');

      // Test 2: Status check blocks request without API Key
      const resStatusNoAuth = await fetch('http://localhost:3005/api/status/session-123');
      assert(resStatusNoAuth.status === 401, 'GET /api/status/:id sem cabeçalho x-api-key retorna 401');

      // Test 3: Status check blocks request with invalid API Key
      const resStatusBadAuth = await fetch('http://localhost:3005/api/status/session-123', {
        headers: { 'x-api-key': 'chave-errada' }
      });
      assert(resStatusBadAuth.status === 401, 'GET /api/status/:id com cabeçalho x-api-key inválido retorna 401');

      // Test 4: Status check allows request with valid API Key and returns not_found
      const resStatusAuth = await fetch('http://localhost:3005/api/status/session-123', {
        headers: { 'x-api-key': 'test-key-123' }
      });
      const dataStatus = await resStatusAuth.json();
      assert(resStatusAuth.status === 200 && dataStatus.status === 'not_found', 'GET /api/status/:id com cabeçalho x-api-key válido retorna 200 e status "not_found"');

      // Test 5: QR Code returns not_found for non-existent session
      const resQr = await fetch('http://localhost:3005/api/qrcode/session-123', {
        headers: { 'x-api-key': 'test-key-123' }
      });
      const dataQr = await resQr.json();
      assert(resQr.status === 200 && dataQr.status === 'not_found', 'GET /api/qrcode/:id para sessão inexistente retorna status "not_found"');

    } catch (err) {
      console.error('Erro de execução dos testes:', err);
      failed++;
    } finally {
      console.log(`\nResultados: ${passed} passados, ${failed} falhados.`);
      server.close(() => {
        console.log('Servidor de testes encerrado.');
        process.exit(failed > 0 ? 1 : 0);
      });
    }
  });
}

runTests();
