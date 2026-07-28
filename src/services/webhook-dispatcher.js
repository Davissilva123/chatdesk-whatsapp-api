import { supabase } from './supabase.js';

export function startWebhookListener() {
  console.log('[Webhook Dispatcher] Inicializando listener de conversas...');

  supabase
    .channel('conversations-webhook-trigger')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'conversations'
    }, async (payload) => {
      console.log('[Webhook Dispatcher] Mudança detectada na tabela conversations:', payload.eventType);

      const eventType = payload.eventType; // 'INSERT', 'UPDATE', 'DELETE'
      const newRecord = payload.new;
      const oldRecord = payload.old;

      let eventName = '';
      const triggeredEvents = [];

      if (eventType === 'INSERT') {
        eventName = 'conversation.created';
        triggeredEvents.push(eventName);
      } else if (eventType === 'UPDATE') {
        eventName = 'conversation.updated';
        triggeredEvents.push(eventName);

        // Se o status mudou para resolved
        if (newRecord && newRecord.status === 'resolved') {
          triggeredEvents.push('conversation.resolved');
        }
      } else if (eventType === 'DELETE') {
        eventName = 'conversation.deleted';
        triggeredEvents.push(eventName);
      }

      if (triggeredEvents.length === 0) return;

      try {
        // Buscar todos os webhooks ativos
        const { data: webhooks, error } = await supabase
          .from('outbound_webhooks')
          .select('*')
          .eq('is_active', true);

        if (error) {
          console.error('[Webhook Dispatcher] Erro ao carregar webhooks ativos:', error.message);
          return;
        }

        if (!webhooks || webhooks.length === 0) {
          return;
        }

        // Para cada webhook, verificar se está inscrito em algum dos eventos disparados
        for (const webhook of webhooks) {
          const hasInterest = webhook.events.some(e => 
            triggeredEvents.includes(e) || e === '*' || e === 'all'
          );

          if (hasInterest) {
            // Disparar POST de forma assíncrona
            triggeredEvents.forEach(evt => {
              if (webhook.events.includes(evt) || webhook.events.includes('*') || webhook.events.includes('all')) {
                dispatchWebhook(webhook.url, {
                  event: evt,
                  timestamp: new Date().toISOString(),
                  data: newRecord || oldRecord
                });
              }
            });
          }
        }
      } catch (err) {
        console.error('[Webhook Dispatcher] Erro geral ao despachar webhooks:', err);
      }
    })
    .subscribe((status) => {
      console.log('[Webhook Dispatcher] Canal de conversas webhook status:', status);
    });
}

async function dispatchWebhook(url, payload) {
  console.log(`[Webhook Dispatcher] Despachando evento ${payload.event} para ${url}`);
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ChatDesk-Outbound-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!response.ok) {
      console.warn(`[Webhook Dispatcher] Webhook para ${url} respondeu com erro HTTP: ${response.status}`);
    } else {
      console.log(`[Webhook Dispatcher] Webhook enviado com sucesso para ${url}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`[Webhook Dispatcher] Timeout ao enviar webhook para ${url}`);
    } else {
      console.error(`[Webhook Dispatcher] Falha ao enviar webhook para ${url}:`, error.message);
    }
  }
}
