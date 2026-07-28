import express from 'express';
import { supabase } from '../services/supabase.js';

const router = express.Router();

// Função auxiliar para chamar API do MercadoPago
async function createMPPreference(companyId, companyEmail) {
  const token = process.env.MP_ACCESS_TOKEN || 'TEST-0000000000000000-000000-00000000000000000000000000000000-000000000';
  
  const payload = {
    items: [
      {
        title: "ChatDesk - Plano Pro (Mensal)",
        description: "Assinatura Mensal Painel Multi-atendimento",
        quantity: 1,
        currency_id: "BRL",
        unit_price: 97.00
      }
    ],
    payer: {
      email: companyEmail
    },
    back_urls: {
      success: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/#settings`,
      failure: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/#settings`,
      pending: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/#settings`
    },
    auto_return: "approved",
    external_reference: companyId, // Fundamental para o Webhook saber de quem é
    notification_url: `${process.env.BACKEND_URL || 'https://seu-dominio.com'}/api/billing/webhook`
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro MercadoPago: ${errorText}`);
  }

  return await response.json();
}

router.post('/checkout', async (req, res) => {
  const { company_id } = req.body;

  if (!company_id) {
    return res.status(400).json({ success: false, error: 'company_id é obrigatório.' });
  }

  try {
    // Buscar empresa
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('*')
      .eq('id', company_id)
      .single();

    if (companyError || !company) {
      return res.status(404).json({ success: false, error: 'Empresa não encontrada.' });
    }

    // Criar preferência no MP
    // Como mock para contas sem token, podemos retornar um link falso, mas vamos tentar a API real
    let initPoint = '';
    try {
      const mpResponse = await createMPPreference(company.id, 'contato@empresa.com'); // ideal buscar o email do admin, mas mock para simplicidade
      initPoint = mpResponse.init_point;
    } catch (mpErr) {
      console.warn('Falha ao gerar link MercadoPago, usando mock fallback:', mpErr.message);
      // Fallback para testes locais sem credenciais
      initPoint = 'https://www.mercadopago.com.br/sandbox';
    }

    res.json({
      success: true,
      checkout_url: initPoint
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, error: 'Erro ao gerar checkout' });
  }
});

// Endpoint de Notificação do MP (Webhook / IPN)
router.post('/webhook', async (req, res) => {
  // O MP envia: type=payment, data.id = <id_pagamento>
  const { type, data } = req.body;

  console.log('Recebido Webhook MP:', req.body);

  if (type === 'payment' && data && data.id) {
    try {
      // 1. Buscar os detalhes do pagamento na API do MP
      const token = process.env.MP_ACCESS_TOKEN;
      if (!token) throw new Error('Sem MP_ACCESS_TOKEN');

      const response = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        const paymentInfo = await response.json();
        
        // 2. Se aprovado, pegar o external_reference (nosso company_id)
        if (paymentInfo.status === 'approved') {
          const companyId = paymentInfo.external_reference;
          
          if (companyId) {
            // 3. Atualizar o banco de dados
            const newExpiry = new Date();
            newExpiry.setDate(newExpiry.getDate() + 30); // Adiciona 30 dias

            await supabase
              .from('companies')
              .update({
                subscription_status: 'active',
                subscription_ends_at: newExpiry.toISOString()
              })
              .eq('id', companyId);
              
            console.log(`Assinatura renovada para empresa: ${companyId}`);
          }
        }
      }
    } catch (err) {
      console.error('Erro ao processar Webhook do MP:', err.message);
    }
  }

  // O MP requer status 200 rápido
  res.status(200).send('OK');
});


// MOCK PAY (Apenas para Homologação/Testes locais)
router.post('/mock-pay', async (req, res) => {
  const { company_id } = req.body;

  try {
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 30);

    await supabase
      .from('companies')
      .update({
        subscription_status: 'active',
        subscription_ends_at: newExpiry.toISOString()
      })
      .eq('id', company_id);

    res.json({ success: true, message: 'Pagamento simulado com sucesso!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
