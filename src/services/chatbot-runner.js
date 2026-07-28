import { supabase, insertMessage, updateConversationLastMessage } from './supabase.js';

/**
 * Engine de execução de fluxos de chatbot.
 * Chamado pelo message-handler quando uma inbox tem chatbot_flow ativo.
 */
export async function runChatbotFlow(inboxId, conversation, contact, message, sock) {
  try {
    // 1. Buscar fluxo ativo para esta inbox
    const { data: flow, error: flowError } = await supabase
      .from('chatbot_flows')
      .select('*')
      .eq('inbox_id', inboxId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (flowError || !flow) return false; // Nenhum fluxo ativo

    const nodes = flow.nodes || [];
    const edges = flow.edges || [];

    // 2. Buscar sessão atual do contato neste fluxo
    const { data: session, error: sessionError } = await supabase
      .from('chatbot_sessions')
      .select('*')
      .eq('flow_id', flow.id)
      .eq('conversation_id', conversation.id)
      .maybeSingle();

    // 3. Determinar o nó atual
    let currentNodeId;
    let context = {};

    if (!session) {
      // Nova sessão — começar no nó de início
      const startNode = nodes.find(n => n.type === 'start');
      if (!startNode) return false;
      currentNodeId = startNode.id;
      context = { contact_name: contact.name, contact_phone: contact.phone };
    } else {
      currentNodeId = session.current_node_id;
      context = session.context || {};
    }

    // 4. Processar o nó atual e avançar para o próximo
    let processedCount = 0;
    const MAX_NODES = 20; // proteção contra loops infinitos

    while (currentNodeId && processedCount < MAX_NODES) {
      const node = nodes.find(n => n.id === currentNodeId);
      if (!node) break;

      processedCount++;

      // Processar nó por tipo
      if (node.type === 'start') {
        // Apenas avança
        currentNodeId = getNextNodeId(edges, currentNodeId);

      } else if (node.type === 'message') {
        // Substituir variáveis e enviar mensagem
        const text = substituteVariables(node.data?.text || '', contact, context);
        if (text && sock) {
          const jid = buildJid(contact.phone);
          const result = await sock.sendMessage(jid, { text });
          const waMessageId = result?.key?.id;
          const ts = new Date().toISOString();
          const inserted = await insertMessage({
            conversationId: conversation.id,
            senderType: 'agent',
            senderId: null,
            content: text,
            messageType: 'text',
            waMessageId,
            createdAt: ts
          });
          await updateConversationLastMessage({
            conversationId: conversation.id,
            preview: text,
            timestamp: inserted.created_at || ts
          });
        }
        currentNodeId = getNextNodeId(edges, currentNodeId);

      } else if (node.type === 'condition') {
        // Avaliar condição baseada na última mensagem recebida
        const attr = node.data?.attribute;
        const val = (node.data?.value || '').toLowerCase();
        const msgContent = (message?.content || '').toLowerCase();
        let conditionMet = false;

        if (attr === 'message_contains') {
          conditionMet = msgContent.includes(val);
        }

        // Para simplificar: true vai para o primeiro edge (saída "Sim"), false vai para o segundo
        const outgoing = edges.filter(e => e.from === currentNodeId);
        currentNodeId = conditionMet
          ? (outgoing[0]?.to || null)
          : (outgoing[1]?.to || null);

      } else if (node.type === 'action') {
        // Executar ação
        const actionType = node.data?.actionType;
        if (actionType === 'assign_agent' && node.data?.agentId) {
          await supabase.from('conversations').update({ assigned_agent_id: node.data.agentId }).eq('id', conversation.id);
        } else if (actionType === 'add_label' && node.data?.labelId) {
          await supabase.from('conversation_labels').upsert({ conversation_id: conversation.id, label_id: node.data.labelId });
        } else if (actionType === 'resolve_conversation') {
          await supabase.from('conversations').update({ status: 'resolved' }).eq('id', conversation.id);
        } else if (actionType === 'change_priority' && node.data?.priority) {
          await supabase.from('conversations').update({ priority: node.data.priority }).eq('id', conversation.id);
        }
        currentNodeId = getNextNodeId(edges, currentNodeId);

      } else if (node.type === 'end') {
        // Encerrar fluxo — limpar sessão
        if (session) {
          await supabase.from('chatbot_sessions').delete().eq('id', session.id);
        }
        return true;

      } else {
        // Nó desconhecido: avançar
        currentNodeId = getNextNodeId(edges, currentNodeId);
      }

      // Parar após enviar mensagem (aguardar resposta do cliente)
      if (node.type === 'message') break;
    }

    // 5. Salvar/atualizar posição na sessão
    if (currentNodeId) {
      const nextNode = nodes.find(n => n.id === currentNodeId);
      // Só pausa se o próximo nó precisar de input do usuário
      if (nextNode && (nextNode.type === 'condition' || nextNode.type === 'message')) {
        if (session) {
          await supabase.from('chatbot_sessions')
            .update({ current_node_id: currentNodeId, context, updated_at: new Date().toISOString() })
            .eq('id', session.id);
        } else {
          await supabase.from('chatbot_sessions')
            .insert({ flow_id: flow.id, conversation_id: conversation.id, current_node_id: currentNodeId, context });
        }
      }
    }

    return true;
  } catch (err) {
    console.error('[ChatbotRunner] Erro crítico:', err);
    return false;
  }
}

function getNextNodeId(edges, fromId) {
  const edge = edges.find(e => e.from === fromId);
  return edge ? edge.to : null;
}

function buildJid(phone) {
  if (!phone) return null;
  if (phone.includes('@')) return phone;
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

function substituteVariables(text, contact, context) {
  return text
    .replace(/\{\{nome\}\}/gi, contact?.name || context?.contact_name || 'Cliente')
    .replace(/\{\{telefone\}\}/gi, contact?.phone || context?.contact_phone || '')
    .replace(/\{\{empresa\}\}/gi, contact?.company || '')
    .replace(/\{\{email\}\}/gi, contact?.email || '');
}
