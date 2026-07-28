import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY are not set in environment variables!');
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Concurrency lock para evitar duplicação em race conditions (ex: 2 mensagens chegando juntas)
const dbLocks = new Map();
async function withLock(key, fn) {
  if (!dbLocks.has(key)) {
    dbLocks.set(key, Promise.resolve());
  }
  const lock = dbLocks.get(key);
  let release;
  const nextLock = new Promise(resolve => { release = resolve; });
  dbLocks.set(key, lock.then(() => nextLock));
  
  try {
    await lock;
    return await fn();
  } finally {
    release();
    if (dbLocks.get(key) === nextLock) {
      dbLocks.delete(key);
    }
  }
}

export async function findOrCreateContact({ phone, name, avatar_url, companyId }) {
  return await withLock(`contact-${companyId}-${phone}`, async () => {
    // Tenta encontrar por telefone e empresa
    const { data: existing, error: selectError } = await supabase
      .from('contacts')
      .select('*')
      .eq('company_id', companyId)
      .eq('phone', phone)
      .maybeSingle();

    if (existing) {
      if (avatar_url && !existing.avatar_url) {
        await supabase.from('contacts').update({ avatar_url }).eq('id', existing.id);
        existing.avatar_url = avatar_url;
      }
      return existing;
    }

    // Cria novo contato
    const { data: created, error } = await supabase
      .from('contacts')
      .insert({ phone, name, avatar_url, company_id: companyId })
      .select()
      .single();

    if (error) {
      console.error('Erro ao criar contato:', error);
      throw error;
    }
    return created;
  });
}

export async function findOrCreateConversation({ contactId, inboxId, sessionId, isOutgoing = false, companyId }) {
  return await withLock(`conv-${contactId}-${inboxId}`, async () => {
    // Verifica se existe conversa aberta
    const { data: existing, error: selectError } = await supabase
      .from('conversations')
      .select('*')
      .eq('contact_id', contactId)
      .eq('inbox_id', inboxId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      // Incrementar unread_count apenas se NÃO for mensagem enviada por nós
      if (!isOutgoing) {
        const { data: updated, error } = await supabase
          .from('conversations')
          .update({ unread_count: (existing.unread_count || 0) + 1 })
          .eq('id', existing.id)
          .select()
          .single();
        return { conversation: updated || existing, isNew: false };
      }
      return { conversation: existing, isNew: false };
    }

    // Criar nova conversa
    const { data: created, error } = await supabase
      .from('conversations')
      .insert({
        company_id: companyId,
        contact_id: contactId,
        inbox_id: inboxId,
        status: 'open',
        unread_count: isOutgoing ? 0 : 1
      })
      .select()
      .single();

    if (error) {
      console.error('Erro ao criar conversa:', error);
      throw error;
    }

    // Executar auto-distribuição inteligente em background
    if (!isOutgoing) {
      autoAssignConversation(created.id, inboxId).catch(err => {
        console.error('[Auto-Assignment] Falha em background:', err);
      });
    }

    return { conversation: created, isNew: true };
  });
}

