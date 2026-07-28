import express from 'express';
import { getSession } from '../baileys/session-manager.js';

const router = express.Router();

router.post('/presence', async (req, res) => {
  const { sessionId, phone, presence } = req.body; // presence: 'composing' | 'paused'

  if (!sessionId || !phone || !presence) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetros sessionId, phone e presence são obrigatórios.',
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

    // Baileys presence update
    await sock.sendPresenceUpdate(presence, jid);

    res.json({ success: true });
  } catch (error) {
    console.error(`[${sessionId}] Erro ao notificar presença para ${phone}:`, error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao processar status de presença',
      code: 'PRESENCE_FAILED'
    });
  }
});

export default router;
