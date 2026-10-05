// The meeting record, kept in the host's browser, and everything that happens after the meeting.
//
// Linkas has no server: the browser of the person who created the meeting (the host) keeps the record.
// During the call:  every participant's browser sends each piece of its own speech straight to the host's
//                   browser (peer to peer), so "who spoke" is always right. The pieces, the chat and the
//                   joins/leaves are stored in this browser (IndexedDB), so reloading the page loses nothing.
// After the call:   each person's pieces are put together into one recording and transcribed by Gemini ->
//                   a summary is made -> the .txt text -> it goes to everyone still in the call and is
//                   emailed from the host's Gmail. The audio is then deleted.

import * as gemini from './gemini.js';
import * as gmail from './gmail.js';
import { clock, hhmm, isoDate, fileName } from './util.js';

const RATE = 16000;
const MAX_RECIPIENTS = 20;                                  // emails per meeting
const KEEP_DAYS = 30;                                       // finished meetings are forgotten after this
const LINE = '='.repeat(56);

/* ---------- storage: IndexedDB (only in memory if this browser refuses it) ---------- */

const memory = { meetings: new Map(), audio: new Map() };
const memoryStore = name => {
  const m = memory[name];
  return {
    put: (value, key) => m.set(key ?? value.code, structuredClone(value)),
    get: key => structuredClone(m.get(key)),
    getAll: () => [...m.values()].map(v => structuredClone(v)),
    delete: range => [...m.keys()].filter(k => range.includes(k)).forEach(k => m.delete(k)),
  };
};

const dbReady = new Promise(resolve => {
  try {
    const req = indexedDB.open('linkas', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meetings', { keyPath: 'code' });
      req.result.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn('IndexedDB unavailable: the meeting is kept in memory only'); resolve(null); };
  } catch {
    resolve(null);
  }
});

