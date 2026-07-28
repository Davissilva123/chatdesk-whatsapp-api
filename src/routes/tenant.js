import express from 'express';
import { supabase } from '../services/supabase.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const { companyName, userName, email, password } = req.body;

  if (!companyName || !userName || !email || !password) {
    return res.status(400).json({ success: false, error: 'Todos os campos são obrigatórios' });
  }

  try {
    // 1. Criar usuário no Supabase Auth usando Admin API (service_role)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true, // Já confirma o email para simplificar
      user_metadata: { name: userName.trim() }
    });

    if (authError) {
      return res.status(400).json({ success: false, error: authError.message });
    }

    const userId = authData.user.id;

    // 2. Criar a Empresa (Tenant)
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .insert({
        name: companyName.trim(),
        subscription_status: 'trial',
        // Define vencimento para 7 dias a partir de agora
        subscription_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        plan_name: 'Pro'
      })
      .select()
      .single();

    if (companyError) {
      // Idealmente deveríamos fazer rollback no auth, mas para simplicidade:
      console.error('Erro ao criar empresa:', companyError);
      return res.status(500).json({ success: false, error: 'Erro ao criar conta empresarial.' });
    }

    // 3. Criar o Agente (Admin da Empresa)
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .insert({
        user_id: userId,
        company_id: company.id,
        name: userName.trim(),
        email: email.trim(),
        role: 'admin',
        status: 'offline'
      })
      .select()
      .single();

    if (agentError) {
      console.error('Erro ao criar agente:', agentError);
      return res.status(500).json({ success: false, error: 'Erro ao vincular usuário.' });
    }

    res.json({ success: true, message: 'Conta criada com sucesso!' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, error: 'Erro interno no servidor' });
  }
});

export default router;
