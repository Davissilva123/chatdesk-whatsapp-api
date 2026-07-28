import express from 'express';
import { startSession, disconnectSession, getSession } from '../baileys/session-manager.js';

const router = express.Router();

// Iniciar Sessão / Gerar QR Code
router.post('/session/start', async (req, res) => {
  const { sessionId, inboxId } = req.body;

  if (!sessionId || !inboxId) {
    return res.status(400).json({ error: 'Parâmetros sessionId e inboxId são obrigatórios.' });
  }

  try {
    const existing = getSession(sessionId);
    if (existing) {
      if (existing.status === 'connected') {
        return res.json({ status: 'connected', sessionId });
      }
      return res.json({ status: existing.status, sessionId });
    }

    const result = await startSession(sessionId, inboxId);
    res.json(result);
  } catch (error) {
    console.error(`Erro ao iniciar sessão ${sessionId}:`, error);
    res.status(500).json({ error: 'Erro interno ao iniciar sessão.' });
  }
});

// Desconectar Sessão
router.post('/disconnect/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const success = await disconnectSession(sessionId);
    if (success) {
      res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
    } else {
      res.status(404).json({ success: false, error: 'Sessão não encontrada ou não ativa.' });
    }
  } catch (error) {
    console.error(`Erro ao desconectar sessão ${sessionId}:`, error);
    res.status(500).json({ error: 'Erro interno ao encerrar sessão.' });
  }
});

export default router;
