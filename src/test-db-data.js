import { supabase } from './services/supabase.js';

async function run() {
  console.log("=== INBOXES ===");
  const { data: inboxes, error: errInboxes } = await supabase.from('inboxes').select('id, name, is_connected');
  if (errInboxes) console.error(errInboxes);
  else console.log(inboxes);

  console.log("=== CONVERSATIONS ===");
  const { data: conversations, error: errConversations } = await supabase.from('conversations').select('id, inbox_id, status').limit(5);
  if (errConversations) console.error(errConversations);
  else console.log(conversations);
}

run();
