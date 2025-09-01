import fs from "fs/promises";

const API_KEY = process.env.BREVO_API_KEY;
const LIST_ID = Number(process.env.BREVO_LIST_ID);
const SENDER_NAME = process.env.BREVO_SENDER_NAME || "Kernelcut";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;

if (!API_KEY || !LIST_ID || !SENDER_EMAIL) {
  console.error("Missing BREVO_API_KEY / BREVO_LIST_ID / BREVO_SENDER_EMAIL");
  process.exit(1);
}

const BREVO_API = "https://api.brevo.com/v3";

function escapeHtml(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function emailHtmlFromPlaylist(items) {
  // group by category
  const byCat = {};
  for (const it of items) (byCat[it.category_id] ||= []).push(it);

  const section = (title, emoji, id) => {
    const arr = (byCat[id] || []).slice(0, 6); // safety cap per section for email length
    if (!arr.length) return "";
    const rows = arr.map(n => {
      const date = new Date(n.published_at).toISOString().slice(0, 16).replace("T"," ");
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #eee;">
            <div style="font-size:12px;color:#666;margin-bottom:6px;">${emoji} ${escapeHtml(n.source||"")} • ${escapeHtml(n.region||"")} • ${date}Z</div>
            <div style="font-size:16px;font-weight:700;line-height:1.35;margin:0 0 6px;">
              <a href="${n.url}" style="color:#111;text-decoration:underline;">${escapeHtml(n.title||"")}</a>
            </div>
            <div style="font-size:14px;color:#111;line-height:1.55;">${escapeHtml(n.summary_long||"")}</div>
          </td>
        </tr>`;
    }).join("");
    return `
      <tr><td style="padding:18px 0 6px;">
        <div style="font-size:15px;font-weight:700;">${emoji} ${title}</div>
      </td></tr>
      ${rows}
    `;
  };

  const catMeta = [
    ["Tech Titans & Upstarts","🚀","bigtech"],
    ["Next Frontiers (Science & Futurism)","🔬","nextfrontiers"],
    ["Code & Systems","💻","code"],
    ["Design & Creativity","🎨","design"],
    ["AI & Data Realities","📊","ai_data"],
    ["Digital Policy & Society","🌍","policy"],
    ["Fintech & Crypto","💸","fintech"],
    ["Consumer Tech & Gadgets","📱","consumer"],
    ["Space & Exploration","🛰️","space"]
  ];

  const sections = catMeta.map(([t,e,i]) => section(t,e,i)).join("");

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fff;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="680" style="max-width:680px;margin:0 auto;padding:24px 16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;">
          <tr>
            <td style="padding:0 0 12px;">
              <div style="font-size:22px;font-weight:800;">Kernelcut</div>
              <div style="font-size:13px;color:#666;margin-top:2px;">Daily Tech Digest</div>
            </td>
          </tr>
          ${sections}
          <tr><td style="padding:20px 0 0;">
            <div style="font-size:12px;color:#666;line-height:1.5;">
              Sent by ${escapeHtml(SENDER_NAME)} • 06:00 UTC<br/>
              You are receiving this because you subscribed. Unsubscribe link is managed by Brevo.
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function main() {
  // read playlist.json
  const raw = await fs.readFile("playlist.json", "utf8");
  const items = JSON.parse(raw).slice(0, 18);

  const subject = `Kernelcut — Daily Tech Digest (${new Date().toISOString().slice(0,10)})`;
  const htmlContent = emailHtmlFromPlaylist(items);

  // Create campaign
  const createRes = await fetch(`${BREVO_API}/emailCampaigns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": API_KEY
    },
    body: JSON.stringify({
      name: subject,
      subject,
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      type: "classic",
      recipients: { listIds: [LIST_ID] },
      htmlContent
    })
  });

  if (!createRes.ok) {
    const txt = await createRes.text();
    console.error("Create campaign failed:", createRes.status, txt);
    process.exit(1);
  }
  const created = await createRes.json();
  const id = created.id;
  if (!id) {
    console.error("No campaign id returned:", created);
    process.exit(1);
  }

  // Send now
  const sendRes = await fetch(`${BREVO_API}/emailCampaigns/${id}/sendNow`, {
    method: "POST",
    headers: { "api-key": API_KEY }
  });

  if (!sendRes.ok) {
    const txt = await sendRes.text();
    console.error("Send campaign failed:", sendRes.status, txt);
    process.exit(1);
  }

  console.log(`Brevo campaign ${id} created and sent to list ${LIST_ID}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});