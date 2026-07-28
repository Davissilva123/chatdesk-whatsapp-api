import express from 'express';
import { getSession } from '../baileys/session-manager.js';

const router = express.Router();

router.get('/qrcode/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(200).json({ status: 'not_found' });
  }

  if (session.status === 'connected') {
    return res.json({ status: 'connected' });
  }

  if (session.status === 'waiting_qr') {
    return res.json({
      status: 'waiting_qr',
      qrcode: session.qrcode
    });
  }

  res.json({ status: session.status });
});

export default router;
