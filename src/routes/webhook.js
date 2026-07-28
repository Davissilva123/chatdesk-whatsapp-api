import express from 'express';
import { getSession } from '../baileys/session-manager.js';
import { supabase } from '../services/supabase.js';

const router = express.Router();

router.post('/webhook', async (req, res) => {
  const { event, data } = req.body;

  if (!event || !data) {
    return res.status(400).json({ error: 'Os campos event e data são obrigatórios.' });
  }

  if (event === 'send_message') {
    const { sessionId, phone, content, type = 'text', mediaUrl } = data;

    if (!sessionId || !phone || !content) {
      return res.status(400).json({ error: 'Parâmetros sessionId, phone e content são necessários dentro de data.' });
    }

    const session = getSession(sessionId);
    if (!session || session.status !== 'connected') {
      return res.status(400).json({ error: 'Sessão do WhatsApp não conectada.', code: 'SESSION_DISCONNECTED' });
    }

    try {
      const cleanPhone = phone.replace(/\D/g, '');
      const jid = `${cleanPhone}@s.whatsapp.net`;
      const sock = session.sock;

      let sendOptions = {};
      if (type === 'text') {
        sendOptions = { text: content };
      } else if (type === 'image') {
        sendOptions = { image: { url: mediaUrl || content }, caption: content };
      } else if (type === 'audio') {
        sendOptions = { audio: { url: mediaUrl || content }, mimetype: 'audio/mp4', ptt: true };
      } else if (type === 'file') {
        sendOptions = { document: { url: mediaUrl || content }, fileName: 'arquivo', mimetype: 'application/octet-stream' };
      }

      const result = await sock.sendMessage(jid, sendOptions);
      const waMessageId = result?.key?.id;

      // Retorna sucesso
      return res.json({
        success: true,
        waMessageId: waMessageId || '',
        message: 'Mensagem enviada via webhook com sucesso.'
      });

    } catch (error) {
      console.error(`[Webhook] Erro ao processar send_message para ${phone}:`, error);
      return res.status(500).json({ error: 'Falha ao enviar mensagem.' });
    }
  }

  // Se for outro evento, apenas loga e retorna OK
  console.log(`[Webhook] Evento desconhecido recebido: ${event}`, data);
  res.json({ success: true, message: `Evento ${event} recebido.` });
});

export default router;
