// scripts/sendBrevo.mjs
// Node 20+. Creates a Brevo campaign from docs/playlist.json and sends it now.

import fs from 'fs';

const API = 'https://api.brevo.com/v3';

function getEnv(name, { required = false, trim = true } = {}) {
  let v = process.env[name] ?? '';
  if (trim) v = v.trim();
  if (required && !v) {
    console.error(`[ENV] Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const RAW_KEY          = getEnv('BREVO_API_KEY', { required: true });
const API_KEY          = RAW_KEY.replace(/[\r\n\t"' \u00A0]/g, '').trim();
const RAW_LIST         = getEnv('BREVO_LIST_ID', { required: true });
const LIST_ID_STRIPPED = RAW_LIST.replace(/[^\d]/g, '');
const LIST_ID          = Number(LIST_ID_STRIPPED);
const SENDER_EMAIL     = getEnv('BREVO_SENDER_EMAIL', { required: true });
const SENDER_NAME      = getEnv('BREVO_SENDER_NAME',  { required: true });

if (!LIST_ID || !Number.isFinite(LIST_ID)) {
  console.error(`[ENV] BREVO_LIST_ID must be digits only. Got: "${RAW_LIST}" -> "${LIST_ID_STRIPPED}"`);
  process.exit(1);
}
if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(SENDER_EMAIL)) {
  console.error('[ENV] BREVO_SENDER_EMAIL is not a valid email.');
  process.exit(1);
}

function headers() {
  return { 'api-key': API_KEY, 'content-type': 'application/json' };
}
async function brevo(path, payload, method = 'POST') {
  const url = `${API}/${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: method === 'GET' ? undefined : JSON.stringify(payload || {})
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`[BREVO] ${method} ${path} -> ${res.status}`);
    console.error(json);
    process.exit(1);
  }
  return json;
}

// ---- Load playlist ----
let items = [];
try {
  items = JSON.parse(fs.readFileSync('docs/playlist.json', 'utf8'));
} catch (e) {
  console.error('Failed to read docs/playlist.json:', e.message);
  process.exit(1);
}
if (!Array.isArray(items) || items.length === 0) {
  console.log('No items to send today. Exiting.');
  process.exit(0);
}

// ---- HTML builder (subtítulo, links sublinhados, resumo longo) ----
const today = new Date().toISOString().slice(0,10);
const preheader = 'Long-form summaries. Handpicked hard tech. 06:00 UTC.';
const brand = 'Kernelcut';

function escapeHtml(s){return String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
function stripBareUrls(s=''){
  return String(s)
    // markdown-style links [text](url) -> keep text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1')
    // plain URLs http(s)://... or www. -> remove
    .replace(/\bhttps?:\/\/[^\s<)]+/gi, '')
    .replace(/\bwww\.[^\s<)]+/gi, '')
    .replace(/\s{2,}/g,' ')
    .trim();
}

function catEmoji(cat){
  const m=(cat||'').toLowerCase();
  if (m.includes('startup')||m.includes('titan')) return '🚀';
  if (m.includes('ai')||m.includes('data')||m.includes('research')) return '🧠';
  if (m.includes('program')||m.includes('engineer')||m.includes('dev')) return '🛠️';
  if (m.includes('science')||m.includes('futur')) return '🧪';
  if (m.includes('design')||m.includes('ux')) return '🎨';
  if (m.includes('security')||m.includes('privacy')) return '🔐';
  return '🧭';
}
function guessCategory(i){
  const t = `${i.title} ${(i.summary_long||i.summary||'')}`.toLowerCase();
  if (/ai|llm|model|dataset|benchmark|ml/.test(t)) return 'AI & Data Science';
  if (/gpu|chip|semiconductor|nvidia|tpu|foundry/.test(t)) return 'Big Tech & Startups';
  if (/cloud|aws|gcp|azure|kafka|spark|postgres|sdk|api/.test(t)) return 'Programming & Engineering';
  if (/quantum|robot|space|fusion|bio|materials/.test(t)) return 'Science & Futuristic Technology';
  if (/design|ux|ui|typography|accessibility/.test(t)) return 'Design & UX';
  if (/breach|ransom|privacy|gdpr|security/.test(t)) return 'Security & Privacy';
  return 'Tech';
}

const html = `
<div style="background:#fff;margin:0 auto;max-width:720px;">
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">
    ${escapeHtml(preheader)}
  </div>
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#111;padding:16px 24px;margin:0;mso-line-height-rule:exactly;">
    <div style="margin:0 0 8px 0;">
      <div style="font-size:15px;letter-spacing:.01em;color:#555;">${brand}</div>
      <div style="font-size:12px;color:#888;">Daily Tech Digest — ${today} (UTC)</div>
    </div>

    ${items.map(i=>{
      const cat = i.category || guessCategory(i);
      const emoji = i.emoji || catEmoji(cat);
      // clean, no date here:
      const meta = [i.source, i.region].filter(Boolean).join(' · ');
      const title = escapeHtml(i.title||'');
      const link = i.url ? `<a href="${i.url}" style="text-decoration:underline;color:#111;">${title}</a>` : title;
      const body = stripBareUrls(i.summary_long || i.summary || '');

      return `
        <section style="margin:14px 0 14px;">
          <div style="font-size:13px;color:#888;">${emoji} ${escapeHtml(cat)}</div>
          <h3 style="margin:4px 0 6px 0;font-size:18px;font-weight:600;line-height:1.35;">${link}</h3>
          ${meta ? `<div style="font-size:12px;color:#777;margin:0 0 6px;">${escapeHtml(meta)}</div>` : ``}
          <p style="margin:0 0 8px 0;color:#222;">${escapeHtml(body)}</p>
        </section>
        <hr style="border:none;border-top:1px solid #eee;margin:12px 0;">
      `;
    }).join('')}

    <footer style="font-size:12px;color:#888;margin-top:14px;">
      Sent at 06:00 UTC · Unsubscribe any time.<br>
      © ${new Date().getFullYear()} Kernelcut
    </footer>
  </div>
</div>
`;

// ---- Create + send campaign ----
(async () => {
  console.log(`[BREVO] listIds=[${LIST_ID}] sender="${SENDER_NAME} <${SENDER_EMAIL}>"`);
  console.log(`[BREVO] items=${items.length}`);

  const createPayload = {
    name: `Kernelcut Daily ${today}`,
    subject: 'Kernelcut — Daily Brief',
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    type: 'classic',
    htmlContent: html,
    recipients: { listIds: [LIST_ID] },
    inlineImageActivation: false
  };

  const created = await brevo('emailCampaigns', createPayload, 'POST');
  const id = created?.id;
  if (!id) {
    console.error('[BREVO] Campaign created but no id returned:', created);
    process.exit(1);
  }
  console.log(`[BREVO] Campaign created id=${id}`);

  const sent = await brevo(`emailCampaigns/${id}/sendNow`, {}, 'POST');
  console.log('[BREVO] sendNow response:', sent);

  console.log('[BREVO] Done. Check Brevo → Marketing → Campaigns for delivery details.');
})().catch(err => {
  console.error('[BREVO] Unhandled error:', err);
  process.exit(1);
});