# ChatDesk WhatsApp API

REST API in Node.js managing WhatsApp Web connections via @whiskeysockets/baileys. It maintains active WebSocket connections, handles message reception/dispatch, and synchronizes states to Supabase.

## Prerequisites
- Node.js 20+
- Supabase account with database schemas initialized and a public storage bucket named `chatdesk-media`
- Persistent server host (e.g. Railway or Render)

## Setup
1. Clone repository
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill values:
   ```env
   SUPABASE_URL=https://your-supabase-project.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   API_KEY=your-secure-random-x-api-key
   PORT=3001
   ```
4. Run locally:
   - Development auto-reload: `npm run dev`
   - Production mode: `npm start`

## Railway Deployment
1. Import repository to GitHub.
2. Link repository to Railway project.
3. Configure persistent disk volume mount at `/sessions` to survive redeploys.
4. Set environment variables.
5. Deploy (uses automatic NIXPACKS builders via `railway.json`).

## API Endpoints

| Method | Path | Auth Required | Description |
|---|---|---|---|
| GET | `/api/health` | No | Heartbeat status & active sessions checklist |
| POST | `/api/session/start` | Yes | Boots or restores a Baileys session |
| GET | `/api/qrcode/:sessionId` | Yes | Retrieves base64 PNG QR code string |
| GET | `/api/status/:sessionId` | Yes | Checks current pairing status |
| POST | `/api/send` | Yes | Dispatches outgoing text, image, audio, or document messages |
| POST | `/api/disconnect/:sessionId` | Yes | Safely logs out and removes session cache |
| POST | `/api/webhook` | Yes | Public webhook integration for CRM relays |
