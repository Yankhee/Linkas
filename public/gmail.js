// Sends the after-meeting emails from the Linkas Gmail (GMAIL_SENDER in config.js) with Google's Gmail API,
// called from the host's browser. Google asks the host to sign in with it and allow "Send email on your behalf";
// that permission lasts one hour and is kept only in memory. Needs GOOGLE_CLIENT_ID in config.js; without it
// nothing is emailed.
import { GOOGLE_CLIENT_ID, GMAIL_SENDER } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const configured = !!GOOGLE_CLIENT_ID;
let token = null;   // { value, until }

// Google's sign-in script is loaded ahead of time: its permission window may only open right on a click.
export function preload() {
  if (!configured || document.getElementById('gis')) return;
  document.head.append(Object.assign(document.createElement('script'), { id: 'gis', src: 'https://accounts.google.com/gsi/client', async: true }));
}

const ready = () => !!token && token.until > Date.now() + 60e3;

// Must be called from a click. Resolves true once sending is allowed (the window closes by itself
// when the host already said yes before), false when it was refused or is not set up.
export function authorize() {
  if (!configured) return Promise.resolve(false);
  if (token && token.until > Date.now() + 15 * 60e3) return Promise.resolve(true);
  const oauth = window.google && window.google.accounts && window.google.accounts.oauth2;
  if (!oauth) return Promise.resolve(false);
  return new Promise(resolve => {
    oauth.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      prompt: '',
      login_hint: GMAIL_SENDER,            // Google suggests this account
      callback: r => {
        const ok = !!r.access_token && oauth.hasGrantedAllScopes(r, SCOPE);
        if (ok) token = { value: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve(ok);
      },
      error_callback: () => resolve(false),   // window closed or blocked
    }).requestAccessToken();
  });
}

/* ---------- the email itself (MIME: text + the .txt attached) ---------- */

const utf8 = new TextEncoder();
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64 = text => base64(utf8.encode(text)).replace(/.{1,76}/g, '$&\r\n');
const word = text => `=?UTF-8?B?${base64(utf8.encode(text))}?=`;   // non-ASCII in a header

function message({ to, subject, text, filename, content }) {
  const boundary = `linkas-${crypto.randomUUID()}`;
  return [
    `From: "Linkas" <${GMAIL_SENDER}>`,
    `To: ${to}`,
    `Subject: ${word(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8; name="${word(filename)}"`,
    `Content-Disposition: attachment; filename="${word(filename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(content),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// Throws with a short, readable reason when the email could not be sent.
export async function sendMail(mail) {
  if (!configured) throw new Error('email is not set up (GOOGLE_CLIENT_ID in config.js)');
  if (!ready()) throw new Error('Gmail permission is missing or expired');
  const raw = base64(utf8.encode(message(mail))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let res;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  } catch {
    throw new Error('could not reach Gmail');
  }
  if (res.ok) return;
  let reason = `HTTP ${res.status}`;
  try { reason = (await res.json()).error.message || reason; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) token = null;   // ask Google again next time
  throw new Error(res.status === 401 ? 'the Gmail sign-in expired' : reason.split('\n')[0].slice(0, 300));
}
