import express from 'express';
import { getSession } from '../baileys/session-manager.js';

const router = express.Router();

router.get('/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.json({
      sessionId,
      status: 'not_found',
      phone: null,
      connectedAt: null
    });
  }

  res.json({
    sessionId,
    status: session.status,
    phone: session.phone,
    connectedAt: session.connectedAt || null
  });
});

export default router;
