import { supabase } from './services/supabase.js';

async function run() {
  console.log("=== AUTOMATIONS ===");
  const { data: automations, error: err } = await supabase.from('automations').select('*');
  if (err) {
    console.error("Error fetching automations:", err);
  } else {
    console.log(JSON.stringify(automations, null, 2));
  }
}

run();
