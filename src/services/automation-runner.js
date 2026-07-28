import { supabase, insertMessage, updateConversationLastMessage } from './supabase.js';

export async function runAutomations(triggerType, conversation, contact, message, sock) {
  try {
    // 1. Fetch active automations matching the trigger_type or its aliases
    let query = supabase
      .from('automations')
      .select('*')
      .eq('is_active', true);

    if (triggerType === 'conversation_created') {
      // Check if this contact has any other conversation to differentiate created vs opened/reopened
      let isReopened = false;
      try {
        const { data: otherConvs, error: otherError } = await supabase
          .from('conversations')
          .select('id')
          .eq('contact_id', conversation.contact_id || contact.id)
          .neq('id', conversation.id)
          .limit(1);
        
        if (!otherError && otherConvs && otherConvs.length > 0) {
          isReopened = true;
        }
      } catch (err) {
        console.error('[Automation] Error checking conversation history:', err);
      }

      if (isReopened) {
        console.log(`[Automation] Conversation ${conversation.id} is a REOPENED conversation. Loading "conversation_opened" rules.`);
        query = query.eq('trigger_type', 'conversation_opened');
      } else {
        console.log(`[Automation] Conversation ${conversation.id} is a BRAND NEW conversation. Loading "conversation_created" rules.`);
        query = query.eq('trigger_type', 'conversation_created');
      }
    } else if (triggerType === 'message_received') {
      query = query.in('trigger_type', ['message_received', 'message_created']);
    } else {
      query = query.eq('trigger_type', triggerType);
    }

    const { data: rules, error } = await query.order('created_at', { ascending: true });

    if (error) {
      console.error(`[Automation] Error fetching automations for trigger ${triggerType}:`, error);
      return;
    }

    if (!rules || rules.length === 0) {
      return;
    }

    console.log(`[Automation] Running ${rules.length} active rule(s) for trigger ${triggerType}...`);

    for (const rule of rules) {
      // 2. Evaluate conditions against conversation, contact, and message
      const matches = evaluateConditions(rule.conditions, conversation, contact, message);
      if (matches) {
        console.log(`[Automation] Rule "${rule.name}" MATCHED conditions. Executing actions...`);
        // 3. Execute actions
        await executeActions(rule.actions, conversation, contact, sock);
      } else {
        console.log(`[Automation] Rule "${rule.name}" did not match conditions.`);
      }
    }
  } catch (err) {
    console.error(`[Automation] Critical error running automations:`, err);
  }
}

function evaluateConditions(conditions, conversation, contact, message) {
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    return true; // If no conditions are specified, it matches by default.
  }

  for (const cond of conditions) {
    const { attribute, operator, value } = cond;
    if (!attribute || !operator) continue;

    let actualValue = conversation[attribute];
    if (attribute === 'phone_number') {
      actualValue = contact.phone;
    } else if (attribute === 'email') {
      actualValue = contact.email;
    } else if (attribute === 'message_type') {
      actualValue = message ? (message.sender_type === 'contact' ? 'incoming' : 'outgoing') : '';
    } else if (attribute === 'message_contains' || attribute === 'message_exact') {
      actualValue = message ? message.content : '';
    }

    // Normalize comparison
    const expectedValues = Array.isArray(value) 
      ? value.map(v => String(v).trim().toLowerCase())
      : [String(value).trim().toLowerCase()];

    const normalizedActual = String(actualValue || '').trim().toLowerCase();

    let isMatch = false;
    
    if (attribute === 'message_contains') {
      const expected = String(value).trim().toLowerCase();
      const actual = String(actualValue || '').trim().toLowerCase();
      if (operator === 'equal_to') {
        isMatch = actual.includes(expected);
      } else if (operator === 'not_equal_to') {
        isMatch = !actual.includes(expected);
      }
    } else if (attribute === 'message_exact') {
      const expected = String(value).trim().toLowerCase();
      let actual = String(actualValue || '').trim().toLowerCase();
      // Remove potential agent signatures (e.g. "*Davi:*\n1") common in API testing
      actual = actual.replace(/^\*.*?\*\s*\n/, '').trim();
      
      if (operator === 'equal_to') {
        isMatch = actual === expected;
      } else if (operator === 'not_equal_to') {
        isMatch = actual !== expected;
      }
    } else {
      if (operator === 'equal_to') {
        isMatch = expectedValues.includes(normalizedActual);
      } else if (operator === 'not_equal_to') {
        isMatch = !expectedValues.includes(normalizedActual);
      }
    }

    if (!isMatch) {
      return false; // Logical AND: all conditions must match.
    }
  }
  return true;
}

