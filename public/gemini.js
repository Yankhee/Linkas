// The Gemini API (Google, free tier), called straight from the host's browser: speech-to-text for the
// recordings, and the summary. The key is typed in the lobby, stays in this browser and is sent only to Google.

// Flash models, best first. When one is overloaded ("high demand"), over its free limit or retired,
// the next one is used.
export const MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest'];
const BASE = 'https://generativelanguage.googleapis.com';
const RATE = 16000;
const MAX_TRIES = 5;
const MAX_WAIT_MS = 90e3;
const SKIP_MS = 10 * 60e3;                  // a model that just failed is left alone this long
const skipUntil = new Map();                // model -> time
let apiKey = '';

export const setKey = key => { apiKey = String(key || '').trim(); };
export const configured = () => !!apiKey;

const sleep = ms => new Promise(r => setTimeout(r, ms));

class GeminiError extends Error {
  constructor(message, status = 0, retryMs = 0) { super(message); this.status = status; this.retryMs = retryMs; }
}

/* ---------- requests, with retry and backoff ---------- */

async function call(url, options, what, maxTries = MAX_TRIES) {
  for (let attempt = 1; ; attempt++) {
    let err;
    try {
      const res = await fetch(url, { ...options, headers: { 'x-goog-api-key': apiKey, ...options.headers } });
      if (res.ok) return res;
      let info = {};
      try { info = JSON.parse(await res.text()).error || {}; } catch { /* not JSON */ }
      // "retry in 34s" comes back with rate-limit errors
      const delay = (info.details || []).map(d => d.retryDelay).find(Boolean) || res.headers.get('retry-after');
      err = new GeminiError(info.message ? info.message.split('\n')[0].slice(0, 300) : `HTTP ${res.status}`, res.status,
        delay ? parseFloat(delay) * 1000 : 0);
    } catch (e) {
      err = new GeminiError(`could not reach Gemini (${e.message})`);
    }
    // Worth another try: rate limit (429), Google-side trouble (5xx), network problems. Anything else is final.
    const retryable = err.status === 429 || err.status >= 500 || err.status === 0;
    if (!retryable || attempt >= maxTries) {
      console.error(`[gemini] ${what} failed${retryable ? ` after ${attempt} tries` : ''}: ${err.status || 'network'} ${err.message}`);
      throw err;
    }
    const wait = Math.min(err.retryMs || 5000 * 3 ** (attempt - 1), MAX_WAIT_MS);   // 5 s, 15 s, 45 s, 90 s
    console.warn(`[gemini] ${what}: ${err.status === 429 ? 'rate limit reached (429)' : err.message} - try ${attempt} of ${maxTries}, waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
}

// One question to Gemini. The models are tried in order; one that is overloaded / over its limit / gone
// (or gives an unusable answer) hands over to the next. Returns { model, value: parse(answer text) }.
export async function generate({ system, parts, config, what, parse = text => text }) {
  const usable = MODELS.filter(m => (skipUntil.get(m) || 0) < Date.now());
  const order = usable.length ? usable : MODELS;
  for (let i = 0; ; i++) {
    const model = order[i], last = i === order.length - 1;
    try {
      const res = await call(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: config,
        }),
      }, `${what} (${model})`, last ? MAX_TRIES : 2);
      const body = await res.json();
      const cand = (body.candidates || [])[0];
      const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || '').join('');
      if (!text) {
        const why = (body.promptFeedback && body.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty answer';
        console.error(`[gemini] ${what} (${model}): no text returned (${why})`);
        throw new GeminiError(`Gemini returned no text (${why})`);
      }
      return { model, value: parse(text, cand.finishReason) };
    } catch (err) {
      const switchable = err.status === 429 || err.status === 404 || err.status >= 500 || err.status === 0;
      if (last || !switchable) throw err;
      skipUntil.set(model, Date.now() + SKIP_MS);
      console.warn(`[gemini] ${model} is not available right now (${err.status || 'no usable answer'}) - switching to ${order[i + 1]}`);
    }
  }
}

/* ---------- audio: 16 kHz speech as a WAV file (no converter needed in the browser) ---------- */

function wav(pcm) {
  const head = new DataView(new ArrayBuffer(44));
  const text = (at, s) => [...s].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); text(8, 'WAVE');
  text(12, 'fmt '); head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, RATE, true); head.setUint32(28, RATE * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  text(36, 'data'); head.setUint32(40, pcm.byteLength, true);
  return new Blob([head, pcm], { type: 'audio/wav' });
}

const base64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/* ---------- speech-to-text ---------- */

const TRANSCRIBE = `You are a verbatim transcription engine for meeting recordings.

The audio is the microphone of ONE participant of a Lithuanian meeting; pauses between their sentences were shortened.

Rules:
- Transcribe exactly what is said, word for word, in Lithuanian, with correct Lithuanian letters (ą č ę ė į š ų ū ž) and normal punctuation.
- Do NOT translate, summarize, shorten, rephrase or correct what the person says. Keep filler words, repetitions and unfinished sentences.
- Words from other languages (English terms, product names) are written as spoken, not translated.
- Never invent speech: silence, noise, breathing or keyboard sounds produce no text. If a part cannot be understood, write [neaišku].
- Split the transcript into segments: a new segment at every pause, and at least every 15 seconds.
- For every segment give "start": the time in THIS audio file when the segment begins, as MM:SS.

Return only the JSON array of segments, in the order they were spoken. Return an empty array if nobody speaks.`;

const SEGMENTS = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { start: { type: 'STRING' }, text: { type: 'STRING' } },
    required: ['start', 'text'],
  },
};

// "MM:SS", "H:MM:SS" or "MM:SS.mmm" -> milliseconds (null if it is not a time)
function parseTime(s) {
  const m = /^\s*\[?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)\]?\s*$/.exec(String(s));
  return m ? Math.round(((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3].replace(',', '.'))) * 1000) : null;
}

// Gemini's answer -> [{ ms, text }] in spoken order.
function parseSegments(text, finishReason) {
  let list;
  try { list = JSON.parse(text); } catch {
    console.error(`[gemini] the transcript was cut off or is not valid JSON (${finishReason})`);
    throw new GeminiError('Gemini returned an incomplete answer');
  }
  let last = 0;
  return (Array.isArray(list) ? list : []).map(s => {
    const ms = parseTime(s.start);
    last = ms === null ? last : Math.max(last, ms);                   // times never go backwards
    return { ms: last, text: String(s.text || '').replace(/\s+/g, ' ').trim() };
  }).filter(s => s.text && /[\p{L}\p{N}]/u.test(s.text.replace(/\[neaišku\]/gi, '')));
}

// pcm: Uint8Array of 16-bit 16 kHz mono samples with one participant's speech (at most a few minutes,
// so the request stays well under Gemini's 20 MB limit for inline audio).
// Returns { model, segments: [{ ms, text }] }; ms = position in this recording.
export async function transcribe(pcm, { speaker, meetingName, participants = [] }) {
  const data = await base64(wav(pcm));
  console.log(`[gemini] ${speaker}: ${Math.round(pcm.byteLength / 32000)} s of speech, ${(data.length / 1e6).toFixed(1)} MB`);
  const { model, value } = await generate({
    system: TRANSCRIBE,
    parts: [
      { inlineData: { mimeType: 'audio/wav', data } },
      // names help with spelling; they are context only
      { text: `Speaker in this recording: ${speaker}. Meeting: "${meetingName}". Participants: ${participants.join(', ')}. Transcribe this recording.` },
    ],
    config: { temperature: 0, responseMimeType: 'application/json', responseSchema: SEGMENTS },
    what: `transcription of ${speaker}`,
    parse: parseSegments,
  });
  return { model, segments: value };
}

/* ---------- summary: topics, agreements, action items ---------- */

const SUMMARY = `You write the after-meeting summary that Linkas sends to every participant.

You receive an automatic speech-to-text transcript of a Lithuanian meeting. Every line is "[time] Speaker: text" and the speaker names are reliable (each person was recorded separately), but the text can contain recognition mistakes, wrong word endings and missing punctuation: work out what people meant and never copy the errors.
Lines marked "(žinutė)" are messages typed in the chat during the call; treat them as part of the meeting (links, numbers and decisions shared in chat often matter). Lines like "— Name prisijungė —" / "— Name išėjo —" only mark people joining and leaving.

Write in Lithuanian. Plain text only: no Markdown symbols such as #, * or **. Use exactly these three sections, in this order, with these headings:

TEMOS
- one line per topic that was discussed (who raised it, when that matters)

SUTARIMAI
- one line per agreement or decision; if there were none, a single line saying so

VEIKSMŲ PUNKTAI
- Atsakingas asmuo: užduotis (terminas, if one was mentioned)
  Use the speaker's name as the responsible person. If a task has no clear owner, write "Neaiškus atsakingas".
  If there were no action items, a single line saying so.

Only state what the transcript supports. Keep it short: a participant should be able to read it in about a minute.`;

export async function summarize({ meetingName, participants, transcript }) {
  const { value } = await generate({
    system: SUMMARY,
    parts: [{ text: `Meeting: ${meetingName}\nParticipants: ${participants.join(', ')}\n\nTranscript:\n${transcript}` }],
    config: { temperature: 0.2 },
    what: `summary of "${meetingName}"`,
  });
  return value.trim();
}
