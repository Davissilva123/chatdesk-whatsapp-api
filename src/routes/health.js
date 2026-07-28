import express from 'express';
import { getAllSessions } from '../baileys/session-manager.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: getAllSessions()
  });
});

export default router;
