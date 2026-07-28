import { supabase } from './services/supabase.js';

async function run() {
  const oldId = '4f262828-a443-4345-9e82-7dff4caee145';
  const newId = '0152f2f7-1413-4496-b6a0-c30d4643d721';

  console.log(`Updating automations pointing to old inbox ID: ${oldId} to new ID: ${newId}`);

  // Fetch automations
  const { data: rules, error } = await supabase.from('automations').select('*');
  if (error) {
    console.error(error);
    return;
  }

  for (const rule of rules) {
    let updated = false;
    const newConditions = rule.conditions.map(cond => {
      if (cond.attribute === 'inbox_id' && cond.value === oldId) {
        cond.value = newId;
        updated = true;
      }
      return cond;
    });

    if (updated) {
      console.log(`Updating rule "${rule.name}"...`);
      const { error: updateError } = await supabase
        .from('automations')
        .update({ conditions: newConditions })
        .eq('id', rule.id);

      if (updateError) {
        console.error(`Error updating rule "${rule.name}":`, updateError);
      } else {
        console.log(`Rule "${rule.name}" updated successfully.`);
      }
    }
  }
}

run();
