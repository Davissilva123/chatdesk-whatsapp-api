import express from 'express';
import { getSession } from '../baileys/session-manager.js';
import { supabase } from '../services/supabase.js';
import crypto from 'crypto';

const router = express.Router();

router.post('/send', async (req, res) => {
  const { sessionId, phone, type, content, mediaUrl, conversationId, messageId } = req.body;

  if (!sessionId || !phone || !type) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetros sessionId, phone e type são obrigatórios.',
      code: 'BAD_REQUEST'
    });
  }

  const session = getSession(sessionId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({
      success: false,
      error: 'Sessão não conectada',
      code: 'SESSION_DISCONNECTED'
    });
  }

  try {
    let jid = phone;
    if (!jid.includes('@')) {
      const cleanPhone = phone.replace(/\D/g, '');
      jid = `${cleanPhone}@s.whatsapp.net`;
    }
    const sock = session.sock;

    let sendOptions = {};
    if (type === 'text') {
      sendOptions = { text: content || '' };
    } else if (type === 'image') {
      if (!mediaUrl) {
        return res.status(400).json({ success: false, error: 'URL da imagem não informada.', code: 'BAD_REQUEST' });
      }
      sendOptions = { image: { url: mediaUrl }, caption: content || '' };
    } else if (type === 'audio') {
      if (!mediaUrl) {
        return res.status(400).json({ success: false, error: 'URL do áudio não informada.', code: 'BAD_REQUEST' });
      }
      // ptt: true indica mensagem de voz gravada (player com microfone azul)
      sendOptions = { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: true };
    } else if (type === 'file') {
      if (!mediaUrl) {
        return res.status(400).json({ success: false, error: 'URL do arquivo não informada.', code: 'BAD_REQUEST' });
      }
      const filename = content || 'arquivo';
      sendOptions = { document: { url: mediaUrl }, fileName: filename, mimetype: 'application/octet-stream' };
    } else {
      return res.status(400).json({ success: false, error: 'Tipo de mensagem não suportado.', code: 'BAD_REQUEST' });
    }

    // Gerar waMessageId previamente para salvar antes de enviar
    const waMessageId = '3EB0' + crypto.randomBytes(8).toString('hex').toUpperCase();

    // Se houver ID da mensagem do Supabase, atualizar status e wa_message_id primeiro
    if (messageId) {
      await supabase
        .from('messages')
        .update({
          status: 'delivered',
          wa_message_id: waMessageId
        })
        .eq('id', messageId);
    } else if (conversationId) {
      // Fallback: se não passou messageId mas passou conversationId, criar registro
      await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_type: 'agent',
          content: content || `[${type}]`,
          message_type: type,
          media_url: mediaUrl || null,
          wa_message_id: waMessageId,
          status: 'delivered'
        });
    }

    // Enviar mensagem informando o ID gerado nas opções
    const result = await sock.sendMessage(jid, sendOptions, { messageId: waMessageId });

    res.json({
      success: true,
      waMessageId: waMessageId || result?.key?.id || '',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(`[${sessionId}] Erro ao enviar mensagem para ${phone}:`, error);
    res.status(500).json({
      success: false,
      error: `Erro interno ao processar envio: ${error.message || error}`,
      code: 'INTERNAL_ERROR'
    });
  }
});

export default router;
