import express from 'express';
import { getSession } from '../baileys/session-manager.js';
import { supabase } from '../services/supabase.js';
import crypto from 'crypto';

const router = express.Router();

router.post('/send', async (req, res) => {
  const { sessionId, phone, type, content, mediaUrl, conversationId, messageId, replyToMessageId } = req.body;

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

    let extraOptions = {};

    // Se tiver resposta (quote)
    if (replyToMessageId) {
      try {
        const { data: quotedMsg } = await supabase
          .from('messages')
          .select('wa_message_id, sender_type, content')
          .eq('id', replyToMessageId)
          .single();

        if (quotedMsg && quotedMsg.wa_message_id) {
          extraOptions.quoted = {
            key: {
              remoteJid: jid,
              fromMe: quotedMsg.sender_type === 'agent',
              id: quotedMsg.wa_message_id
            },
            message: {
              conversation: quotedMsg.content || ''
            }
          };
        }
      } catch (err) {
        console.error('Erro ao buscar mensagem citada:', err);
      }
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
          status: 'delivered',
          reply_to_message_id: replyToMessageId || null
        });
    }

    // Enviar mensagem informando o ID gerado nas opções e a citação se houver
    const result = await sock.sendMessage(jid, sendOptions, { messageId: waMessageId, ...extraOptions });

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

// ==========================================
// DELETAR MENSAGEM (APAGAR PARA TODOS)
// ==========================================
router.post('/send/delete', async (req, res) => {
  const { sessionId, phone, waMessageId, deleteForEveryone, messageId } = req.body;
  if (!sessionId || !phone || !waMessageId) return res.status(400).json({ success: false, error: 'Parâmetros inválidos' });

  const session = getSession(sessionId);
  if (!session || session.status !== 'connected') return res.status(400).json({ success: false, error: 'Sessão desconectada' });

  try {
    let jid = phone;
    if (!jid.includes('@')) jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    
    // Se for apagar para todos, chama API do WhatsApp
    if (deleteForEveryone) {
      await session.sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: waMessageId } });
    }
    
    // Atualizar no banco
    if (messageId) {
      await supabase.from('messages').update({ 
        is_deleted: true, 
        deleted_for_everyone: deleteForEveryone 
      }).eq('id', messageId);
    } else {
      await supabase.from('messages').update({ 
        is_deleted: true, 
        deleted_for_everyone: deleteForEveryone 
      }).eq('wa_message_id', waMessageId);
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// EDITAR MENSAGEM
// ==========================================
router.post('/send/edit', async (req, res) => {
  const { sessionId, phone, waMessageId, newContent, messageId } = req.body;
  if (!sessionId || !phone || !waMessageId || !newContent) return res.status(400).json({ success: false, error: 'Parâmetros inválidos' });

  const session = getSession(sessionId);
  if (!session || session.status !== 'connected') return res.status(400).json({ success: false, error: 'Sessão desconectada' });

  try {
    let jid = phone;
    if (!jid.includes('@')) jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    
    await session.sock.sendMessage(jid, { 
      edit: { remoteJid: jid, fromMe: true, id: waMessageId }, 
      text: newContent 
    });
    
    // Atualizar banco
    const updatePayload = { content: newContent, edited_at: new Date().toISOString() };
    if (messageId) {
      await supabase.from('messages').update(updatePayload).eq('id', messageId);
    } else {
      await supabase.from('messages').update(updatePayload).eq('wa_message_id', waMessageId);
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// REAGIR A MENSAGEM
// ==========================================
router.post('/send/react', async (req, res) => {
  const { sessionId, phone, waMessageId, reaction, fromMe, messageId } = req.body;
  if (!sessionId || !phone || !waMessageId) return res.status(400).json({ success: false, error: 'Parâmetros inválidos' });

  const session = getSession(sessionId);
  if (!session || session.status !== 'connected') return res.status(400).json({ success: false, error: 'Sessão desconectada' });

  try {
    let jid = phone;
    if (!jid.includes('@')) jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    
    await session.sock.sendMessage(jid, { 
      react: { 
        text: reaction || '', 
        key: { remoteJid: jid, fromMe: !!fromMe, id: waMessageId } 
      } 
    });
    
    // Se temos messageId, precisamos atualizar as reações locais no DB
    if (messageId) {
      const { data: msgToReact } = await supabase.from('messages').select('reactions').eq('id', messageId).single();
      if (msgToReact) {
        let currentReactions = msgToReact.reactions;
        if (!Array.isArray(currentReactions)) currentReactions = [];
        
        // Remove reação anterior do agente
        currentReactions = currentReactions.filter(r => r.sender !== 'agent');
        
        if (reaction && reaction !== '') {
          currentReactions.push({ emoji: reaction, sender: 'agent' });
        }
        
        await supabase.from('messages').update({ reactions: currentReactions }).eq('id', messageId);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