async function db(name, mode, op) {
  const idb = await dbReady;
  if (!idb) return op(memoryStore(name));
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(name, mode);
    const req = op(tx.objectStore(name));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const audioKey = (meta, u) => `${meta.code}/${u.n}`;
const startOf = meta => meta.startedAt || meta.createdAt;

// Saving is batched: at most one write per second per meeting.
const saveTimers = new Map();
export function save(meta, now = false) {
  clearTimeout(saveTimers.get(meta.code));
  saveTimers.delete(meta.code);
  if (!now) {
    saveTimers.set(meta.code, setTimeout(() => save(meta, true), 1000));
    return Promise.resolve();
  }
  return db('meetings', 'readwrite', s => s.put(meta)).catch(err => console.warn('Could not save the meeting', err));
}

export const get = code => db('meetings', 'readonly', s => s.get(code)).catch(() => null);

// The newest meeting this browser hosted (for the lobby card). Old finished ones are removed on the way.
export async function latest() {
  const all = await db('meetings', 'readonly', s => s.getAll()).catch(() => []);
  const old = all.filter(m => m.status === 'done' && Date.now() - startOf(m) > KEEP_DAYS * 864e5);
  for (const m of old) db('meetings', 'readwrite', s => s.delete(IDBKeyRange.only(m.code))).catch(() => {});
  return all.filter(m => !old.includes(m)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

/* ---------- during the call ---------- */

// A new meeting, or the one this browser was already hosting (after a reload).
export async function open({ code, meetingName }) {
  const old = await get(code);
  if (old) return old;
  const meta = {
    code,
    meetingName,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    status: 'recording',     // recording -> processing -> done (or error)
    people: [],              // names of everyone who joined
    recipients: [],          // { name, email }: who gets the email
    entries: [],             // join / leave / chat, with times
    utterances: [],          // { n, id, name, ts, ms, text } one per piece of speech
    stt: null,               // { gemini: pieces done, model }
    mail: {},                // email -> 'sent' | 'failed: reason'
    summary: '',
    hasContent: false,
    text: null,              // the finished transcript
    filename: null,
    error: null,
  };
  await save(meta, true);
  return meta;
}

export function addPerson(meta, { name, email }) {
  meta.startedAt = meta.startedAt || Date.now();
  if (!meta.people.includes(name)) meta.people.push(name);
  if (email && !meta.recipients.some(r => r.email === email)) meta.recipients.push({ name, email });
  save(meta);
}

// join / leave / chat. A join or leave that repeats the last one of that person (a reconnect) is skipped.
export function addEntry(meta, entry) {
  if (meta.status !== 'recording') return;
  if (entry.kind === 'join' || entry.kind === 'leave') {
    const last = meta.entries.findLast(e => e.name === entry.name && (e.kind === 'join' || e.kind === 'leave'));
    if ((last ? last.kind : 'leave') === entry.kind) return;
  }
  meta.entries.push(entry);
  save(meta);
}

// pcm: ArrayBuffer with 16-bit 16 kHz mono samples. ts: when the person started saying it (host's clock).
// id: unique per piece, so a piece sent twice (after a reconnect) is stored once.
export async function addAudio(meta, { id, name, ts, pcm }) {
  if (meta.status !== 'recording' || meta.utterances.some(u => u.id === id)) return;
  const u = { n: meta.utterances.length, id, name, ts, ms: Math.round(pcm.byteLength / 2 / RATE * 1000), text: null };
  meta.utterances.push(u);
  await db('audio', 'readwrite', s => s.put(pcm, audioKey(meta, u)));
  await save(meta, true);
}

/* ---------- after the call ---------- */

// Makes the transcript. report(text) is told how far it is. Can be run again after an error:
// pieces that already have their text are not sent to Gemini again.
export async function finish(meta, report = () => {}) {
  Object.assign(meta, { status: 'processing', error: null, endedAt: meta.endedAt || Date.now() });
  await save(meta, true);
  try {
    await transcribeAll(meta, report);
    const { lines, hasContent } = conversation(meta);
    if (hasContent && gemini.configured()) report('Writing the summary…');
    meta.summary = hasContent ? await summaryOf(meta, lines) : '';
    meta.hasContent = hasContent;
    meta.text = transcriptText(meta, lines, hasContent, meta.summary);
    meta.filename = `(${isoDate(startOf(meta))}) ${fileName(meta.meetingName)}.txt`;
    meta.status = 'done';
    await save(meta, true);
    await db('audio', 'readwrite', s => s.delete(IDBKeyRange.bound(`${meta.code}/`, `${meta.code}/￿`)));
    console.log(`Meeting ${meta.code} done.`);
  } catch (err) {
    console.error(`Processing ${meta.code} failed:`, err);
    Object.assign(meta, { status: 'error', error: err.message });
    await save(meta, true);
  }
  return meta;
}

// 1. speech -> text. Gemini gets one recording per participant, cut into parts of at most GEMINI_PART_MS of
//    speech (so a request stays small and the time stamps stay exact). Every returned sentence is put back on
//    the piece of speech it belongs to, which gives it the real clock time and the speaker's name.
const GEMINI_PART_MS = 5 * 60e3;
const GEMINI_PAUSE_MS = 4000;                   // between requests: the free tier allows only a few per minute
const MAX_PAUSE_MS = 1000;                      // a longer pause between pieces is shortened to this

// Several pieces of one person as a single recording (pauses between them shortened), plus where every
// piece starts inside it (for Gemini's time stamps). Pieces whose audio is gone are skipped.
async function recordingOf(meta, pieces) {
  const parts = [], offsets = [];
  let length = 0, prev = null;
  for (const u of pieces) {
    const buf = await db('audio', 'readonly', s => s.get(audioKey(meta, u)));
    if (buf && prev) {
      const pause = new Uint8Array(Math.round(Math.min(Math.max(u.ts - (prev.ts + prev.ms), 0), MAX_PAUSE_MS) * RATE / 1000) * 2);
      parts.push(pause);
      length += pause.length;
    }
    offsets.push(length / 2 / RATE * 1000);     // ms from the start of the recording
    if (!buf) continue;
    parts.push(new Uint8Array(buf, 0, buf.byteLength - buf.byteLength % 2));
    length += parts[parts.length - 1].length;
    prev = u;
  }
  const pcm = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { pcm.set(p, at); at += p.length; }
  return { pcm, offsets };
}

async function transcribeAll(meta, report) {
  const todo = meta.utterances.filter(u => u.text === null).sort((a, b) => a.ts - b.ts);
  const total = meta.utterances.length;
  let done = total - todo.length;
  meta.stt = meta.stt || { gemini: 0, model: null };
  if (!todo.length) return;
  if (!gemini.configured()) throw new Error('no Gemini API key is set (add it in the lobby, then press "Try again")');
  report(`Transcribing… ${done} of ${total} pieces of speech`);
  let sent = 0;
  for (const name of [...new Set(todo.map(u => u.name))]) {
    const parts = [[]];
    let ms = 0;
    for (const u of todo.filter(x => x.name === name)) {
      if (ms + u.ms > GEMINI_PART_MS && parts[parts.length - 1].length) { parts.push([]); ms = 0; }
      parts[parts.length - 1].push(u);
      ms += u.ms;
    }
    for (const pieces of parts) {
      const { pcm, offsets } = await recordingOf(meta, pieces);
      const texts = pieces.map(() => []);
      if (pcm.length) {
        if (sent++) await new Promise(r => setTimeout(r, GEMINI_PAUSE_MS));
        const { segments, model } = await gemini.transcribe(pcm, { speaker: name, meetingName: meta.meetingName, participants: meta.people });
        meta.stt.model = model;
        for (const seg of segments) {
          let i = 0;
          while (i + 1 < offsets.length && offsets[i + 1] <= seg.ms + 300) i++;
          texts[i].push(seg.text);
        }
      }
      pieces.forEach((u, i) => { u.text = texts[i].join(' '); });
      done += pieces.length;
      meta.stt.gemini += pieces.length;
      await save(meta, true);
      report(`Transcribing… ${done} of ${total} pieces of speech`);
    }
  }
}

// 2. the whole conversation, in the order people started speaking
function formatEntry(e) {
  const t = `[${clock(e.ts)}]`;
  if (e.kind === 'join') return `${t} — ${e.name} prisijungė —`;
  if (e.kind === 'leave') return `${t} — ${e.name} išėjo —`;
  if (e.kind === 'chat') return `${t} ${e.name} (žinutė): ${e.text.replace(/\n/g, '\n           ')}`;
  return `${t} ${e.name}: ${e.text}`;
}

function conversation(meta) {
  const speech = meta.utterances.filter(u => u.text).map(u => ({ kind: 'speech', ts: u.ts, name: u.name, text: u.text }));
  const lines = [...meta.entries, ...speech].sort((a, b) => a.ts - b.ts).map(formatEntry).join('\n');
  return { lines, hasContent: speech.length > 0 || meta.entries.some(e => e.kind === 'chat') };
}

// 3. summary: topics, agreements, action items (the conversation is kept even if this fails)
async function summaryOf(meta, lines) {
  if (!gemini.configured()) return '';
  try {
    return await gemini.summarize({ meetingName: meta.meetingName, participants: meta.people, transcript: lines });
  } catch (err) {
    console.warn(`Summary for ${meta.code} skipped: ${err.message}`);
    return '';
  }
}

function transcriptText(meta, lines, hasContent, summary) {
  const start = startOf(meta);
  const end = meta.endedAt || Date.now();
  const header = [
    'LINKAS · POKALBIO STENOGRAMA',
    LINE,
    `Susitikimas:     ${meta.meetingName}`,
    `Data:            ${isoDate(start)}`,
    `Pradžia:         ${hhmm(start)}`,
    `Pabaiga:         ${hhmm(end)} (trukmė ${Math.max(1, Math.round((end - start) / 60e3))} min.)`,
    `Dalyviai:        ${meta.people.join(', ')}`,
    `Kambario kodas:  ${meta.code}`,
    ...(meta.stt && meta.stt.gemini ? [`Transkripcija:   Gemini (${meta.stt.model || gemini.MODELS[0]})`] : []),
    LINE,
    '',
  ].join('\n');
  return header + '\n'
    + 'POKALBIS\n\n'
    + (hasContent ? lines : `${lines}\n\n(Pokalbio metu niekas nieko nepasakė.)`)
    + (summary ? `\n\n${'-'.repeat(56)}\n\nSANTRAUKA\n\n${summary}` : '')
    + '\n';
}

// 4. one email per participant, from the host's Gmail: the summary in the text, the whole .txt attached.
//    Skips addresses that already got it, so it can simply be run again. No email when nobody said anything.
export async function emailEveryone(meta, report = () => {}) {
  if (meta.status !== 'done' || !meta.hasContent) return;
  const to = meta.recipients.slice(0, MAX_RECIPIENTS).filter(r => meta.mail[r.email] !== 'sent');
  const start = startOf(meta);
  for (const [i, { name, email }] of to.entries()) {
    report(`Sending the emails… ${i + 1} of ${to.length}`);
    try {
      await gmail.sendMail({
        to: email,
        subject: `Linkas: „${meta.meetingName}“ – susitikimo santrauka (${isoDate(start)})`,
        text: [
          `Sveiki, ${name},`,
          '',
          `susitikimas „${meta.meetingName}“ (${isoDate(start)}, ${hhmm(start)}–${hhmm(meta.endedAt || Date.now())}) baigėsi.`,
          `Dalyviai: ${meta.people.join(', ')}.`,
          '',
          meta.summary || 'Visas pokalbis (kas, ką ir kada pasakė) yra prisegtame .txt faile.',
          '',
          meta.summary ? 'Santrauka ir visas pokalbis yra prisegtame .txt faile.\n' : '',
          '— Linkas',
        ].join('\n'),
        filename: meta.filename,
        content: meta.text,
      });
      meta.mail[email] = 'sent';
    } catch (err) {
      console.warn(`Email to ${email} failed: ${err.message}`);
      meta.mail[email] = `failed: ${err.message}`;
    }
  }
  await save(meta, true);
}

// Emails that still have to go out (none sent yet, or some failed).
export const unsentMail = meta => meta.status === 'done' && meta.hasContent
  && meta.recipients.slice(0, MAX_RECIPIENTS).some(r => meta.mail[r.email] !== 'sent');
