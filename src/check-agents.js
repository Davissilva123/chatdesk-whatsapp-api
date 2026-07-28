import { supabase } from './services/supabase.js';

async function check() {
  const { data: agents, error } = await supabase
    .from('agents')
    .select('id, name, email, user_id, role, status');
    
  if (error) {
    console.error("Error fetching agents:", error);
  } else {
    console.log("=== AGENTS IN DATABASE ===");
    console.log(JSON.stringify(agents, null, 2));
  }
}

check();