async function executeActions(actions, conversation, contact, sock) {
  if (!actions || !Array.isArray(actions)) return;

  for (const action of actions) {
    const { type, value } = action;
    console.log(`[Automation] Executing action of type: ${type}`);

    try {
      if (type === 'send_message') {
        if (!value) continue;
        const replyContent = value;

        // Determine target phone JID
        let phone = contact.phone;
        let targetJid = phone;
        if (!targetJid.includes('@')) {
          const cleanPhone = phone.replace(/\D/g, '');
          targetJid = `${cleanPhone}@s.whatsapp.net`;
        }

        if (sock) {
          console.log(`[Automation] Sending automated message to ${targetJid}: ${replyContent.substring(0, 50)}...`);
          const result = await sock.sendMessage(targetJid, { text: replyContent });
          const replyWaMsgId = result?.key?.id;

          // Save reply message to database
          const replyTimestamp = new Date().toISOString();
          const insertedReply = await insertMessage({
            conversationId: conversation.id,
            senderType: 'agent',
            senderId: null,
            content: replyContent,
            messageType: 'text',
            waMessageId: replyWaMsgId,
            createdAt: replyTimestamp
          });

          // Update conversation last message info
          await updateConversationLastMessage({
            conversationId: conversation.id,
            preview: replyContent,
            timestamp: insertedReply.created_at || replyTimestamp
          });
        } else {
          console.warn('[Automation] Cannot send automated message: sock is not available');
        }
      } else if (type === 'assign_agent') {
        const assignedAgentId = value;
        console.log(`[Automation] Assigning conversation ${conversation.id} to agent ${assignedAgentId}`);

        const { error: updateError } = await supabase
          .from('conversations')
          .update({ assigned_agent_id: assignedAgentId })
          .eq('id', conversation.id);

        if (updateError) {
          console.error(`[Automation] Error assigning agent:`, updateError);
        } else {
          // Update the local conversation object copy in case other actions depend on it
          conversation.assigned_agent_id = assignedAgentId;
        }
      } else if (type === 'assign_team') {
        const teamId = value;
        console.log(`[Automation] Assigning conversation ${conversation.id} to team ${teamId}`);

        const { error: updateError } = await supabase
          .from('conversations')
          .update({ team_id: teamId })
          .eq('id', conversation.id);

        if (updateError) {
          console.error(`[Automation] Error assigning team:`, updateError);
        } else {
          conversation.team_id = teamId;
        }
      } else if (type === 'resolve_conv' || type === 'resolve_conversation') {
        console.log(`[Automation] Resolving conversation ${conversation.id}`);

        const { error: updateError } = await supabase
          .from('conversations')
          .update({ status: 'resolved' })
          .eq('id', conversation.id);

        if (updateError) {
          console.error(`[Automation] Error resolving conversation:`, updateError);
        } else {
          conversation.status = 'resolved';
        }
      } else if (type === 'mute_conversation' || type === 'snooze_conversation') {
        const newStatus = 'snoozed';
        console.log(`[Automation] Changing status of conversation ${conversation.id} to ${newStatus}`);

        const { error: updateError } = await supabase
          .from('conversations')
          .update({ status: newStatus })
          .eq('id', conversation.id);

        if (updateError) {
          console.error(`[Automation] Error updating conversation status:`, updateError);
        } else {
          conversation.status = newStatus;
        }
      } else if (type === 'change_priority') {
        const priority = value;
        console.log(`[Automation] Changing priority of conversation ${conversation.id} to ${priority}`);

        const { error: updateError } = await supabase
          .from('conversations')
          .update({ priority })
          .eq('id', conversation.id);

        if (updateError) {
          console.error(`[Automation] Error changing conversation priority:`, updateError);
        } else {
          conversation.priority = priority;
        }
      } else if (type === 'add_label') {
        const labelId = value;
        console.log(`[Automation] Adding label ${labelId} to conversation ${conversation.id}`);

        const { data: existingJunction, error: selectJunctionError } = await supabase
          .from('conversation_labels')
          .select('*')
          .eq('conversation_id', conversation.id)
          .eq('label_id', labelId)
          .maybeSingle();

        if (selectJunctionError) {
          console.error('[Automation] Error checking existing conversation label:', selectJunctionError);
        } else if (!existingJunction) {
          const { error: insertJunctionError } = await supabase
            .from('conversation_labels')
            .insert({
              conversation_id: conversation.id,
              label_id: labelId
            });

          if (insertJunctionError) {
            console.error('[Automation] Error inserting conversation label:', insertJunctionError);
          } else {
            console.log(`[Automation] Label ${labelId} successfully added to conversation ${conversation.id}`);
          }
        }
      } else if (type === 'remove_label') {
        const labelId = value;
        console.log(`[Automation] Removing label ${labelId} from conversation ${conversation.id}`);

        const { error: deleteError } = await supabase
          .from('conversation_labels')
          .delete()
          .eq('conversation_id', conversation.id)
          .eq('label_id', labelId);

        if (deleteError) {
          console.error('[Automation] Error deleting conversation label:', deleteError);
        } else {
          console.log(`[Automation] Label ${labelId} successfully removed from conversation ${conversation.id}`);
        }
      }
    } catch (actionErr) {
      console.error(`[Automation] Error executing action ${type}:`, actionErr);
    }
  }
}
