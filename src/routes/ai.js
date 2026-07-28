import express from 'express';
import { supabase } from '../services/supabase.js';

const router = express.Router();

router.post('/ai/suggest', async (req, res) => {
  const { conversationId } = req.body;

  if (!conversationId) {
    return res.status(400).json({
      success: false,
      error: 'O parâmetro conversationId é obrigatório.',
      code: 'BAD_REQUEST'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: 'Chave GEMINI_API_KEY não configurada no servidor backend.',
      code: 'GEMINI_KEY_MISSING'
    });
  }

  try {
    // Buscar as últimas 10 mensagens ordenadas por data crescente (mais recentes por último)
    const { data: messages, error: dbError } = await supabase
      .from('messages')
      .select('content, sender_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (dbError) {
      console.error('[AI suggest] Erro ao buscar mensagens no Supabase:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Erro ao consultar histórico de mensagens no banco.',
        code: 'DATABASE_ERROR'
      });
    }

    if (!messages || messages.length === 0) {
      return res.json({
        success: true,
        suggestion: 'Olá! Como posso ajudar você hoje?'
      });
    }

    // Inverter para colocar em ordem cronológica (antiga -> nova)
    const chronologicalMsgs = [...messages].reverse();
    
    const messagesFormatted = chronologicalMsgs
      .map(m => {
        const sender = m.sender_type === 'contact' ? 'Cliente' : (m.sender_type === 'agent' ? 'Atendente' : 'Sistema');
        return `${sender}: ${m.content || `[Mensagem do tipo ${m.message_type}]`}`;
      })
      .join('\n');

    const prompt = `Você é um assistente de suporte ao cliente inteligente, prestativo e profissional integrado ao sistema ChatDesk.
Seu papel é analisar o histórico de conversa abaixo e sugerir uma resposta direta, simpática e profissional para o atendente humano enviar ao cliente.

Aqui está o histórico de mensagens recente da conversa:
${messagesFormatted}

Instruções para a sugestão:
1. Escreva uma resposta curta e objetiva em português do Brasil.
2. Seja educado, prestativo e profissional.
3. Não inclua nenhuma saudação exagerada ou repetição desnecessária se o diálogo já estiver em andamento.
4. Retorne APENAS o texto da sugestão de resposta que o atendente enviará. Não adicione observações, explicações, aspas adicionais, introduções ou notas de rodapé.`;

    console.log(`[AI suggest] Solicitando sugestão para conversa ${conversationId}...`);

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[AI suggest] Erro retornado pela API do Gemini:', errText);
      return res.status(502).json({
        success: false,
        error: 'Falha na comunicação com o serviço de Inteligência Artificial.',
        code: 'GEMINI_API_ERROR'
      });
    }

    const result = await response.json();
    let suggestion = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    // Remover possíveis aspas extras adicionadas pela IA
    if (suggestion.startsWith('"') && suggestion.endsWith('"')) {
      suggestion = suggestion.slice(1, -1).trim();
    }

    res.json({
      success: true,
      suggestion
    });

  } catch (err) {
    console.error('[AI suggest] Erro geral ao processar sugestão:', err);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao gerar sugestão de resposta.',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

export default router;
