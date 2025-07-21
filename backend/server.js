// backend/server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = 3000;

// ↳ terima body biner maks. 5 MB
app.use(express.raw({ limit: '5mb', type: '*/*' }));
app.use(cors());

// ↳ Supabase (service‑role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SERVICE_ROLE_KEY
);

// aturan validasi
const MAX_SIZE      = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME  = ['image/png', 'image/jpeg', 'application/pdf'];
const ALLOWED_EXT   = ['png', 'jpg', 'jpeg', 'pdf'];

// --- METADATA (nama & mime) ---
app.get('/api/meta/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const { data, error } = await supabase
      .from('files')
      .select('original_name, mime')
      .eq('id', token)
      .single();
    if (error || !data) throw new Error('metadata tidak ditemukan');
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});


app.post('/api/upload', async (req, res) => {
  try {
    const fileBuffer = req.body;
    if (!fileBuffer?.length) throw new Error('file kosong');
    if (fileBuffer.length > MAX_SIZE) throw new Error('file > 5 MB');

    // MIME asli dikirim dari frontend
    const mime = req.headers['x-mime'];
    if (!ALLOWED_MIME.includes(mime)) throw new Error('MIME tidak valid');

    // nama file asli
    const rawName = decodeURIComponent(req.headers['x-filename'] || '').trim();
    if (!rawName) throw new Error('nama file wajib');
    if (/[^a-zA-Z0-9_.\- ]/.test(rawName))
      throw new Error('nama file ilegal');

    const ext = rawName.split('.').pop().toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) throw new Error('ekstensi dilarang');

    // ===== simpan =====
    const id   = nanoid(12);
    const path = `${id}.bin`;

    // upload ciphertext
    const { error: upErr } = await supabase.storage
      .from('encrypted')
      .upload(path, fileBuffer, { contentType: 'application/octet-stream' });
    if (upErr) throw upErr;

    // metadata
    const expires = new Date(Date.now() + 24 * 3600 * 1000); // 24 jam
    const { error: dbErr } = await supabase
      .from('files')
      .insert({
        id,
        original_name: rawName,
        mime,
        size: fileBuffer.length,
        expires_at: expires,
        used: false
      });
    if (dbErr) throw dbErr;

    res.json({
      token: id,
      downloadUrl: `${process.env.BASE_URL}/download/${id}`
    });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

// ========= ONE‑TIME DOWNLOAD =========
app.get('/download/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const { data: row, error } = await supabase
      .from('files')
      .select('*')
      .eq('id', token)
      .single();

    if (error || !row) throw new Error('token tidak ditemukan');
    if (row.used) throw new Error('token sudah dipakai');
    if (new Date(row.expires_at) < new Date()) throw new Error('token kedaluwarsa');

    await supabase.from('files').update({ used: true }).eq('id', token);

    const { data: signed } = await supabase.storage
      .from('encrypted')
      .createSignedUrl(`${token}.bin`, 60);

    res.redirect(signed.signedUrl);
  } catch (err) {
    console.error('[DOWNLOAD ERROR]', err);
    res.status(404).send(err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Backend aktif → http://localhost:${PORT}`));
