import { supabase } from '../services/supabase.js';
import path from 'path';
import fs from 'fs';

// Função para baixar todo o estado da sessão do Supabase Storage
export async function downloadSessionState(sessionId, localDir) {
  try {
    const storagePath = `sessions/${sessionId}`;
    console.log(`[Auth-State] Buscando backup da sessão "${sessionId}" no Supabase Storage...`);
    
    const { data: files, error } = await supabase.storage
      .from('chatdesk-media')
      .list(storagePath);
      
    if (error) {
      // Se der erro porque a pasta ainda não existe, prosseguir
      console.log(`[Auth-State] Nenhuma sessão encontrada ou erro ao listar storage para "${sessionId}":`, error.message);
      return;
    }
    
    if (!files || files.length === 0) {
      console.log(`[Auth-State] Nenhum arquivo de backup encontrado para "${sessionId}" no storage.`);
      return;
    }

    console.log(`[Auth-State] Baixando ${files.length} arquivo(s) de sessão para o disco local...`);
    fs.mkdirSync(localDir, { recursive: true });

    for (const file of files) {
      if (file.name === '.emptyFolderPlaceholder') continue;
      
      const fileKey = `${storagePath}/${file.name}`;
      const localFilePath = path.join(localDir, file.name);

      const { data, error: downloadError } = await supabase.storage
        .from('chatdesk-media')
        .download(fileKey);

      if (downloadError) {
        console.error(`[Auth-State] Erro ao baixar arquivo ${file.name}:`, downloadError);
        continue;
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(localFilePath, buffer);
    }
    console.log(`[Auth-State] Download do estado de "${sessionId}" concluído.`);
  } catch (error) {
    console.error(`[Auth-State] Erro ao carregar backup da sessão "${sessionId}":`, error);
  }
}

// Função para fazer o upload de um arquivo específico da sessão para o Supabase Storage
export async function uploadSessionFile(sessionId, localFilePath) {
  try {
    const filename = path.basename(localFilePath);
    const storagePath = `sessions/${sessionId}/${filename}`;
    const fileBuffer = fs.readFileSync(localFilePath);

    const { error } = await supabase.storage
      .from('chatdesk-media')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/json',
        upsert: true
      });

    if (error) {
      console.error(`[Auth-State] Erro ao enviar ${filename} para storage:`, error.message);
    }
  } catch (error) {
    console.error(`[Auth-State] Erro ao sincronizar arquivo com storage:`, error);
  }
}

export async function deleteSessionState(sessionId) {
  try {
    const storagePath = `sessions/${sessionId}`;
    console.log(`[Auth-State] Removendo arquivos de backup do storage para "${sessionId}"...`);
    
    let hasMore = true;
    while (hasMore) {
      const { data: files, error: listError } = await supabase.storage
        .from('chatdesk-media')
        .list(storagePath, { limit: 1000 });
        
      if (listError || !files || files.length === 0) {
        hasMore = false;
        break;
      }

      const filesToRemove = files.map(file => `${storagePath}/${file.name}`);
      const { error } = await supabase.storage
        .from('chatdesk-media')
        .remove(filesToRemove);

      if (error) {
        console.error(`[Auth-State] Erro ao remover arquivos do storage:`, error.message);
        break;
      }
    }
    console.log(`[Auth-State] Backup no storage para "${sessionId}" removido com sucesso.`);
  } catch (error) {
    console.error(`[Auth-State] Erro ao deletar backup da sessão no storage:`, error);
  }
}
