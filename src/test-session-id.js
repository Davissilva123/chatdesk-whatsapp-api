import { supabase } from './services/supabase.js';

async function run() {
  const { data, error } = await supabase.from('inboxes').select('id, name, wa_session_id, is_connected');
  if (error) console.error(error);
  else console.log(data);
}

run();
