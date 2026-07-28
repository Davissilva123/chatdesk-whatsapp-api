import express from 'express';
import { getSession } from '../baileys/session-manager.js';
import { supabase, findOrCreateContact, findOrCreateConversation, insertMessage } from '../services/supabase.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

const router = express.Router();

// Reutiliza o mesmo logDebug do message-handler.js
function logDebug(message) {
  try {
    const logPath = path.join(process.cwd(), 'debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch (e) {
    console.error('Failed to write debug log:', e);
  }
}

// Substitui variáveis {{nome}}, {{telefone}}, etc. pelo dado real do contato
function substituteVariables(text, contact) {
  if (!text) return text;
  return text
    .replace(/\{\{nome\}\}/gi, contact?.name || contact?.phone || 'Cliente')
    .replace(/\{\{telefone\}\}/gi, contact?.phone || '')
    .replace(/\{\{empresa\}\}/gi, contact?.company || '')
    .replace(/\{\{email\}\}/gi, contact?.email || '');
}

router.post('/campaign/send', async (req, res) => {
  const { sessionId, inboxId, name, recipients, message, scheduledAt, mediaUrl, mediaType } = req.body;

  if (!sessionId || !inboxId || !recipients || !Array.isArray(recipients) || !message) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetros sessionId, inboxId, recipients (Array) e message são obrigatórios.',
      code: 'BAD_REQUEST'
    });
  }

  const session = getSession(sessionId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({
      success: false,
      error: 'Sessão do WhatsApp não conectada.',
      code: 'SESSION_DISCONNECTED'
    });
  }

  try {
    // Buscar company_id da inbox
    const { data: inbox } = await supabase.from('inboxes').select('company_id').eq('id', inboxId).single();
    const companyId = inbox?.company_id || null;

    // 1. Criar registro da campanha no banco de dados
    const campaignName = name || `Campanha ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`;
    const { data: campaign, error: dbError } = await supabase
      .from('campaigns')
      .insert({
        company_id: companyId,
        name: campaignName,
        message: message,
        total_recipients: recipients.length,
        sent_count: 0,
        failed_count: 0,
        status: scheduledAt ? 'scheduled' : 'running',
        scheduled_at: scheduledAt || null,
        media_url: mediaUrl || null,
        media_type: mediaType || null,
        recipients: recipients,
        inbox_id: inboxId
      })
      .select()
      .single();

    if (dbError) {
      logDebug(`[Campanha] Tabela campaigns não encontrada ou erro ao criar registro: ${dbError.message}`);
    }

    const campaignId = campaign?.id || null;

    // 2. Se for campanha agendada, responder e sair (cron vai disparar)
    if (scheduledAt) {
      res.json({
        success: true,
        message: 'Campanha agendada com sucesso.',
        campaignId: campaign?.id || null
      });
      return;
    }

    // 3. Responder de imediato à requisição para não bloquear o frontend
    res.json({
      success: true,
      message: 'Disparo de campanha iniciado em segundo plano.',
      campaignId: campaign?.id || null
    });

    // 4. Loop de envio em background
    await dispatchCampaign(sock, recipients, message, inboxId, sessionId, campaign?.id, mediaUrl, mediaType);
  } catch (error) {
    logDebug(`[Campanha] ❌ Erro interno ao processar campanha: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erro interno ao iniciar campanha',
        code: 'CAMPAIGN_FAILED'
      });
    }
  }
});

/**
 * Core dispatch function: envia a campanha para todos os destinatários.
 * Suporta variáveis e mídia.
 */
async function dispatchCampaign(sock, recipients, message, inboxId, sessionId, campaignId, mediaUrl, mediaType) {
  let sentCount = 0;
  let failedCount = 0;

  for (const phone of recipients) {
    try {
      const cleanPhone = phone.replace(/\D/g, '');
      if (!cleanPhone || cleanPhone.length < 8) {
        logDebug(`[Campanha] Número inválido ignorado: "${phone}"`);
        failedCount++;
        continue;
      }

      const jid = `${cleanPhone}@s.whatsapp.net`;

      // Validar número no WhatsApp
      let verifiedJid = jid;
      try {
        const [waResult] = await sock.onWhatsApp(jid);
        if (!waResult?.exists) {
          logDebug(`[Campanha] ❌ Número ${phone} NÃO registrado no WhatsApp. Pulando.`);
          failedCount++;
          if (campaignId) await supabase.from('campaigns').update({ sent_count: sentCount, failed_count: failedCount }).eq('id', campaignId);
          continue;
        }
        verifiedJid = waResult.jid || jid;
      } catch (validateErr) {
        logDebug(`[Campanha] ⚠️ Falha na validação para ${phone}: ${validateErr.message}. Tentando enviar mesmo assim.`);
      }

      // Buscar dados do contato para substituir variáveis
      let contactData = { phone: cleanPhone, name: cleanPhone };
      try {
        const { data: ct } = await supabase.from('contacts').select('name, phone, email, company').eq('phone', cleanPhone).maybeSingle();
        if (ct) contactData = ct;
      } catch (_) {}

      // Substituir variáveis na mensagem
      const personalizedMessage = substituteVariables(message, contactData);

      // Pré-registrar no DB
      const waMessageId = '3EB0' + crypto.randomBytes(8).toString('hex').toUpperCase();
      let conversationId = null;
      try {
        const contact = await findOrCreateContact({ phone: cleanPhone, name: contactData.name || cleanPhone });
        const { conversation } = await findOrCreateConversation({ contactId: contact.id, inboxId, sessionId, isOutgoing: true });
        conversationId = conversation.id;
        await insertMessage({
          conversationId: conversation.id,
          senderType: 'agent',
          content: personalizedMessage,
          messageType: mediaType || 'text',
          mediaUrl: mediaUrl || null,
          waMessageId
        });
        await supabase.from('conversations').update({
          last_message_at: new Date().toISOString(),
          last_message_preview: personalizedMessage.substring(0, 120)
        }).eq('id', conversation.id);
      } catch (dbErr) {
        logDebug(`[Campanha] ⚠️ Erro ao pré-registrar no DB: ${dbErr.message}.`);
      }

      // Enviar via WhatsApp
      logDebug(`[Campanha] 📤 Enviando para ${verifiedJid}...`);
      if (mediaUrl && mediaType === 'image') {
        await sock.sendMessage(verifiedJid, { image: { url: mediaUrl }, caption: personalizedMessage }, { messageId: waMessageId });
      } else if (mediaUrl && mediaType === 'document') {
        await sock.sendMessage(verifiedJid, { document: { url: mediaUrl }, caption: personalizedMessage, mimetype: 'application/pdf' }, { messageId: waMessageId });
      } else {
        await sock.sendMessage(verifiedJid, { text: personalizedMessage }, { messageId: waMessageId });
      }
      logDebug(`[Campanha] ✅ Mensagem enviada para ${phone}.`);
      sentCount++;

    } catch (sendErr) {
      logDebug(`[Campanha] ❌ Erro ao enviar para ${phone}: ${sendErr.message}`);
      failedCount++;
    }

    if (campaignId) {
      await supabase.from('campaigns').update({ sent_count: sentCount, failed_count: failedCount }).eq('id', campaignId);
    }

    const dynamicDelay = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
    await new Promise(resolve => setTimeout(resolve, dynamicDelay));
  }

  const finalStatus = failedCount === recipients.length ? 'failed' : 'completed';
  if (campaignId) {
    await supabase.from('campaigns').update({ status: finalStatus }).eq('id', campaignId);
  }
  logDebug(`[Campanha] 🏁 Finalizado: ${sentCount} enviados, ${failedCount} falhas.`);
}

// 🕒 Cron job: verifica campanhas agendadas a cada minuto
cron.schedule('* * * * *', async () => {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    const { data: scheduled } = await supabase
      .from('campaigns')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_at', now);

    if (!scheduled || scheduled.length === 0) return;

    for (const camp of scheduled) {
      logDebug(`[CronScheduler] 🕒 Disparando campanha agendada: "${camp.name}" (id=${camp.id})`);
      // Marcar como running
      await supabase.from('campaigns').update({ status: 'running' }).eq('id', camp.id);

      // Buscar a sessão da inbox
      const { data: inbox } = await supabase.from('inboxes').select('wa_session_id').eq('id', camp.inbox_id).maybeSingle();
      if (!inbox?.wa_session_id) continue;

      const session = getSession(inbox.wa_session_id);
      if (!session || session.status !== 'connected') {
        await supabase.from('campaigns').update({ status: 'failed' }).eq('id', camp.id);
        continue;
      }

      // Buscar destinatários (armazenados como JSON no campo recipients)
      const recipients = camp.recipients || [];
      if (!recipients.length) {
        await supabase.from('campaigns').update({ status: 'completed' }).eq('id', camp.id);
        continue;
      }

      await dispatchCampaign(session.sock, recipients, camp.message, camp.inbox_id, inbox.wa_session_id, camp.id, camp.media_url, camp.media_type);
    }
  } catch (err) {
    logDebug(`[CronScheduler] Erro: ${err.message}`);
  }
});

export default router;