// Lógica de distribuição inteligente de conversas
async function autoAssignConversation(conversationId, inboxId) {
  try {
    // 1. Verificar se a caixa de entrada correspondente está com auto_assignment ativo
    const { data: inbox, error: errInbox } = await supabase
      .from('inboxes')
      .select('auto_assignment, name')
      .eq('id', inboxId)
      .single();

    if (errInbox || !inbox || !inbox.auto_assignment) {
      return; // Se desligado ou com erro, abortar
    }

    console.log(`[Auto-Assignment] Iniciando distribuição automática para conversa ${conversationId} (Inbox: ${inbox.name})...`);

    // 2. Buscar agentes associados a esta inbox
    const { data: inboxAgents, error: errInboxAgents } = await supabase
      .from('inbox_agents')
      .select('agent_id')
      .eq('inbox_id', inboxId);

    if (errInboxAgents || !inboxAgents || inboxAgents.length === 0) {
      console.log(`[Auto-Assignment] Nenhum agente associado a inbox ${inboxId}.`);
      return;
    }

    const agentIds = inboxAgents.map(ia => ia.agent_id);

    // 3. Buscar quais desses agentes associados estão ONLINE
    const { data: onlineAgents, error: errOnline } = await supabase
      .from('agents')
      .select('id, name')
      .in('id', agentIds)
      .eq('status', 'online');

    if (errOnline || !onlineAgents || onlineAgents.length === 0) {
      console.log(`[Auto-Assignment] Nenhum agente online associado a inbox ${inboxId}.`);
      return;
    }

    console.log(`[Auto-Assignment] Agentes online qualificados: ${onlineAgents.map(a => a.name).join(', ')}`);

    // 4. Contar conversas abertas de cada agente online
    const onlineAgentIds = onlineAgents.map(a => a.id);
    const { data: convCounts, error: errCounts } = await supabase
      .from('conversations')
      .select('assigned_agent_id')
      .in('assigned_agent_id', onlineAgentIds)
      .eq('status', 'open');

    if (errCounts) {
      console.error('[Auto-Assignment] Erro ao contar conversas:', errCounts);
      return;
    }

    // Calcular carga por agente online
    const agentLoad = {};
    onlineAgentIds.forEach(id => {
      agentLoad[id] = 0;
    });

    if (convCounts) {
      convCounts.forEach(c => {
        if (c.assigned_agent_id && agentLoad[c.assigned_agent_id] !== undefined) {
          agentLoad[c.assigned_agent_id]++;
        }
      });
    }

    // Escolher agente com menor carga
    let minLoad = Infinity;
    let chosenAgentId = null;

    onlineAgents.forEach(agent => {
      const load = agentLoad[agent.id];
      if (load < minLoad) {
        minLoad = load;
        chosenAgentId = agent.id;
      }
    });

    if (!chosenAgentId) return;

    const chosenAgent = onlineAgents.find(a => a.id === chosenAgentId);
    console.log(`[Auto-Assignment] Atribuindo conversa para o agente ${chosenAgent.name} (Carga: ${minLoad} conversas abertas).`);

    // 5. Atualizar conversa com o agente atribuído
    const { error: errUpdate } = await supabase
      .from('conversations')
      .update({ assigned_agent_id: chosenAgentId })
      .eq('id', conversationId);

    if (errUpdate) {
      console.error('[Auto-Assignment] Erro ao atualizar conversa:', errUpdate);
      return;
    }

    // 6. Inserir mensagem de sistema informando a atribuição automática
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'system',
        content: `Atendimento distribuído automaticamente para o agente ${chosenAgent.name}`,
        message_type: 'activity'
      });

  } catch (err) {
    console.error('[Auto-Assignment] Erro no auto-assignment:', err);
  }
}

export async function insertMessage(data) {
  const { data: message, error } = await supabase
    .from('messages')
    .insert({
      company_id: data.companyId,
      conversation_id: data.conversationId,
      sender_type: data.senderType,
      sender_id: data.senderId,
      content: data.content,
      message_type: data.messageType,
      media_url: data.mediaUrl,
      media_mime_type: data.mediaMimeType,
      media_filename: data.mediaFilename,
      wa_message_id: data.waMessageId,
      status: 'sent',
      created_at: data.createdAt || new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao inserir mensagem:', error);
    throw error;
  }
  return message;
}

export async function updateConversationLastMessage({ conversationId, preview, timestamp }) {
  const { error } = await supabase
    .from('conversations')
    .update({
      last_message_at: timestamp,
      last_message_preview: preview ? preview.substring(0, 120) : ''
    })
    .eq('id', conversationId);
  
  if (error) {
    console.error('Erro ao atualizar última mensagem da conversa:', error);
  }
}

export async function updateInboxConnection(inboxId, isConnected) {
  const { error } = await supabase
    .from('inboxes')
    .update({ is_connected: isConnected })
    .eq('id', inboxId);
  
  if (error) {
    console.error('Erro ao atualizar status da caixa de entrada:', error);
  }
}

export async function updateMessageStatus(waMessageId, status) {
  const { error } = await supabase
    .from('messages')
    .update({ status })
    .eq('wa_message_id', waMessageId);
  
  if (error) {
    console.error('Erro ao atualizar status da mensagem:', error);
  }
}

export { supabase };
