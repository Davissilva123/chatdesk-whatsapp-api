import { supabase } from './services/supabase.js';

async function run() {
  console.log("Checking columns in 'inboxes' table...");
  const { data, error } = await supabase.from('inboxes').select('*').limit(1);
  if (error) {
    console.error("Error reading inboxes:", error);
    return;
  }
  
  if (data && data.length > 0) {
    const columns = Object.keys(data[0]);
    console.log("Current columns:", columns);
    const hasAudios = columns.includes('ignore_audios');
    const hasGroups = columns.includes('ignore_groups');
    console.log("Has ignore_audios:", hasAudios);
    console.log("Has ignore_groups:", hasGroups);
    
    if (hasAudios && hasGroups) {
      console.log("MIGRATION_OK");
    } else {
      console.log("MIGRATION_REQUIRED");
    }
  } else {
    console.log("NO_DATA");
  }
}

run();
