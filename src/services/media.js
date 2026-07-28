import { supabase } from './supabase.js';
import { v4 as uuidv4 } from 'uuid';

export async function uploadMediaToStorage(buffer, mimeType, filename) {
  try {
    const ext = filename.split('.').pop() || 'bin';
    const key = `whatsapp/${uuidv4()}.${ext}`;

    const { error } = await supabase.storage
      .from('chatdesk-media')
      .upload(key, buffer, {
        contentType: mimeType,
        upsert: false
      });

    if (error) {
      console.error('Erro ao subir arquivo para o storage do Supabase:', error);
      throw error;
    }

    const { data } = supabase.storage
      .from('chatdesk-media')
      .getPublicUrl(key);

    return data.publicUrl;
  } catch (error) {
    console.error('Erro geral no uploadMediaToStorage:', error);
    throw error;
  }
}
