import express from 'express';
import cors from 'cors';
import { apiKeyAuth } from './middleware/auth.js';
import { requestLogger } from './middleware/logger.js';
import sessionRoutes from './routes/session.js';
import qrcodeRoutes from './routes/qrcode.js';
import statusRoutes from './routes/status.js';
import sendRoutes from './routes/send.js';
import webhookRoutes from './routes/webhook.js';
import healthRoutes from './routes/health.js';
import presenceRoutes from './routes/presence.js';
import campaignRoutes from './routes/campaign.js';
import aiRoutes from './routes/ai.js';
import tenantRoutes from './routes/tenant.js';
import billingRoutes from './routes/billing.js';
import { startSession } from './baileys/session-manager.js';
import { supabase } from './services/supabase.js';
import { startWebhookListener } from './services/webhook-dispatcher.js';

const app = express();
const PORT = process.env.PORT || 3005;


// Middlewares globais
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

// Rotas públicas (sem auth)
app.use('/api/health', healthRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/billing', billingRoutes); // MercadoPago Webhooks & Checkout

// Todas as outras rotas requerem API Key
app.use('/api', apiKeyAuth);
app.use('/api', sessionRoutes);
app.use('/api', qrcodeRoutes);
app.use('/api', statusRoutes);
app.use('/api', sendRoutes);
app.use('/api', webhookRoutes);
app.use('/api', presenceRoutes);
app.use('/api', campaignRoutes);
app.use('/api', aiRoutes);

// Inicialização: reconectar sessões que estavam ativas
async function reconnectActiveSessions() {
  console.log('Verificando sessões ativas no Supabase...');
  try {
    const { data: connectedInboxes, error } = await supabase
      .from('inboxes')
      .select('id, wa_session_id')
      .eq('is_connected', true)
      .not('wa_session_id', 'is', null);

    if (error) {
      console.warn('Erro ao consultar inboxes no Supabase (pode ser que as tabelas não estejam criadas ainda):', error.message);
      return;
    }

    if (connectedInboxes?.length) {
      console.log(`Reconectando ${connectedInboxes.length} sessão(ões)...`);
      for (const inbox of connectedInboxes) {
        try {
          await startSession(inbox.wa_session_id, inbox.id);
        } catch (sessionErr) {
          console.error(`Erro ao restaurar sessão ${inbox.wa_session_id}:`, sessionErr);
        }
      }
    } else {
      console.log('Nenhuma sessão WhatsApp ativa encontrada para reconectar.');
    }
  } catch (err) {
    console.error('Erro na rotina de reconexão de sessões:', err);
  }
}

app.listen(PORT, async () => {
  console.log(`ChatDesk WhatsApp API rodando na porta ${PORT}`);
  await reconnectActiveSessions();
  startWebhookListener();
});
