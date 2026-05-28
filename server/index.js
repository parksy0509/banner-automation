const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://jwvlwrcgrjpbguhcghok.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3dmx3cmNncmpwYmd1aGNnaG9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3ODAzMDIsImV4cCI6MjA5NDM1NjMwMn0.4L4fTszQALJluziWszlt8tL9gY8jJz2cJn6ZYofbh-w';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── 슬랙 알림 ────────────────────────────────────────────────────────────
async function sendSlackNotification(data) {
  if (!SLACK_WEBHOOK) return;
  try {
    const bannerType = data.bannerType || '-';
    const requester  = data.requester  || '-';
    const deadline   = data.deadline   || '-';
    const memo       = data.memo       || '-';

    const message = {
      text: '🎨 새 배너 요청이 들어왔어요!',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🎨 새 배너 요청', emoji: true }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*배너 종류*\n' + bannerType },
            { type: 'mrkdwn', text: '*요청자*\n' + requester },
            { type: 'mrkdwn', text: '*마감일*\n' + deadline },
            { type: 'mrkdwn', text: '*메모*\n' + memo }
          ]
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '요청 페이지 확인', emoji: true },
            url: 'https://banner-automation.onrender.com',
            style: 'primary'
          }]
        }
      ]
    };

    const body = JSON.stringify(message);
    const url  = new URL(SLACK_WEBHOOK);
    const mod  = url.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = mod.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, resolve);
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('[슬랙 알림 전송 완료]');
  } catch(e) {
    console.error('[슬랙 알림 실패]', e.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../web')));

// ── 배너 라이브러리 저장 (Supabase 영속화) ──────────────────────────────
app.post('/api/library', async (req, res) => {
  const data = req.body || [];
  const { error } = await supabase
    .from('banner_library')
    .upsert({ id: 'main', data: data, updated_at: new Date().toISOString() });
  if (error) console.error('[라이브러리 저장 실패]', error.message);
  else       console.log('[라이브러리 수신] 배너 수:', data.length);
  res.json({ success: !error });
});

app.get('/api/library', async (req, res) => {
  const { data, error } = await supabase
    .from('banner_library')
    .select('data')
    .eq('id', 'main')
    .single();
  if (error || !data) return res.json([]);
  res.json(data.data || []);
});

// ── 이미지 URL → base64 프록시 ──────────────────────────────────────────
app.post('/api/fetch-image', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url 필드가 필요합니다.' });
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, (imgRes) => {
    const chunks = [];
    imgRes.on('data', (c) => chunks.push(c));
    imgRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct  = imgRes.headers['content-type'] || 'image/png';
      res.json({ base64: 'data:' + ct + ';base64,' + buf.toString('base64') });
    });
    imgRes.on('error', (e) => res.status(500).json({ error: e.message }));
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

// ── 배너 요청 등록 ──────────────────────────────────────────────────────
app.post('/api/request', async (req, res) => {
  const data = req.body;
  if (!data.bannerType) return res.status(400).json({ error: '배너 타입을 선택해주세요.' });

  const { data: row, error } = await supabase
    .from('plugin_requests')
    .insert({ banner_type: data.bannerType, title: data.title || data.bannerType, status: 'pending', payload: data })
    .select('id')
    .single();

  if (error) { console.error('[요청 등록 실패]', error.message); return res.status(500).json({ error: error.message }); }
  console.log('[새 요청] ID:', row.id, '| 배너타입:', data.bannerType);
  sendSlackNotification(data);
  res.json({ success: true, id: row.id });
});

// ── 대기 중 요청 조회 ────────────────────────────────────────────────────
app.get('/api/request/pending', async (req, res) => {
  const { data, error } = await supabase
    .from('plugin_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return res.json(null);
  res.json({ id: data.id, status: data.status, data: data.payload, createdAt: data.created_at });
});

// ── 요청 완료 처리 ──────────────────────────────────────────────────────
app.put('/api/request/:id/done', async (req, res) => {
  const { error } = await supabase
    .from('plugin_requests')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  console.log('[완료] ID:', req.params.id);
  res.json({ success: true });
});

// ── 요청 목록 (최근 20건) ────────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  const { data, error } = await supabase
    .from('plugin_requests')
    .select('id, title, status, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.json([]);
  res.json((data || []).map(r => ({ id: r.id, status: r.status, createdAt: r.created_at, data: { title: r.title } })));
});

app.listen(PORT, () => {
  console.log('\n배너 자동화 서버 시작!');
  console.log('요청 페이지:', 'http://localhost:' + PORT);
  console.log('Supabase:', SUPABASE_URL, '\n');
});
