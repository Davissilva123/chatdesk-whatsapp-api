import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { handleIncomingMessage } from './message-handler.js';
import { updateInboxConnection, updateMessageStatus, supabase, findOrCreateContact } from '../services/supabase.js';
import { downloadSessionState, uploadSessionFile, deleteSessionState } from './auth-state.js';

// Mapa de sessões ativas: sessionId → { sock, qrcode, status, phone, inboxId, connectedAt }
const sessions = new Map();

// Helper para sincronizar todos os arquivos da pasta local com o Supabase Storage
async function syncSessionDirToStorage(sessionId, localDir) {
  try {
    if (!fs.existsSync(localDir)) return;
    const files = fs.readdirSync(localDir);
    console.log(`[${sessionId}] Backup automático de ${files.length} arquivos de sessão...`);
    for (const file of files) {
      const filePath = path.join(localDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        await uploadSessionFile(sessionId, filePath);
      }
    }
  } catch (error) {
    console.error(`[${sessionId}] Erro ao rodar backup automático:`, error);
  }
}

export async function startSession(sessionId, inboxId) {
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (session.status === 'connected') {
      return { status: 'already_connected', sessionId };
    }
  }

  const sessionsDir = path.join(process.cwd(), 'sessions', sessionId);
  fs.mkdirSync(sessionsDir, { recursive: true });

  // 1. Tentar baixar backup do Supabase Storage para o disco local antes de iniciar o socket
  await downloadSessionState(sessionId, sessionsDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);
  let version;
  try {
    const latestVersion = await fetchLatestBaileysVersion();
    version = latestVersion.version;
  } catch (err) {
    console.warn('Erro ao obter versão mais recente do Baileys, usando fallback:', err);
    version = [2, 3000, 1015953097]; // fallback version
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket.default ? makeWASocket.default({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ChatDesk', 'Chrome', '120.0'],
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    logger
  }) : makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ChatDesk', 'Chrome', '120.0'],
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    logger
  });

  const presenceChannel = supabase.channel('chatdesk-presence');
  presenceChannel.subscribe((status) => {
    console.log(`[${sessionId}] Canal presenceChannel status: ${status}`);
  });

  sessions.set(sessionId, { sock, qrcode: null, status: 'starting', phone: null, inboxId, presenceChannel });

  // Salvar credenciais quando atualizadas localmente + subir para o storage com debounce leve
  let credsUpdateTimeout = null;
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    // Debounce simples para evitar multiplas chamadas consecutivas no upload do creds.json
    if (credsUpdateTimeout) clearTimeout(credsUpdateTimeout);
    credsUpdateTimeout = setTimeout(async () => {
      await uploadSessionFile(sessionId, path.join(sessionsDir, 'creds.json'));
    }, 2000);
  });

  // Gerenciar atualizações de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        const session = sessions.get(sessionId);
        if (session) {
          session.qrcode = qrBase64;
          session.status = 'waiting_qr';
        }
        console.log(`[${sessionId}] QR Code gerado.`);
      } catch (err) {
        console.error(`[${sessionId}] Erro ao gerar URL do QR Code:`, err);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log(`[${sessionId}] Conexão encerrada. Razão: ${reason}. Reconectar: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => startSession(sessionId, inboxId), 5000);
      } else {
        // Logout manual pelo usuário ou desconexão forçada
        const session = sessions.get(sessionId);
        if (session && session.presenceChannel) {
          supabase.removeChannel(session.presenceChannel);
        }
        sessions.delete(sessionId);
        await updateInboxConnection(inboxId, false);
        await deleteSessionState(sessionId);
        try {
          fs.rmSync(sessionsDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`Erro ao deletar pasta local ${sessionsDir}:`, err);
        }
      }
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0];
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'connected';
        session.phone = phone;
        session.qrcode = null;
        session.connectedAt = new Date().toISOString();
      }

      console.log(`[${sessionId}] Conectado como ${phone}`);
      await updateInboxConnection(inboxId, true);
      
      // Sincronizar todos os arquivos locais no storage para ter um backup completo após conectar
      setTimeout(() => syncSessionDirToStorage(sessionId, sessionsDir), 5000);
    }
  });

  // Receber mensagens
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      await handleIncomingMessage(msg, sessionId, inboxId, sock);
    }
  });

  // Atualizar status de entrega/leitura
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const update of updates) {
      const { key, receipt } = update;
      if (receipt?.readTimestamp) {
        await updateMessageStatus(key.id, 'read');
      } else if (receipt?.receiptTimestamp) {
        await updateMessageStatus(key.id, 'delivered');
      }
    }
  });

  // Ouvir evento de digitação (presence.update) do WhatsApp e repassar via broadcast do Supabase
  sock.ev.on('presence.update', async (data) => {
    const { id, presences } = data;
    if (!presences) return;
    if (id.endsWith('@g.us')) return; // ignora presenças de grupos

    for (const key of Object.keys(presences)) {
      const presenceInfo = presences[key];
      if (presenceInfo) {
        const lastKnown = presenceInfo.lastKnownPresence;
        const phone = key.split('@')[0];
        const isTyping = lastKnown === 'composing' || lastKnown === 'recording';

        presenceChannel.send({
          type: 'broadcast',
          event: 'typing',
          payload: { phone, isTyping }
        }).catch(err => {
          console.error(`[${sessionId}] Erro ao enviar broadcast de presença:`, err);
        });
      }
    }
  });

  // Salvar contatos da agenda se a configuração estiver ativa
  sock.ev.on('contacts.upsert', async (contacts) => {
    try {
      const { data: inbox, error } = await supabase.from('inboxes').select('sync_contacts').eq('id', inboxId).maybeSingle();
      if (inbox && inbox.sync_contacts) {
        // Processar os contatos de forma sequencial com um pequeno delay para evitar Rate Limit
        for (const contact of contacts) {
          if (contact.id && contact.name) {
            const phone = contact.id.split('@')[0];
            if (phone.length > 8 && !phone.includes('g.us')) {
              let url = null;
              try {
                // Tenta buscar a foto. O await garante que não faremos centenas de requisições paralelas.
                url = await sock.profilePictureUrl(contact.id, 'image');
              } catch (e) {
                // Ignorar (contato sem foto ou restrição de privacidade)
              }

              await findOrCreateContact({ phone, name: contact.name, avatar_url: url }).catch(e => {
                console.error(`[${sessionId}] Falha ao salvar contato ${phone}:`, e.message);
              });

              // Pequeno delay (500ms) para proteger o socket
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
        console.log(`[${sessionId}] Sincronizou ${contacts.length} contatos da agenda.`);
      }
    } catch (err) {
      console.error(`[${sessionId}] Erro ao sincronizar contatos:`, err);
    }
  });

  return { status: 'starting', sessionId };
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function getAllSessions() {
  const result = {};
  sessions.forEach((session, id) => {
    result[id] = session.status;
  });
  return result;
}

export async function disconnectSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  try {
    await session.sock.logout();
    if (session.presenceChannel) {
      supabase.removeChannel(session.presenceChannel);
    }
  } catch (err) {
    console.error(`[${sessionId}] Erro ao chamar logout():`, err);
  }
  sessions.delete(sessionId);

  try {
    const sessionsDir = path.join(process.cwd(), 'sessions', sessionId);
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
    await deleteSessionState(sessionId);
  } catch (e) {
    console.error(`[${sessionId}] Erro ao limpar arquivos da sessão:`, e);
  }

  return true;
}
