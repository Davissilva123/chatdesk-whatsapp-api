import { downloadMediaMessage } from '@whiskeysockets/baileys';
import {
  findOrCreateContact,
  findOrCreateConversation,
  insertMessage,
  updateConversationLastMessage,
  supabase
} from '../services/supabase.js';
import { uploadMediaToStorage } from '../services/media.js';
import { runAutomations } from '../services/automation-runner.js';
import { runChatbotFlow } from '../services/chatbot-runner.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function logDebug(message) {
  try {
    const logPath = path.join(process.cwd(), 'debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch (e) {
    console.error('Failed to write debug log:', e);
  }
}

function isInsideBusinessHours(businessHours) {
  if (!businessHours) return true;
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const now = new Date();
  const currentDayKey = dayKeys[now.getDay()];
  const dayCfg = businessHours[currentDayKey];
  
  // Se o dia não estiver configurado ou estiver desativado
  if (!dayCfg || !dayCfg.enabled) return false;
  
  // Se não houver intervalos configurados para o dia ativo
  if (!dayCfg.intervals || dayCfg.intervals.length === 0) return false;
  
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${hours}:${minutes}`;
  
  for (const interval of dayCfg.intervals) {
    if (interval.length === 2) {
      const [start, end] = interval;
      if (currentTimeStr >= start && currentTimeStr <= end) {
        return true;
      }
    }
  }
  return false;
}

export async function handleIncomingMessage(msg, sessionId, inboxId, sock) {
  const { key, pushName, messageTimestamp } = msg;
  let message = msg.message;

  // Desempacota invólucros de mensagens aninhadas (mensagens temporárias, visualização única, etc.)
  while (message) {
    if (message.ephemeralMessage) {
      message = message.ephemeralMessage.message;
    } else if (message.viewOnceMessage) {
      message = message.viewOnceMessage.message;
    } else if (message.viewOnceMessageV2) {
      message = message.viewOnceMessageV2.message;
    } else if (message.documentWithCaptionMessage) {
      message = message.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  const jid = key.remoteJid;
  const waMessageId = key.id;

  // Se a mensagem foi enviada por nós (fromMe = true), verificar se já existe no banco (enviada pelo painel)
  if (key.fromMe) {
    try {
      const { data: existingMsg, error: findError } = await supabase
        .from('messages')
        .select('id')
        .eq('wa_message_id', waMessageId)
        .maybeSingle();

      if (findError) {
        logDebug(`[${sessionId}] Erro ao buscar mensagem existente com waMessageId=${waMessageId}: ${findError.message}`);
      } else if (existingMsg) {
        logDebug(`[${sessionId}] Mensagem enviada pelo painel já existe no banco: waMessageId=${waMessageId}. Ignorando.`);
        return;
      }
    } catch (err) {
      logDebug(`[${sessionId}] Erro ao verificar duplicidade de mensagem fromMe: ${err.message}`);
    }
  }

  logDebug(`[${sessionId}] handleIncomingMessage chamado. jid=${jid}, pushName=${pushName}, messageKeys=${Object.keys(message || {})}`);

  try {
    if (!jid) {
      logDebug(`[${sessionId}] Ignorado: remoteJid está vazio.`);
      return;
    }

    // Buscar configurações da inbox no Supabase para saber se devemos ignorar audios ou grupos
    let ignoreAudios = false;
    let ignoreGroups = true; // Por padrão, a gente ignora grupos
    let inboxObj = null;
    
    try {
      const { data: inbox, error: inboxError } = await supabase
        .from('inboxes')
        .select('*')
        .eq('id', inboxId)
        .single();
      
      if (!inboxError && inbox) {
        inboxObj = inbox;
        if (inbox.ignore_audios !== undefined && inbox.ignore_audios !== null) {
          ignoreAudios = inbox.ignore_audios;
        }
        if (inbox.ignore_groups !== undefined && inbox.ignore_groups !== null) {
          ignoreGroups = inbox.ignore_groups;
        }
      } else {
        logDebug(`[${sessionId}] Aviso ao buscar inbox ${inboxId}: ${inboxError?.message}. Usando padrão (ignoreAudios=${ignoreAudios}, ignoreGroups=${ignoreGroups})`);
      }
    } catch (dbErr) {
      logDebug(`[${sessionId}] Erro ao carregar configurações da inbox: ${dbErr.message}`);
    }

    const isUser = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
    const isGroup = jid.endsWith('@g.us');

    if (!isUser && (!isGroup || ignoreGroups)) {
      logDebug(`[${sessionId}] Ignorado: remoteJid não é elegível para processamento (isUser=${isUser}, isGroup=${isGroup}, ignoreGroups=${ignoreGroups}): ${jid}`);
      return;
    }

    const phone = isGroup ? jid : jid.replace('@s.whatsapp.net', '');
    let name = pushName || phone;
    
    if (isGroup && sock) {
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata && metadata.subject) {
          name = metadata.subject;
        }
      } catch (err) {
        logDebug(`[${sessionId}] Erro ao buscar metadata do grupo ${jid}: ${err.message}`);
        name = 'Grupo do WhatsApp';
      }
    }

    const waMessageId = key.id;
    logDebug(`[${sessionId}] Processando mensagem de phone=${phone}, name=${name}, waMessageId=${waMessageId}`);

    // Filtro de mensagens de áudio (definido no banco de dados da inbox)
    const isAudio = !!message?.audioMessage;
    let audioIgnored = false;
    if (ignoreAudios && isAudio) {
      if (inboxObj?.ignore_audios_message) {
        audioIgnored = true;
      } else {
        logDebug(`[${sessionId}] Ignorado: Mensagem de áudio recebida, mas a configuração ignore_audios está ativa e não há auto-resposta.`);
        return;
      }
    }

    // Determinar tipo e conteúdo da mensagem
    let content = null;
    let messageType = 'text';
    let mediaUrl = null;
    let mediaMimeType = null;
    let mediaFilename = null;

    if (audioIgnored) {
      content = '[Áudio recebido (descartado)]';
      messageType = 'text';
    } else if (message?.conversation) {
      content = message.conversation;
      messageType = 'text';
    } else if (message?.extendedTextMessage) {
      content = message.extendedTextMessage.text;
      messageType = 'text';
    } else if (message?.imageMessage) {
      messageType = 'image';
      mediaMimeType = message.imageMessage.mimetype;
      content = message.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        mediaUrl = await uploadMediaToStorage(buffer, mediaMimeType, `${waMessageId}.jpg`);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao baixar imagem:`, err);
        content = '[Imagem - falha no download]';
      }
    } else if (message?.audioMessage) {
      messageType = 'audio';
      mediaMimeType = message.audioMessage.mimetype;
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const ext = mediaMimeType.includes('ogg') ? 'ogg' : 'mp4';
        mediaUrl = await uploadMediaToStorage(buffer, mediaMimeType, `${waMessageId}.${ext}`);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao baixar áudio:`, err);
        content = '[Áudio - falha no download]';
      }
    } else if (message?.documentMessage) {
      messageType = 'file';
      mediaMimeType = message.documentMessage.mimetype;
      mediaFilename = message.documentMessage.fileName || 'arquivo';
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        mediaUrl = await uploadMediaToStorage(buffer, mediaMimeType, mediaFilename);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao baixar arquivo:`, err);
        content = '[Arquivo - falha no download]';
      }
    } else if (message?.stickerMessage) {
      messageType = 'image';
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        mediaUrl = await uploadMediaToStorage(buffer, 'image/webp', `${waMessageId}.webp`);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao baixar figurinha:`, err);
        content = '[Figurinha - falha no download]';
      }
    } else {
      // Tipo não suportado
      content = '[Mensagem não suportada]';
      messageType = 'text';
    }

    // Se for grupo, formatar o conteúdo para incluir quem enviou a mensagem
    if (isGroup) {
      const senderName = pushName || (key.participant ? key.participant.replace('@s.whatsapp.net', '') : 'Membro');
      content = `[${senderName}]: ${content || `[${messageType}]`}`;
    }

    const isOutgoing = !!key.fromMe;

    // 1. Encontrar ou criar contato no Supabase
    logDebug(`[${sessionId}] Chamando findOrCreateContact para phone=${phone}`);
    // Extract companyId from inbox to satisfy SaaS schema constraints
    const companyId = inboxObj?.company_id || null;
    const contact = await findOrCreateContact({ phone, name, companyId });
    logDebug(`[${sessionId}] Contato obtido: id=${contact.id}`);

    // Buscar avatar caso não exista (de forma assíncrona para não travar a mensagem)
    if (!contact.avatar_url && !isGroup && sock) {
      sock.profilePictureUrl(key.remoteJid, 'image')
        .then(async (url) => {
          if (url) {
            await supabase.from('contacts').update({ avatar_url: url }).eq('id', contact.id);
            logDebug(`[${sessionId}] Foto de perfil atualizada para ${phone}`);
          }
        })
        .catch(() => {
          // Contato pode não ter foto ou ter privacidade restrita, ignoramos
        });
    }

    // Se o contato estiver bloqueado, não recebemos novas mensagens dele
    if (contact.is_blocked) {
      logDebug(`[${sessionId}] Mensagem ignorada: contato ${phone} está bloqueado no ChatDesk.`);
      return;
    }

    // 2. Encontrar ou criar conversa aberta para este contato + inbox
    logDebug(`[${sessionId}] Chamando findOrCreateConversation para contactId=${contact.id}, inboxId=${inboxId}`);
    const { conversation, isNew } = await findOrCreateConversation({
      contactId: contact.id,
      inboxId,
      sessionId,
      isOutgoing,
      companyId
    });
    logDebug(`[${sessionId}] Conversa obtida: id=${conversation.id}, isNew=${isNew}`);

    // 3. Inserir mensagem no Supabase
    const timestamp = messageTimestamp ? new Date(messageTimestamp * 1000).toISOString() : new Date().toISOString();
    logDebug(`[${sessionId}] Chamando insertMessage para convId=${conversation.id}`);
    const insertedMessage = await insertMessage({
      conversationId: conversation.id,
      senderType: isOutgoing ? 'agent' : 'contact',
      senderId: isOutgoing ? null : contact.id,
      content,
      messageType,
      mediaUrl,
      mediaMimeType,
      mediaFilename,
      waMessageId,
      createdAt: timestamp,
      companyId
    });
    logDebug(`[${sessionId}] Mensagem inserida: id=${insertedMessage.id}`);

    // 4. Atualizar last_message_at e preview na conversa
    await updateConversationLastMessage({
      conversationId: conversation.id,
      preview: content || `[${messageType}]`,
      timestamp: insertedMessage.created_at || timestamp
    });

    console.log(`[${sessionId}] Mensagem de ${phone} processada → conversa ${conversation.id}`);

    // Executar regras de automação personalizadas apenas se for mensagem recebida (entrada)
    if (!isOutgoing) {
      try {
        // Tentar fluxo de chatbot primeiro (se houver um ativo)
        const chatbotHandled = await runChatbotFlow(inboxId, conversation, contact, insertedMessage, sock);
        
        if (isNew) {
          await runAutomations('conversation_created', conversation, contact, insertedMessage, sock);
        }
        await runAutomations('message_received', conversation, contact, insertedMessage, sock);
      } catch (autoErr) {
        console.error(`[${sessionId}] Erro ao rodar automações:`, autoErr);
      }

      // Disparar Webhook para Chatbot se habilitado
      if (inboxObj && inboxObj.bot_enabled && inboxObj.bot_webhook_url) {
        const isBotActive = conversation.bot_active !== false;
        if (isBotActive) {
          dispatchChatbotWebhook(inboxObj.bot_webhook_url, {
            event: 'message.received',
            timestamp: new Date().toISOString(),
            message: {
              id: insertedMessage.id,
              content: insertedMessage.content,
              type: insertedMessage.message_type,
              media_url: insertedMessage.media_url,
              wa_message_id: insertedMessage.wa_message_id,
              created_at: insertedMessage.created_at
            },
            conversation: {
              id: conversation.id,
              inbox_id: conversation.inbox_id,
              contact_id: conversation.contact_id
            },
            contact: {
              id: contact.id,
              name: contact.name,
              phone: contact.phone
            }
          });
        }
      }
    }

    // Enviar resposta automática para áudio descartado apenas para mensagens de entrada
    if (!isOutgoing && audioIgnored && inboxObj?.ignore_audios_message && sock) {
      try {
        let targetJid = phone;
        if (!targetJid.includes('@')) {
          const cleanPhone = phone.replace(/\D/g, '');
          targetJid = `${cleanPhone}@s.whatsapp.net`;
        }

        console.log(`[${sessionId}] Enviando resposta automática de áudio ignorado para ${targetJid}: ${inboxObj.ignore_audios_message.substring(0, 50)}...`);
        
        const replyWaMsgId = '3EB0' + crypto.randomBytes(8).toString('hex').toUpperCase();

        // Inserir mensagem de resposta no Supabase
        const replyTimestamp = new Date().toISOString();
        const insertedReply = await insertMessage({
          conversationId: conversation.id,
          senderType: 'agent',
          senderId: null,
          content: inboxObj.ignore_audios_message,
          messageType: 'text',
          waMessageId: replyWaMsgId,
          createdAt: replyTimestamp
        });

        await sock.sendMessage(targetJid, { text: inboxObj.ignore_audios_message }, { messageId: replyWaMsgId });

        // Atualizar conversa com a última mensagem enviada
        await updateConversationLastMessage({
          conversationId: conversation.id,
          preview: inboxObj.ignore_audios_message,
          timestamp: insertedReply.created_at || replyTimestamp
        });
      } catch (sendErr) {
        console.error(`[${sessionId}] Erro ao enviar resposta automática de áudio ignorado via WhatsApp:`, sendErr);
      }
    }

    // 5. Se for uma conversa nova, executar regras de auto-respostas (saudação/ausência) e auto-atribuição apenas se for de entrada
    if (isNew && !isOutgoing) {
      try {
        const inbox = inboxObj || (await (async () => {
          const { data, error } = await supabase
            .from('inboxes')
            .select('*')
            .eq('id', inboxId)
            .single();
          if (error) throw error;
          return data;
        })().catch(err => {
          console.error(`[${sessionId}] Erro ao buscar configurações da inbox:`, err);
          return null;
        }));

        if (inbox) {
          let autoReplySent = false;
          let replyContent = '';

          // Verificar horário de funcionamento
          if (inbox.business_hours_enabled) {
            const inside = isInsideBusinessHours(inbox.business_hours);
            if (!inside) {
              if (inbox.absence_message) {
                replyContent = inbox.absence_message;
                autoReplySent = true;
              }
            } else {
              if (inbox.greeting_enabled && inbox.greeting_message) {
                replyContent = inbox.greeting_message;
                autoReplySent = true;
              }
            }
          } else {
            // Sem horário de funcionamento, apenas verifica mensagem de saudação
            if (inbox.greeting_enabled && inbox.greeting_message) {
              replyContent = inbox.greeting_message;
              autoReplySent = true;
            }
          }

          // Se tiver que enviar resposta automática
          if (autoReplySent && replyContent && sock) {
            try {
              let targetJid = phone;
              if (!targetJid.includes('@')) {
                const cleanPhone = phone.replace(/\D/g, '');
                targetJid = `${cleanPhone}@s.whatsapp.net`;
              }

              console.log(`[${sessionId}] Enviando resposta automática para ${targetJid}: ${replyContent.substring(0, 50)}...`);
              
              const replyWaMsgId = '3EB0' + crypto.randomBytes(8).toString('hex').toUpperCase();

              // Inserir mensagem de resposta no Supabase
              const replyTimestamp = new Date().toISOString();
              const insertedReply = await insertMessage({
                conversationId: conversation.id,
                senderType: 'agent',
                senderId: null,
                content: replyContent,
                messageType: 'text',
                waMessageId: replyWaMsgId,
                createdAt: replyTimestamp
              });

              await sock.sendMessage(targetJid, { text: replyContent }, { messageId: replyWaMsgId });

              // Atualizar conversa com a última mensagem enviada
              await updateConversationLastMessage({
                conversationId: conversation.id,
                preview: replyContent,
                timestamp: insertedReply.created_at || replyTimestamp
              });
            } catch (sendErr) {
              console.error(`[${sessionId}] Erro ao enviar resposta automática via WhatsApp:`, sendErr);
            }
          }

          // Atribuição Automática
          if (inbox.auto_assignment) {
            const { data: inboxAgents, error: agentsError } = await supabase
              .from('inbox_agents')
              .select('agent_id')
              .eq('inbox_id', inboxId);

            if (agentsError) {
              console.error(`[${sessionId}] Erro ao buscar agentes da caixa para atribuição:`, agentsError);
            } else if (inboxAgents && inboxAgents.length > 0) {
              const randomIndex = Math.floor(Math.random() * inboxAgents.length);
              const assignedAgentId = inboxAgents[randomIndex].agent_id;
              
              console.log(`[${sessionId}] Atribuindo conversa ${conversation.id} automaticamente ao agente ${assignedAgentId}`);
              const { error: updateConvError } = await supabase
                .from('conversations')
                .update({ assigned_agent_id: assignedAgentId })
                .eq('id', conversation.id);

              if (updateConvError) {
                console.error(`[${sessionId}] Erro ao atribuir agente na conversa:`, updateConvError);
              }
            } else {
              console.log(`[${sessionId}] Atribuição automática ativada, mas nenhum agente associado à caixa ${inboxId}`);
            }
          }
        }
      } catch (err) {
        console.error(`[${sessionId}] Erro na lógica de atendimento automático/atribuição:`, err);
      }
    }

  } catch (error) {
    logDebug(`[${sessionId}] ERRO CRÍTICO no handleIncomingMessage: ${error.message}\nStack: ${error.stack}`);
    console.error(`[${sessionId}] Erro ao processar mensagem:`, error);
  }
}

async function dispatchChatbotWebhook(url, payload) {
  console.log(`[Chatbot Webhook] Enviando evento para chatbot em ${url}`);
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ChatDesk-Chatbot-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!response.ok) {
      console.warn(`[Chatbot Webhook] Resposta de erro HTTP: ${response.status} de ${url}`);
    } else {
      console.log(`[Chatbot Webhook] Disparado com sucesso para ${url}`);
    }
  } catch (error) {
    console.error(`[Chatbot Webhook] Falha ao enviar para ${url}:`, error.message);
  }
}
