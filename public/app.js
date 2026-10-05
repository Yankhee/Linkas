// Linkas in the browser: the lobby, the call, the voice recorder and - in the host's browser - the meeting
// record (meeting.js). There is no server: browsers find each other through public relays (Trystero, with
// the handshake encrypted by the PIN), then video, sound, chat and the recorded speech go directly between them.
import { joinRoom, selfId } from './vendor/trystero.mjs';
import { APP_ID, TURN } from './config.js';
import * as gemini from './gemini.js';
import * as gmail from './gmail.js';
import * as meeting from './meeting.js';
import { clock, cleanText, isEmail } from './util.js';

(() => {
  'use strict';

  /* ================= Basics ================= */

  // Every element with an id, looked up once (ui.micBtn, ui.chatList, …).
  const ui = {};
  for (const el of document.querySelectorAll('[id]')) ui[el.id] = el;

  const store = {
    get: k => { try { return localStorage.getItem('linkas:' + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem('linkas:' + k, v); } catch { /* private mode */ } },
  };

  const MAX_PEERS = 8;                     // every browser sends to every other one, so keep calls small
  const JOIN_TIMEOUT_MS = 25000;           // how long a guest looks for the host's browser before giving up
  const FLUSH_WAIT_MS = 8000;              // meeting ended: time for everyone to hand in their last sentence
  const MAX_CLIP_BYTES = 60 * 16000 * 2;   // one piece of speech: at most 60 s of 16 kHz 16-bit audio
  const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  // Avatar colours: deliberately no greens, so people never look like the brand accent.
  const PALETTE = ['#5865f2', '#e67e22', '#eb459e', '#f0b232', '#3ba5e0', '#ed4245', '#9b59b6', '#607d8b'];
  const MIC_OFF = '<svg class="i" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/><path d="M3 3l18 18"/></svg>';
  const CAM_OFF = '<svg class="i" viewBox="0 0 24 24"><path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M3 3l18 18"/></svg>';

  const state = {
    code: null, pin: '', name: '', email: '', selfId, joinedAt: 0,
    host: false,                // this browser created the meeting: it keeps the record and makes the transcript
    hostId: null,               // the host's peer id (as a guest sees it)
    inCall: false, ended: false,
    room: null, act: {},        // the peer-to-peer room and its message types
    meta: null,                 // host only: the meeting record (meeting.js)
    people: new Map(),          // host only: peer id -> { name, email, here, offset (their clock minus ours) }
    chat: [],                   // host only: chat history for people who join later
    result: null,               // guest: the finished transcript { filename, text }, sent by the host
    local: new MediaStream(),   // microphone + camera
    screen: null,               // screen share stream, while presenting
    mic: false, cam: false, sharing: false,
    peers: new Map(),           // peer id -> peer in the call
    selfTile: null,
  };

  // The Gemini key (host only) is kept in this browser and sent only to Google.
  ui.geminiKey.value = store.get('geminiKey') || '';
  gemini.setKey(ui.geminiKey.value);
  function useGeminiKey() {
    const key = ui.geminiKey.value.trim();
    store.set('geminiKey', key);
    gemini.setKey(key);
    return key;
  }

  function toast(msg, ms = 3500) {
    const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    ui.toasts.append(t);
    setTimeout(() => t.remove(), ms);
  }

  function colorFor(s) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
  const displayName = (name, self) => (self ? `${name} (you)` : name);

  /* ================= Lobby ================= */

  const createPin = pinInput(ui.createPin);
  const joinPin = pinInput(ui.joinPin);
  ui.name.value = store.get('name') || '';
  ui.email.value = store.get('email') || '';

  function pinInput(el) {
    const boxes = [...el.querySelectorAll('input')];
    boxes.forEach((box, i) => {
      const prev = boxes[i - 1], next = boxes[i + 1];
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        if (box.value && next) next.focus();
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && prev) { e.preventDefault(); prev.value = ''; prev.focus(); }
        if (e.key === 'ArrowLeft' && prev) prev.focus();
        if (e.key === 'ArrowRight' && next) next.focus();
      });
      box.addEventListener('paste', e => {
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, boxes.length);
        if (!digits) return;
        e.preventDefault();
        boxes.forEach((b, j) => { b.value = digits[j] || ''; });
        boxes[Math.min(digits.length, boxes.length - 1)].focus();
      });
      box.addEventListener('focus', () => box.select());
    });
    return {
      get: () => boxes.map(b => b.value).join(''),
      set: v => boxes.forEach((b, i) => { b.value = v[i] || ''; }),
      clear() { this.set(''); boxes[0].focus(); },
      focus: () => boxes[0].focus(),
      shake() { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); },
    };
  }

  const tabs = document.querySelectorAll('.tab');
  function setTab(tab) {
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    ui.createForm.hidden = tab !== 'create';
    ui.joinForm.hidden = tab !== 'join';
    setError('');
  }
  tabs.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  const setError = msg => { ui.lobbyError.textContent = msg; };
  const lobbyButtons = document.querySelectorAll('.lobby .btn.primary');
  const setBusy = busy => lobbyButtons.forEach(b => {
    b.dataset.label = b.dataset.label || b.textContent;
    b.disabled = busy;
    b.textContent = busy ? 'Connecting…' : b.dataset.label;
  });

  ui.randomPin.addEventListener('click', () => {
    createPin.set(String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0'));
  });

  function readName() {
    const name = ui.name.value.trim();
    if (!name) { ui.name.focus(); setError('Enter your name first.'); return null; }
    store.set('name', name);
    return name;
  }

  // Only used to send you the summary after the meeting (no account is created).
  function readEmail() {
    const email = ui.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      ui.email.focus();
      setError(email ? 'That email address doesn’t look right.' : 'Enter your email — the summary is sent there after the meeting.');
      return null;
    }
    store.set('email', email);
    return email;
  }

  function normalizeCode(v) {
    const m = v.match(/room=([a-z-]+)/i);
    const code = (m ? m[1] : v).trim().toLowerCase().replace(/\s+/g, '');
    return /^[a-z]{10}$/.test(code) ? `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}` : code;
  }

  ui.code.addEventListener('blur', () => { ui.code.value = normalizeCode(ui.code.value); });

  const params = new URLSearchParams(location.search);
  if (params.has('left') || params.has('ended')) {
    toast(params.has('ended') ? 'The meeting has ended.' : 'You left the meeting.');
    history.replaceState(null, '', location.pathname);
  }
  if (params.get('room')) {
    setTab('join');
    ui.code.value = params.get('room');
    if (!ui.name.value) ui.name.focus();
    else if (!ui.email.value) ui.email.focus();
    else joinPin.focus();
  }

  /* ---------- "Last meeting" card ---------- */
  // Guests: the transcript the host's browser sent at the end of the call (it is also emailed).
  // Host: the meeting record kept in this browser - download it, or finish what was not finished
  // (the tab was closed too early, Gemini failed, an email could not be sent).

  const LAST_MEETING_TTL = 7 * 24 * 3600e3;
  let lastAction = null;

  // extra: { filename, text } or { error } once the transcript arrived (guests).
  function saveLastMeeting(extra = {}) {
    const old = readLastMeeting();
    const same = old && old.code === state.code ? old : { at: Date.now() };
    store.set('last', JSON.stringify({ ...same, code: state.code, name: ui.meetingTitle.textContent, host: state.host, ...extra }));
  }
  function readLastMeeting() {
    try {
      const m = JSON.parse(store.get('last') || 'null');
      return m && m.code && Date.now() - m.at < LAST_MEETING_TTL ? m : null;
    } catch {
      return null;
    }
  }

  // mode: 'ready' (download works), 'busy' (being made) or nothing (no download button).
  function setLastStatus(text, mode) {
    ui.lastDownload.hidden = !mode;
    ui.lastDownload.disabled = mode !== 'ready';
    ui.lastDownload.classList.toggle('waiting', mode === 'busy');
    ui.lastDownload.querySelector('span').textContent = mode === 'busy' ? 'Processing' : 'Download summary';
    ui.lastStatus.textContent = text;
  }
  function setLastAction(label, run) {
    ui.lastAction.hidden = !label;
    ui.lastAction.textContent = label || '';
    lastAction = run || null;
  }

  async function renderLastMeeting() {
    const m = readLastMeeting();
    ui.lastMeeting.hidden = !m;
    if (!m) return;
    const when = new Date(m.at);
    const day = when.toDateString() === new Date().toDateString() ? 'today' : when.toLocaleDateString();
    ui.lastWhen.textContent = `Last meeting · ${day} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    ui.lastName.textContent = ui.lastName.title = m.name;   // full name on hover when it's shortened
    setLastAction(null);
    ui.lastMeeting.classList.toggle('mail-failed', !!m.error);
    if (!m.host) {
      if (m.text) setLastStatus('Ready to download.', 'ready');
      else if (m.error) setLastStatus(`The transcript could not be made: ${m.error}`);
      else setLastStatus(m.mail ? 'The host’s browser makes the transcript and emails it to you.'
        : 'The host has no emails set up: the transcript went only to those still in the call. Ask the host for it.');
      return;
    }
    const meta = await meeting.get(m.code);
    if (meta) renderHostCard(meta);
    else setLastStatus('This meeting is no longer stored in this browser.');
  }

  function renderHostCard(meta) {
    const mail = Object.values(meta.mail);
    const sent = mail.filter(s => s === 'sent').length;
    const failed = mail.some(s => s.startsWith('failed'));
    ui.lastMeeting.classList.toggle('mail-failed', failed || meta.status === 'error');
    if (meta.status === 'done') {
      setLastStatus(failed ? 'Some emails could not be sent — download the summary here.'
        : sent ? `Ready. Emailed to ${sent} ${sent === 1 ? 'person' : 'people'}.` : 'Ready to download.', 'ready');
      if (gmail.configured && meeting.unsentMail(meta)) setLastAction(sent || failed ? 'Send again' : 'Email it', () => runAfterMeeting(meta, false));
    } else if (meta.status === 'error') {
      setLastStatus(`Transcription failed: ${meta.error}`);
      setLastAction('Try again', () => runAfterMeeting(meta, true));
    } else {   // the tab was closed during the call or while the transcript was being made
      setLastStatus(meta.status === 'recording' ? 'Not ended yet: join it again below (same code and PIN), or make the transcript now.' : 'The transcript was not finished.');
      setLastAction('Make it now', () => runAfterMeeting(meta, true));
    }
    if (gmail.configured && lastAction) gmail.preload();
  }

  // From the card: (re)make the transcript and/or send the emails. Runs on a click, so Google can ask for Gmail.
  async function runAfterMeeting(meta, transcribe) {
    const mailAllowed = gmail.authorize();
    useGeminiKey();
    setLastAction(null);
    const report = text => setLastStatus(text, 'busy');
    if (transcribe) {
      report('Starting…');
      await meeting.finish(meta, report);
    }
    if (meta.status === 'done' && await mailAllowed) await meeting.emailEveryone(meta, report);
    renderHostCard(meta);
  }

  ui.lastDownload.addEventListener('click', async () => {
    const m = readLastMeeting();
    const done = m && (m.host ? await meeting.get(m.code) : m);
    if (done && done.text) saveTextFile(done.filename, done.text);
  });
  ui.lastAction.addEventListener('click', () => lastAction && lastAction());
  ui.lastDismiss.addEventListener('click', () => { store.set('last', ''); renderLastMeeting(); });
  renderLastMeeting();

  ui.createForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = readName();
    const email = name && readEmail();
    if (!email) return;
    const pin = createPin.get();
    if (pin.length !== 4) { createPin.shake(); return setError('Choose a 4-digit PIN.'); }
    if (!useGeminiKey()) { ui.geminiKey.focus(); return setError('Enter your Gemini API key — the transcript is made with it.'); }
    enterRoom({ code: newCode(), pin, name, email, host: true, meetingName: cleanText(ui.meetingName.value, 60) || 'Linkas meeting' });
  });

  ui.joinForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = readName();
    const email = name && readEmail();
    if (!email) return;
    const code = normalizeCode(ui.code.value);
    if (!code) { ui.code.focus(); return setError('Enter the meeting code.'); }
    const pin = joinPin.get();
    if (pin.length !== 4) { joinPin.shake(); return setError('Enter the 4-digit PIN.'); }
    enterRoom({ code, pin, name, email });
  });

  // A random meeting code like abc-defg-hjk (letters that cannot be mixed up).
  function newCode() {
    const abc = 'abcdefghjkmnpqrstuvwxyz';
    const part = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => abc[b % abc.length]).join('');
    return `${part(3)}-${part(4)}-${part(3)}`;
  }

  /* ================= Joining ================= */

  let joining = null;   // a guest waiting for the host's browser to let them in: { finish, asked }

  async function enterRoom({ code, pin, name, email, host = false, meetingName = '' }) {
    setBusy(true);
    setError('');
    // This browser created this meeting (the page was reloaded or closed): it carries on as the host.
    const own = host ? null : await meeting.get(code);
    if (own) {
      if (own.status !== 'recording') { setBusy(false); return setError('This meeting has ended. Its transcript is in the card above.'); }
      host = true;
      meetingName = own.meetingName;
    }
    Object.assign(state, { code, pin, name, email, host });
    openRoom(code, pin);

    if (host) {
      state.meta = await meeting.open({ code, meetingName });
      meeting.addPerson(state.meta, { name, email });
      meeting.addEntry(state.meta, { kind: 'join', ts: Date.now(), name });
      state.chat = state.meta.entries.filter(e => e.kind === 'chat')
        .map(e => ({ id: e.name === name ? selfId : e.name, name: e.name, time: clock(e.ts), text: e.text }));
      gmail.preload();
      return startCall({ name, meetingName, chat: state.chat, mail: gmail.configured });
    }

    const res = await findHost();
    if (res.error) {
      await closeRoom();
      setBusy(false);
      setError(res.error);
      if (res.badPin) { joinPin.shake(); joinPin.clear(); }
      if (res.badEmail) ui.email.focus();
      return;
    }
    startCall(res);
  }

  // A guest: wait until the host's browser answers. It checks that the meeting is still on and not full,
  // and gives us a name nobody else in the call has.
  function findHost() {
    return new Promise(resolve => {
      const timer = setTimeout(() => finish({
        error: 'Could not reach the meeting. Check the code and PIN — and the host must be in the call.',
      }), JOIN_TIMEOUT_MS);
      const finish = res => { clearTimeout(timer); joining = null; resolve(res); };
      joining = { finish, asked: false };
    });
  }

  async function askHost(hostId) {
    if (!joining || joining.asked) return;
    joining.asked = true;
    try {
      const res = await state.act.join.request({ name: state.name, email: state.email }, { target: hostId, timeoutMs: 15000 });
      if (joining) joining.finish(res && typeof res === 'object' ? res : { error: 'The host’s browser gave no answer.' });
    } catch {
      if (joining) joining.asked = false;   // the host went away meanwhile: ask again when they are back
    }
  }

  function onJoinError({ error = '' }) {
    if (/password/i.test(error)) {
      if (joining) joining.finish({ error: 'Wrong PIN.', badPin: true });
    } else if (state.inCall && /connect|turn|ice/i.test(error)) {
      toast('Could not connect to someone: their network blocks direct calls (a TURN server is needed, see README).', 8000);
    }
  }

  function startCall({ name, meetingName, chat = [], mail = false }) {
    Object.assign(state, { name: cleanText(name, 40) || state.name, joinedAt: Date.now(), inCall: true });
    meetingName = cleanText(meetingName, 60) || 'Linkas meeting';
    history.replaceState(null, '', '?room=' + state.code);
    document.title = `${meetingName} · Linkas`;
    ui.meetingTitle.textContent = meetingName;
    ui.roomCode.textContent = state.code;
    saveLastMeeting({ mail: !!mail });
    ui.lobby.hidden = true;
    ui.call.hidden = false;
    if (!navigator.mediaDevices?.getDisplayMedia) ui.screenBtn.hidden = true;
    setPanel(null);

    state.selfTile = createTile(state.name, true);
    (Array.isArray(chat) ? chat : []).slice(-200).forEach(m => renderChat({
      id: String(m.id), name: cleanText(m.name, 40), time: String(m.time).slice(0, 8), text: cleanChat(m.text),
    }));
    announce();                                        // "I am in the call" to everyone already connected
    for (const [id, h] of known) if (h.inCall) upsertPeer(id, h, true);
    updateCount();
    startClock();

    // Everyone joins with camera and microphone off; the browser only asks for them when turned on.
    refreshSelf({ video: true });
    renderRecStatus();
    toast('You joined with your camera and microphone off.');
    if (!rec.supported) toast('This browser cannot record your voice, so it will be missing from the transcript. Use a current Chrome, Edge or Safari.', 8000);
  }

  // Which microphone to use. Browsers otherwise take the system "default", which is often the laptop's
  // built-in one even when a headset is worn: muting the headset then does nothing, people still hear you.
  let micId = store.get('mic') || null;
  const micLive = () => state.mic && !state.micSilent;   // on in the app AND not muted on the device itself

  async function openDevice(kind) {
    // Echo cancellation + noise suppression give the other people a cleaner voice.
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (kind === 'video') return navigator.mediaDevices.getUserMedia({ video: VIDEO });
    if (micId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: micId } } });
      } catch (err) {
        if (!['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw err;
        micId = null;                             // the chosen microphone is unplugged: use the default one
        store.set('mic', '');
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio });
  }

  // Asks the browser for the microphone ('audio') or camera ('video') and adds it to our stream.
  async function acquire(kind) {
    const device = kind === 'audio' ? 'microphone' : 'camera';
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Camera and microphone need HTTPS (or localhost).', 6000);
      return null;
    }
    try {
      const track = (await openDevice(kind)).getTracks()[0];
      state.local.addTrack(track);
      track.addEventListener('ended', () => deviceLost(track));
      if (kind === 'audio') {
        // The device's own mute button / the system muted the microphone: show it like a normal mute.
        state.micSilent = track.muted;
        const silent = on => () => {
          if (!state.local.getTracks().includes(track)) return;
          state.micSilent = on;
          refreshSelf();
          if (state.mic) toast(on ? 'Your microphone is muted on the device itself.' : 'Your microphone is working again.', 5000);
        };
        track.addEventListener('mute', silent(true));
        track.addEventListener('unmute', silent(false));
      }
      return track;
    } catch (err) {
      console.warn('getUserMedia failed', kind, err.name);
      toast(err.name === 'NotAllowedError' ? `Access to the ${device} is blocked. Allow it with the icon in the address bar.`
        : err.name === 'NotFoundError' ? `No ${device} was found on this device.`
          : err.name === 'NotReadableError' ? `The ${device} is being used by another app.`
            : `Could not start the ${device}.`, 6000);
      return null;
    }
  }

  // The microphone or camera was unplugged (or the browser took it away) in the middle of the call.
  function deviceLost(track) {
    if (!state.local.getTracks().includes(track)) return;   // we stopped it ourselves
    state.local.removeTrack(track);
    if (track.kind === 'audio') {
      state.mic = false;
      stopRecorder();
      syncSenders();
      refreshSelf();
      renderRecStatus();
      toast('Your microphone was disconnected.', 6000);
    } else {
      state.cam = false;
      applyEffect();
      toast('Your camera was disconnected.', 6000);
    }
  }

  /* ================= Peer to peer ================= */
  // Trystero finds the other browsers of this meeting (meeting code = room, PIN = password that encrypts the
  // handshake) and connects to each of them directly; a dropped connection is re-made by itself.
  // On top of that connection Linkas sends these messages:
  //   hello     name, mic / camera / screen, "I am the host", "I am in the call"   (to everyone)
  //   join      guest -> host: name + email; the host answers with the name to use, meeting name, chat
  //   chat      one chat message                                                   (to everyone)
  //   clip      one piece of the sender's speech -> host, who answers once it is stored
  //   end       host -> everyone: the meeting is over;   flushed: guest -> host: my last speech is handed in
  //   progress  host -> everyone: how far the transcript is;   result: the finished transcript

  const known = new Map();     // peer id -> their latest hello (also people who are not in the call yet)
  const streams = new Map();   // peer id -> their media, when it arrives before their hello
  const noop = () => {};

  function openRoom(code, pin) {
    const room = joinRoom({ appId: APP_ID, password: pin, turnConfig: TURN }, code, { onJoinError });
    const message = (name, onMessage) => room.makeAction(name, { onMessage });
    state.room = room;
    state.act = {
      hello: message('hello', onHello),
      chat: message('chat', onChat),
      end: message('end', onEnd),
      flushed: message('flushed', onFlushed),
      progress: message('progress', onProgress),
      result: message('result', onResult),
      join: room.makeAction('join', { kind: 'request', onRequest: onJoinRequest }),
      clip: room.makeAction('clip', { kind: 'request', onRequest: onClip, onReceive: ({ byteLength }) => byteLength <= MAX_CLIP_BYTES }),
    };
    room.onPeerJoin = id => announce(id);
    room.onPeerLeave = onPeerLeave;
    room.onPeerStream = (stream, id) => {
      streams.set(id, stream);
      const peer = state.peers.get(id);
      if (peer) showStream(peer, stream);
    };
  }

  async function closeRoom() {
    const { room } = state;
    Object.assign(state, { room: null, act: {}, hostId: null });
    known.clear();
    streams.clear();
    if (room) await room.leave().catch(noop);
  }

  const mediaState = () => ({ mic: micLive(), cam: state.cam, screen: state.sharing });
  const hello = () => ({ name: state.name, host: state.host, inCall: state.inCall && !state.ended, now: Date.now(), ...mediaState() });
  function announce(target) {
    if (state.act.hello) state.act.hello.send(hello(), target ? { target } : {}).catch(noop);
  }

  function onHello(h, { peerId }) {
    if (!h || typeof h !== 'object') return;
    h = { name: cleanText(h.name, 40) || 'Guest', host: !!h.host, inCall: !!h.inCall, now: Number(h.now) || Date.now(),
      mic: !!h.mic, cam: !!h.cam, screen: !!h.screen };
    known.set(peerId, h);
    // The first host stays the host while connected (nobody else in the call can take over).
    if (h.host && !state.host && (!state.hostId || state.hostId === peerId || !known.has(state.hostId))) {
      state.hostId = peerId;
      askHost(peerId);
      flushClips();              // speech recorded while the host was away
    }
    if (state.host) hostSaw(peerId, h);
    if (state.inCall && h.inCall) upsertPeer(peerId, h);
  }

  function onPeerLeave(id) {
    known.delete(id);
    streams.delete(id);
    if (state.host) hostLost(id);
    if (flushWait.left && flushWait.left.delete(id) && !flushWait.left.size) flushWait.done();
    const peer = state.peers.get(id);
    if (peer) {
      if (!state.ended) toast(`${peer.name} left`);
      removePeer(id);
      updateCount();
    }
    if (id !== state.hostId) return;
    state.hostId = null;
    if (state.ended && !state.result) setEndStatus('The host left before the transcript was ready. They can finish it later; it is then emailed to you.');
    else if (state.inCall && !state.ended) toast('The host’s connection dropped. Your speech is kept until they are back.', 6000);
  }

  /* ---------- media ---------- */

  function currentTrack(kind) {
    if (kind === 'video' && state.sharing) return state.screen.getVideoTracks()[0] || null;
    if (kind === 'video' && effects.pipeline) return effects.pipeline.track;   // background blur on
    return (kind === 'audio' ? state.local.getAudioTracks() : state.local.getVideoTracks())[0] || null;
  }

  // Every connection gets one audio and one video slot, opened once with silent placeholders. Camera on/off,
  // mute and screen sharing then only swap what is sent through them, without renegotiating.
  let slotStream = null;
  async function connectMedia(peer) {
    if (peer.senders || !state.room) return;
    peer.senders = {};
    if (!slotStream) {
      const audio = getAudioCtx().createMediaStreamDestination().stream.getAudioTracks()[0];
      const canvas = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
      canvas.getContext('2d');
      slotStream = new MediaStream([audio, canvas.captureStream(0).getVideoTracks()[0]]);
    }
    try {
      await Promise.all(state.room.addStream(slotStream, { target: peer.id }));
    } catch (err) {
      console.warn('Could not send media to', peer.name, err);
      return;
    }
    const pc = state.room && state.room.getPeers()[peer.id];
    if (!pc) return;
    for (const s of pc.getSenders()) if (s.track && slotStream.getTracks().includes(s.track)) peer.senders[s.track.kind] = s;
    await attachTracks(peer);
    setTimeout(tuneVideo, 2000);   // the video settings exist once the connection is set up
  }

  function attachTracks(peer) {
    return Promise.all(Object.entries(peer.senders || {}).map(([kind, sender]) => {
      const track = currentTrack(kind);
      return sender.track === track ? null : sender.replaceTrack(track).catch(err => console.warn(err));
    }));
  }
  const syncSenders = () => Promise.all([...state.peers.values()].map(attachTracks)).then(tuneVideo);

  // No server mixes the video: every browser sends its own copy to every other one. The more people, the less
  // each copy may use, so a home upload keeps up (screen sharing gets more, so text stays sharp).
  function tuneVideo() {
    const n = Math.min(state.peers.size, 4);
    const kbps = n && (state.sharing ? [2500, 1500, 1500, 1000] : [1500, 800, 800, 450])[n - 1];
    for (const peer of state.peers.values()) {
      const sender = peer.senders && peer.senders.video;
      if (!sender || !kbps) continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length || p.encodings[0].maxBitrate === kbps * 1000) continue;
      p.encodings[0].maxBitrate = kbps * 1000;
      sender.setParameters(p).catch(noop);
    }
  }

  /* ---------- people in the call ---------- */

  function upsertPeer(id, h, quiet = false) {
    let peer = state.peers.get(id);
    if (!peer) {
      peer = addPeer({ id, ...h });
      if (!quiet && !state.ended) toast(`${h.name} joined`);
      updateCount();
      connectMedia(peer);
      if (streams.has(id)) showStream(peer, streams.get(id));
      return;
    }
    if (peer.name !== h.name) renamePeer(peer, h.name);
    Object.assign(peer, { mic: h.mic, cam: h.cam, screen: h.screen });
    paintPeer(peer);
  }

  function addPeer({ id, name = 'Guest', mic = false, cam = false, screen = false }) {
    const tile = createTile(name, false);
    const peer = { id, name, tile, stream: null, mic, cam, screen, senders: null };
    state.peers.set(id, peer);
    tile.el.classList.add('connecting');
    paintPeer(peer);
    return peer;
  }

  function showStream(peer, stream) {
    const { tile } = peer;
    peer.stream = stream;
    tile.el.classList.remove('connecting');
    tile.video.srcObject = stream;                 // muted: shows only the picture
    tile.video.play().catch(() => {});
    tile.audio.srcObject = stream;                 // plays only the sound
    playAudio(tile.audio);
    if (stream.getAudioTracks().length) watchAudio(tile, stream);
  }

  function renamePeer(peer, name) {
    peer.name = name;
    const avatar = peer.tile.el.querySelector('.avatar span');
    avatar.textContent = initials(name);
    avatar.style.background = colorFor(name);
    peer.tile.el.querySelector('.tag-name').textContent = name;
  }

  function removePeer(id) {
    const peer = state.peers.get(id);
    if (!peer) return;
    removeTile(peer.tile);
    state.peers.delete(id);
  }

  /* ---------- the host keeps the record ---------- */

  // A guest asks to come in. Answered only by the host's browser.
  function onJoinRequest(data, { peerId }) {
    if (!state.host || !state.meta) throw new Error('not the host');
    if (state.ended) return { error: 'This meeting has ended.' };
    const email = String((data && data.email) || '').trim().toLowerCase();
    if (email.length > 120 || !isEmail(email)) return { error: 'Enter a valid email address — the summary is sent there.', badEmail: true };
    const others = [...state.people].filter(([id, p]) => p.here && id !== peerId).map(([, p]) => p.name);
    if (others.length + 1 >= MAX_PEERS) return { error: `This meeting is full (max ${MAX_PEERS} people).` };
    const old = state.people.get(peerId);
    const name = old ? old.name : uniqueName(cleanText(data && data.name, 32) || 'Guest', others);
    state.people.set(peerId, { offset: 0, ...old, name, email, here: true });
    meeting.addPerson(state.meta, { name, email });
    meeting.addEntry(state.meta, { kind: 'join', ts: Date.now(), name });
    return { name, meetingName: state.meta.meetingName, chat: state.chat.slice(-200), mail: gmail.configured };
  }

  // Two people in the call never share a name, so the transcript always shows who spoke.
  function uniqueName(base, taken) {
    const names = new Set([state.name, ...taken]);
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
    return name;
  }

  // Hellos keep the host's list right (also after the host's page was reloaded) and tell how far the
  // other person's clock is from ours, so all speech is put on one clock.
  function hostSaw(peerId, h) {
    let p = state.people.get(peerId);
    if (!p && !h.inCall) return;
    if (!p) {
      p = { name: h.name, email: '' };
      state.people.set(peerId, p);
      meeting.addPerson(state.meta, { name: h.name });
    }
    p.offset = Date.now() - h.now;
    if (h.inCall && !p.here) {
      p.here = true;
      meeting.addEntry(state.meta, { kind: 'join', ts: Date.now(), name: p.name });
    }
  }

  function hostLost(peerId) {
    const p = state.people.get(peerId);
    if (!p || !p.here) return;
    p.here = false;
    meeting.addEntry(state.meta, { kind: 'leave', ts: Date.now(), name: p.name });
  }

  // One piece of a guest's speech. Stored, then confirmed, so the guest can forget it.
  async function onClip(data, { peerId, metadata }) {
    const p = state.people.get(peerId);
    if (!state.host || !state.meta || !p) throw new Error('not in this meeting');
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)   // (arrives as bytes)
      : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    const ok = bytes && bytes.length >= 3200 && bytes.length <= MAX_CLIP_BYTES && bytes.length % 2 === 0;
    if (ok && metadata) {
      const ts = Math.min(Number(metadata.at) + (p.offset || 0), Date.now()) || Date.now();
      await meeting.addAudio(state.meta, { id: `${peerId}:${String(metadata.id).slice(0, 40)}`, name: p.name, ts, pcm: bytes.slice().buffer });
    }
    return true;
  }

  /* ================= Tiles ================= */

  const tiles = new Set();

  function createTile(name, isSelf) {
    const el = Object.assign(document.createElement('div'), { className: 'tile' });
    el.innerHTML = `<video autoplay playsinline></video>
      <div class="avatar"><span></span></div>
      <div class="status">Connecting…</div>
      <div class="tag">${MIC_OFF}<span class="tag-name"></span></div>`;
    const video = el.querySelector('video');
    video.muted = true;     // video only; remote sound plays through the <audio> below
    const audio = isSelf ? null : Object.assign(document.createElement('audio'), { autoplay: true });
    if (audio) el.append(audio);
    const avatar = el.querySelector('.avatar span');
    avatar.textContent = initials(name);
    avatar.style.background = colorFor(name);
    el.querySelector('.tag-name').textContent = displayName(name, isSelf);
    ui.grid.append(el);
    const tile = { el, video, audio, status: el.querySelector('.status'), meter: null };
    tiles.add(tile);
    layoutGrid();
    return tile;
  }

  // Browsers may refuse to start sound until the user clicks the page. If that happens,
  // show a button instead of leaving the call silently muted.
  function playAudio(el) {
    el.play().catch(err => { if (err.name === 'NotAllowedError') ui.soundBlocked.hidden = false; });
  }
  ui.soundBlocked.addEventListener('click', () => {
    ui.soundBlocked.hidden = true;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    for (const t of tiles) if (t.audio && t.audio.srcObject) playAudio(t.audio);
  });

  function removeTile(tile) {
    if (tile.audio) tile.audio.srcObject = null;
    tile.meter?.src.disconnect();
    tiles.delete(tile);
    tile.el.remove();
    layoutGrid();
  }

  function paintTile(tile, { mic, cam, screen, mirror }) {
    const c = tile.el.classList;
    c.toggle('no-video', !(cam || screen));
    c.toggle('muted', !mic);
    c.toggle('screen', !!screen);
    c.toggle('mirror', !!mirror);
  }
  function paintPeer(p) {
    paintTile(p.tile, { mic: p.mic, cam: p.cam, screen: p.screen, mirror: false });
    renderPeople();
  }

  function layoutGrid() {
    const grid = ui.grid;
    const n = grid.children.length || 1;
    const portrait = grid.clientWidth < 700 && grid.clientHeight > grid.clientWidth;
    const cols = portrait ? (n <= 2 ? 1 : 2) : n === 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--rows', Math.ceil(n / cols));
  }
  new ResizeObserver(layoutGrid).observe(ui.grid);

  // Green "speaking" ring, Discord style.
  let audioCtx = null;
  const getAudioCtx = () => (audioCtx = audioCtx || new AudioContext());
  function watchAudio(tile, stream) {
    try {
      getAudioCtx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      tile.meter?.src.disconnect();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = Object.assign(audioCtx.createAnalyser(), { fftSize: 512 });
      src.connect(analyser);
      tile.meter = { src, analyser, buf: new Uint8Array(analyser.fftSize), loudAt: 0 };
    } catch (err) {
      console.warn('Audio meter unavailable', err);
    }
  }
  setInterval(() => {
    const now = performance.now();
    for (const tile of tiles) {
      const m = tile.meter;
      if (!m) continue;
      m.analyser.getByteTimeDomainData(m.buf);
      let peak = 0;
      for (const v of m.buf) peak = Math.max(peak, Math.abs(v - 128));
      if (peak > 12) m.loudAt = now;
      tile.el.classList.toggle('speaking', now - m.loudAt < 350 && !tile.el.classList.contains('muted'));
    }
  }, 120);

  /* ================= Controls ================= */

  function refreshSelf({ video = false } = {}) {
    const t = state.selfTile;
    if (video) {
      t.video.srcObject = state.sharing ? state.screen : effects.pipeline ? effects.pipeline.stream : state.local;
      t.video.play().catch(() => {});
    }
    paintTile(t, { mic: micLive(), cam: state.cam, screen: state.sharing, mirror: !state.sharing });
    syncControls();
    renderPeople();
    announce();
  }

  function setButton(b, { off = false, on = false, title }) {
    b.classList.toggle('off', off);
    b.classList.toggle('on', on);
    b.title = title;
    b.setAttribute('aria-label', title);
  }

  function syncControls() {
    setButton(ui.micBtn, { off: !state.mic, title: state.mic ? 'Mute (Ctrl+D)' : 'Unmute (Ctrl+D)' });
    setButton(ui.camBtn, { off: !state.cam, title: state.cam ? 'Turn camera off (Ctrl+E)' : 'Turn camera on (Ctrl+E)' });
    setButton(ui.fxBtn, { on: effects.mode !== 'off', title: effects.mode === 'off' ? 'Background effects' : `Background: ${effects.mode} blur` });
    setButton(ui.screenBtn, { on: state.sharing, title: state.sharing ? 'Stop presenting' : 'Present your screen' });
  }

  let micBusy = false;
  async function toggleMic() {
    if (micBusy) return;
    let track = state.local.getAudioTracks()[0];
    if (track) {
      state.mic = track.enabled = !state.mic;   // mute = keep the mic open but send silence
      if (rec.track) rec.track.enabled = state.mic;   // the recording copy of the mic is muted too
    } else {
      micBusy = true;                            // first unmute: ask for the microphone
      track = await acquire('audio');
      micBusy = false;
      if (!track) return;
      watchAudio(state.selfTile, new MediaStream([track]));
      await syncSenders();
      state.mic = true;
      startRecorder(track);   // muting later sends silence, which the voice detector simply ignores
      toast(`Microphone: ${track.label || 'default'}`, 4000);   // so a wrong microphone is noticed at once
    }
    refreshSelf();
    renderRecStatus();
  }

  /* ---------- Microphone picker ---------- */

  async function renderMicMenu() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId);
    const track = state.local.getAudioTracks()[0];
    const activeId = track ? track.getSettings().deviceId : micId;
    const named = devices.filter(d => d.label);
    if (!named.length) {
      // Browsers hide the names until the microphone has been allowed once.
      ui.micList.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'mic-empty',
        textContent: devices.length || !track ? 'Turn your microphone on once, then the list appears here.' : 'No microphone found.',
      }));
      return;
    }
    ui.micList.replaceChildren(...named.map(d => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'mic-opt', textContent: d.label, title: d.label });
      const selected = d.deviceId === activeId || (!activeId && d.deviceId === 'default');
      b.classList.toggle('selected', selected);
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(selected));
      b.addEventListener('click', () => switchMic(d.deviceId));
      return b;
    }));
  }

  // Changes the microphone in the middle of the call: for the other people and for the recording.
  async function switchMic(id) {
    if (micBusy) return;
    micId = id;
    store.set('mic', id);
    const old = state.local.getAudioTracks()[0];
    if (!old) return renderMicMenu();             // used the next time the microphone is turned on
    micBusy = true;
    stopRecorder();
    state.local.removeTrack(old);
    old.stop();
    const track = await acquire('audio');
    micBusy = false;
    if (track) {
      track.enabled = state.mic;                  // stays muted if it was muted
      watchAudio(state.selfTile, new MediaStream([track]));
      startRecorder(track);
      toast(`Microphone: ${track.label || 'default'}`, 4000);
    } else {
      state.mic = false;
    }
    await syncSenders();
    refreshSelf();
    renderRecStatus();
    renderMicMenu();
  }

  function setMicMenu(open) {
    ui.micMenu.hidden = !open;
    ui.micPick.setAttribute('aria-expanded', String(open));
    if (open) renderMicMenu().catch(() => {});
  }
  if (navigator.mediaDevices?.enumerateDevices) {
    ui.micPick.addEventListener('click', e => { e.stopPropagation(); setMicMenu(ui.micMenu.hidden); });
    ui.micMenu.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => setMicMenu(false));
    // a headset was plugged in or pulled out
    navigator.mediaDevices.addEventListener?.('devicechange', () => { if (!ui.micMenu.hidden) renderMicMenu().catch(() => {}); });
  } else {
    ui.micPick.hidden = true;
  }

  let camBusy = false;
  async function toggleCam() {
    if (camBusy) return;
    camBusy = true;
    try {
      if (state.cam) {
        // Stop the track completely so the camera light turns off.
        state.local.getVideoTracks().forEach(t => { t.stop(); state.local.removeTrack(t); });
        state.cam = false;
      } else {
        if (!await acquire('video')) return;
        state.cam = true;
      }
      await applyEffect();   // (re)starts or stops background blur, then updates peers + preview
    } finally {
      camBusy = false;
    }
  }

  async function toggleScreen() {
    if (state.sharing) return stopScreen();
    try {
      state.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return;   // user cancelled the picker
    }
    state.screen.getVideoTracks()[0].addEventListener('ended', stopScreen);
    state.screen.getVideoTracks()[0].contentHint = 'detail';   // keep text sharp rather than motion smooth
    state.sharing = true;
    await syncSenders();
    refreshSelf({ video: true });
  }

  async function stopScreen() {
    if (!state.sharing) return;
    state.sharing = false;
    state.screen.getTracks().forEach(t => t.stop());
    state.screen = null;
    await syncSenders();
    refreshSelf({ video: true });
  }

  /* ---------- Background blur ---------- */
  // Each camera frame goes through MediaPipe selfie segmentation, which runs locally in the browser.
  // The frame is drawn blurred as the background, the person is drawn sharp on top, and that
  // result is sent to everyone instead of the raw camera.

  const BLUR_PX = { off: 0, light: 7, strong: 16 };   // blur strength at 960px wide
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';   // the blur engine (only a library download)
  const savedEffect = store.get('effect');
  const effects = {
    mode: Object.hasOwn(BLUR_PX, savedEffect || '') ? savedEffect : 'off',
    pipeline: null,    // { track, stream, source, stop() } while blur is running
    segmenter: null,   // Promise of the MediaPipe ImageSegmenter, loaded once and reused
    seq: 0,
  };
  const blurSupported = 'captureStream' in HTMLCanvasElement.prototype && typeof WebAssembly === 'object';
  const fxOptions = ui.fxMenu.querySelectorAll('.fx-opt');

  function loadSegmenter() {
    if (!effects.segmenter) {
      effects.segmenter = (async () => {
        const { FilesetResolver, ImageSegmenter } = await import(`${MP}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
        const create = delegate => ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: new URL('models/selfie_segmenter.tflite', location.href).href, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        try { return await create('GPU'); } catch { return await create('CPU'); }
      })();
      effects.segmenter.catch(() => { effects.segmenter = null; });   // allow a retry later
    }
    return effects.segmenter;
  }

  async function createPipeline(raw) {
    const segmenter = await loadSegmenter();
    const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: new MediaStream([raw]) });
    await video.play();

    const w = video.videoWidth || 640, h = video.videoHeight || 360;
    const scale = Math.min(1, 960 / w);
    const W = Math.round(w * scale), H = Math.round(h * scale);
    const SW = 256, SH = Math.round(SW * H / W);            // the model works on a small copy
    const canvas = (cw, ch) => Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    const out = canvas(W, H), person = canvas(W, H), small = canvas(SW, SH), maskCanvas = canvas(SW, SH);
    const octx = out.getContext('2d'), pctx = person.getContext('2d');
    const sctx = small.getContext('2d'), mctx = maskCanvas.getContext('2d');
    const maskImage = mctx.createImageData(SW, SH);
    let running = true, lastTs = 0, timer = null;

    const drawFrame = started => {
      sctx.drawImage(video, 0, 0, SW, SH);
      lastTs = Math.max(started, lastTs + 1);
      segmenter.segmentForVideo(small, lastTs, result => {
        const conf = result.confidenceMasks?.[0]?.getAsFloat32Array();
        if (!conf) return;
        const d = maskImage.data;
        for (let i = 0, j = 3; i < conf.length; i++, j += 4) d[j] = conf[i] * 255;   // alpha = "person"
      });
      mctx.putImageData(maskImage, 0, 0);

      // 1. background: the whole frame, blurred (drawn slightly larger so the edges don't fade)
      const blur = BLUR_PX[effects.mode] * W / 960;
      const pad = blur * 2;
      octx.globalCompositeOperation = 'copy';
      octx.filter = `blur(${blur}px)`;
      octx.drawImage(video, -pad, -pad, W + pad * 2, H + pad * 2);
      octx.filter = 'none';
      // 2. person: the sharp frame, cut out by the mask (scaled up and softened at the edges)
      pctx.globalCompositeOperation = 'copy';
      pctx.drawImage(video, 0, 0, W, H);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.filter = 'blur(2px)';
      pctx.drawImage(maskCanvas, 0, 0, W, H);
      pctx.filter = 'none';
      octx.globalCompositeOperation = 'source-over';
      octx.drawImage(person, 0, 0);
    };

    const render = () => {
      if (!running) return;
      const started = performance.now();
      try {
        if (video.readyState >= 2) drawFrame(started);
      } catch (err) {
        console.warn('Background blur frame failed', err);
      }
      // setTimeout rather than requestAnimationFrame, so video keeps flowing while this tab is in the background
      timer = setTimeout(render, Math.max(0, 33 - (performance.now() - started)));
    };

    const stream = out.captureStream(30);
    render();
    const track = stream.getVideoTracks()[0];
    return {
      track, stream, source: raw,
      stop() { running = false; clearTimeout(timer); track.stop(); video.srcObject = null; },
    };
  }

  function stopPipeline() {
    effects.pipeline?.stop();
    effects.pipeline = null;
  }

  // Makes what we send match the chosen effect and the camera state. Safe to call any time.
  async function applyEffect() {
    const seq = ++effects.seq;
    const raw = state.local.getVideoTracks()[0];
    const want = effects.mode !== 'off' && raw && raw.readyState === 'live';
    if (!want || (effects.pipeline && effects.pipeline.source !== raw)) stopPipeline();
    if (want && !effects.pipeline) {
      if (!effects.segmenter) toast('Loading background blur…', 2500);
      try {
        const pipeline = await createPipeline(raw);
        if (seq !== effects.seq || raw.readyState !== 'live') { pipeline.stop(); return; }   // a newer change won
        effects.pipeline = pipeline;
      } catch (err) {
        console.warn('Background blur unavailable', err);
        toast('Background blur could not start in this browser.', 5000);
        effects.mode = 'off';
        store.set('effect', 'off');
      }
    }
    if (seq !== effects.seq) return;
    await syncSenders();
    refreshSelf({ video: !state.sharing });
    renderEffectsMenu();
  }

  function setEffect(mode) {
    if (mode === effects.mode) return;
    effects.mode = mode;
    store.set('effect', mode);
    renderEffectsMenu();
    if (mode !== 'off' && !state.cam) toast('Blur will be used when you turn your camera on.');
    applyEffect();   // light <-> strong needs no restart: the running pipeline reads the level every frame
  }

  if (!blurSupported) ui.fxBtn.parentElement.hidden = true;

  function renderEffectsMenu() {
    fxOptions.forEach(b => {
      const selected = b.dataset.fx === effects.mode;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-checked', String(selected));
    });
    syncControls();
  }
  function setFxMenu(open) {
    ui.fxMenu.hidden = !open;
    ui.fxBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    renderEffectsMenu();
    loadSegmenter().catch(() => {});   // warm up in the background so the first blur starts fast
  }
  ui.fxBtn.addEventListener('click', e => { e.stopPropagation(); setFxMenu(ui.fxMenu.hidden); });
  ui.fxMenu.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => setFxMenu(false));
  fxOptions.forEach(b => b.addEventListener('click', () => setEffect(b.dataset.fx)));

  /* ---------- Mini window (picture-in-picture), like Google Meet ---------- */
  // A small always-on-top window with the person talking plus mic / camera / leave buttons.
  // Chrome & Edge can open it automatically when you switch to another tab while your camera or
  // microphone is on; the top-bar button opens it any time.

  const docPip = 'documentPictureInPicture' in window;
  const pip = { win: null, auto: false, timer: null, ui: null, shownId: null };

  // Who to show: whoever presents, otherwise whoever is talking right now (sticky), otherwise camera-on first.
  function pipPerson() {
    const peers = [...state.peers.values()];
    if (!peers.length) {
      return { id: state.selfId, name: state.name, self: true, mic: state.mic, cam: state.cam, screen: state.sharing,
        tile: state.selfTile, stream: state.selfTile.video.srcObject };
    }
    const loudAt = p => (p.tile.meter ? p.tile.meter.loudAt : 0);
    let pick = peers.find(p => p.screen);
    if (!pick) {
      const talker = peers.reduce((a, b) => (loudAt(b) > loudAt(a) ? b : a));
      pick = performance.now() - loudAt(talker) < 1200
        ? talker
        : peers.find(p => p.id === pip.shownId) || peers.find(p => p.cam) || peers[0];
    }
    return { id: pick.id, name: pick.name, mic: pick.mic, cam: pick.cam, screen: pick.screen, tile: pick.tile, stream: pick.stream };
  }

  async function openPip({ auto = false } = {}) {
    if (!state.code || pip.win) return;
    if (!docPip) return openVideoPip();
    let win;
    try {
      win = await documentPictureInPicture.requestWindow({ width: 340, height: 400 });
    } catch (err) {
      console.warn('Mini window failed', err);
      if (!auto) toast('Could not open the mini window.');
      return;
    }
    Object.assign(pip, { win, auto });
    const doc = win.document;
    doc.title = `${ui.meetingTitle.textContent} · Linkas`;
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      doc.head.append(Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: link.href }));   // absolute URLs
    }
    doc.body.className = 'pip-body';
    doc.body.innerHTML = `<div class="pip">
        <div class="pip-stage">
          <video autoplay playsinline muted></video>
          <div class="pip-avatar"><span></span></div>
          <span class="pip-count"></span>
          <span class="pip-muted">${MIC_OFF}</span>
          <span class="pip-name"></span>
        </div>
        <div class="pip-controls">
          <button class="ctrl" data-act="mic" type="button">${ui.micBtn.innerHTML}</button>
          <button class="ctrl" data-act="cam" type="button">${ui.camBtn.innerHTML}</button>
          <button class="ctrl leave" data-act="leave" type="button" title="Leave call" aria-label="Leave call">${ui.leaveBtn.innerHTML}</button>
        </div>
      </div>`;
    const q = sel => doc.querySelector(sel);
    pip.ui = {
      stage: q('.pip-stage'), video: q('video'), avatar: q('.pip-avatar span'),
      name: q('.pip-name'), count: q('.pip-count'), mic: q('[data-act="mic"]'), cam: q('[data-act="cam"]'),
    };
    pip.ui.mic.addEventListener('click', toggleMic);
    pip.ui.cam.addEventListener('click', toggleCam);
    q('[data-act="leave"]').addEventListener('click', () => leaveCall());
    win.addEventListener('pagehide', () => {
      clearInterval(pip.timer);
      Object.assign(pip, { win: null, ui: null, shownId: null });
      ui.pipBtn.classList.remove('active');
    });
    ui.pipBtn.classList.add('active');
    updatePip();
    pip.timer = setInterval(updatePip, 300);
  }

  function updatePip() {
    const u = pip.ui;
    if (!u) return;
    const p = pipPerson();
    pip.shownId = p.id;
    if (u.video.srcObject !== p.stream) {
      u.video.srcObject = p.stream || null;
      u.video.play().catch(() => {});
    }
    const color = colorFor(p.name);
    const c = u.stage.classList;
    u.stage.style.setProperty('--tint', `color-mix(in srgb, ${color} 28%, #1e1f22)`);
    c.toggle('no-video', !(p.cam || p.screen));
    c.toggle('muted', !p.mic);
    c.toggle('screen', !!p.screen);
    c.toggle('mirror', !!p.self && !p.screen);
    c.toggle('speaking', p.tile.el.classList.contains('speaking'));
    u.avatar.textContent = initials(p.name);
    u.avatar.style.background = color;
    u.name.textContent = displayName(p.name, p.self);
    u.count.textContent = `${state.peers.size + 1} in call`;
    u.mic.classList.toggle('off', !state.mic);
    u.cam.classList.toggle('off', !state.cam);
    u.mic.title = state.mic ? 'Mute' : 'Unmute';
    u.cam.title = state.cam ? 'Turn camera off' : 'Turn camera on';
  }

  // Firefox/Safari have no mini-window API: pop out the video of the person on screen instead.
  async function openVideoPip() {
    if (document.pictureInPictureElement) return document.exitPictureInPicture();
    const p = pipPerson();
    if (!(p.cam || p.screen) || !p.tile.video.srcObject) return toast('In this browser the mini window needs someone’s camera to be on.');
    try { await p.tile.video.requestPictureInPicture(); } catch { toast('Could not open the mini window.'); }
  }

  ui.pipBtn.hidden = !(docPip || document.pictureInPictureEnabled);
  ui.pipBtn.addEventListener('click', () => (pip.win ? pip.win.close() : openPip()));
  // Opened automatically on tab switch -> close it again when the user comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pip.win && pip.auto) pip.win.close();
  });
  if (docPip && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', () => openPip({ auto: true }));
    } catch { /* this Chrome version has no automatic mini window */ }
  }

  /* ---------- Side panel: People or Chat ---------- */

  let panelView = null;
  const PANEL_BUTTONS = { people: ui.peopleBtn, chat: ui.chatBtn };
  const panelViews = ui.panel.querySelectorAll('.view');

  function setPanel(view) {
    panelView = view;
    ui.panel.hidden = !view;
    panelViews.forEach(v => { v.hidden = v.dataset.view !== view; });
    for (const [name, btn] of Object.entries(PANEL_BUTTONS)) {
      btn.classList.toggle('active', name === view);
      btn.setAttribute('aria-expanded', String(name === view));
      if (name === view) btn.classList.remove('has-unread');
    }
    syncControls();
    if (view === 'chat') {
      ui.chatList.scrollTop = ui.chatList.scrollHeight;
      if (matchMedia('(pointer: fine)').matches) ui.chatInput.focus();   // no keyboard pop-up on phones
    }
  }
  // Pressing the button of the open view closes the panel; any other button switches the view.
  const togglePanel = view => setPanel(panelView === view ? null : view);

  ui.micBtn.addEventListener('click', toggleMic);
  ui.camBtn.addEventListener('click', toggleCam);
  ui.screenBtn.addEventListener('click', toggleScreen);
  ui.peopleBtn.addEventListener('click', () => togglePanel('people'));
  ui.chatBtn.addEventListener('click', () => togglePanel('chat'));
  document.querySelectorAll('.close-panel').forEach(b => b.addEventListener('click', () => setPanel(null)));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      setFxMenu(false);
      setMicMenu(false);
      setLeaveMenu(false);
      if (panelView) setPanel(null);
      return;
    }
    // Google Meet's shortcuts: Ctrl+D microphone, Ctrl+E camera.
    if (!state.code || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === 'd') { e.preventDefault(); toggleMic(); }
    if (key === 'e') { e.preventDefault(); toggleCam(); }
  });

  /* ================= Leaving and ending ================= */
  // The host's browser keeps the record and makes the transcript, so the meeting ends when the host leaves.
  // Guests just leave (after handing in the sentence they were saying).

  function setLeaveMenu(open) {
    ui.leaveMenu.hidden = !open;
    ui.leaveBtn.setAttribute('aria-expanded', String(open));
  }
  ui.leaveBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (state.host && state.peers.size) setLeaveMenu(ui.leaveMenu.hidden);
    else leaveCall();
  });
  ui.leaveMenu.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => setLeaveMenu(false));
  ui.endAll.addEventListener('click', () => endMeeting());

  let leaving = false;
  async function leaveCall(reason = 'left') {
    if (state.host) return endMeeting();
    if (leaving) return;
    leaving = true;
    ui.leaveBtn.disabled = true;
    setLeaveMenu(false);
    stopMedia();                       // hands in the sentence being said right now ...
    await clipsHandedIn(4000);         // ... and waits (max 4 s) until the host's browser has stored it
    await closeRoom();
    location.href = `${location.pathname}?${reason}`;
  }

  // Camera, microphone, screen and the recorder off; the connections stay for the transcript.
  function stopMedia() {
    stopRecorder();
    stopPipeline();
    state.local.getTracks().forEach(t => { t.stop(); state.local.removeTrack(t); });
    state.screen?.getTracks().forEach(t => t.stop());
    Object.assign(state, { mic: false, cam: false, sharing: false, screen: null });
    if (pip.win) pip.win.close();
    syncSenders();
  }

  // Resolves once every recorded piece has been stored by the host (or after ms).
  function clipsHandedIn(ms) {
    const until = Date.now() + ms;
    return new Promise(resolve => {
      const check = () => (!rec.unsent.length || Date.now() > until ? resolve() : setTimeout(check, 200));
      check();
    });
  }

  // Host: "End meeting for everyone" (or Leave). Everyone hands in their last sentence, then this browser
  // makes the transcript, sends it to everyone still connected and emails it from the host's Gmail.
  async function endMeeting() {
    if (state.ended) return;
    const mailAllowed = gmail.authorize();          // first, while this is still the click: Google may ask
    state.ended = true;
    setLeaveMenu(false);
    state.act.end.send({ mail: gmail.configured }).catch(noop);
    showEnded();
    stopMedia();                                    // our own last sentence goes into the record too
    announce();
    setEndStatus('Waiting for everyone’s last sentence…', 'busy');
    await guestsFlushed(FLUSH_WAIT_MS);

    const report = text => {
      setEndStatus(text, 'busy');
      if (state.act.progress) state.act.progress.send({ text }).catch(noop);
    };
    report('Transcribing…');
    const meta = await meeting.finish(state.meta, report);
    if (meta.status !== 'done') {
      if (state.act.result) state.act.result.send({ error: meta.error }).catch(noop);
      setEndStatus(`The transcript could not be made: ${meta.error.replace(/[.\s]+$/, '')}. Try again from the lobby.`);
      return finishEnded();
    }
    if (state.act.result) state.act.result.send({ filename: meta.filename, text: meta.text, mail: gmail.configured }).catch(noop);
    if (await mailAllowed) await meeting.emailEveryone(meta, report);

    const mail = Object.values(meta.mail);
    const sent = mail.filter(s => s === 'sent').length;
    setEndStatus(!meta.hasContent ? 'Nobody said anything, so nothing was emailed.'
      : mail.some(s => s.startsWith('failed')) ? 'Ready. Some emails could not be sent — send them again from the lobby.'
        : sent ? `Ready. Emailed to ${sent} ${sent === 1 ? 'person' : 'people'}.`
          : gmail.configured ? 'Ready. Gmail was not allowed, so nothing was emailed — send it from the lobby.'
            : 'Ready. Everyone still here received it.', 'ready');
    finishEnded();
  }

  // Host: waits until every guest says their last speech is handed in (or ms have passed).
  const flushWait = { left: null, done: null };
  function guestsFlushed(ms) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); Object.assign(flushWait, { left: null, done: null }); resolve(); };
      const timer = setTimeout(done, ms);
      Object.assign(flushWait, { left: new Set(state.peers.keys()), done });
      if (!flushWait.left.size) done();
    });
  }
  function onFlushed(_, { peerId }) {
    if (flushWait.left && flushWait.left.delete(peerId) && !flushWait.left.size) flushWait.done();
  }

  // Guest: the host ended the meeting.
  async function onEnd(data, { peerId }) {
    if (peerId !== state.hostId || state.ended || !state.inCall) return;
    state.ended = true;
    showEnded(data && data.mail);
    setEndStatus('The host ended the meeting. Handing in your last sentence…', 'busy');
    stopMedia();
    await clipsHandedIn(FLUSH_WAIT_MS - 2000);
    state.act.flushed.send({}, { target: peerId }).catch(noop);
    if (!state.result) setEndStatus('The host’s browser is making the transcript…', 'busy');
  }
  function onProgress(data, { peerId }) {
    if (peerId === state.hostId && state.ended && !state.result) setEndStatus(cleanText(data && data.text, 120), 'busy');
  }
  function onResult(data, { peerId }) {
    if (peerId !== state.hostId || !state.ended || !data) return;
    if (data.error) {
      const error = cleanText(data.error, 300);
      saveLastMeeting({ error });
      setEndStatus(`The transcript could not be made: ${error.replace(/[.\s]+$/, '')}. The host can try again later.`);
    } else {
      state.result = { filename: cleanText(data.filename, 120) || 'Linkas.txt', text: String(data.text || '') };
      saveLastMeeting(state.result);
      setEndStatus(data.mail ? 'Ready. It is also emailed to you.' : 'Ready.', 'ready');
    }
    finishEnded();
  }

  /* ---------- the "meeting ended" screen ---------- */

  function showEnded(mail = gmail.configured) {
    ui.ended.hidden = false;
    ui.endedLobby.disabled = state.host;
    ui.endedNote.textContent = state.host ? 'Keep this tab open until it is done.'
      : mail ? 'You can also close this tab: the summary is emailed to you.' : 'Keep this tab open to receive the summary.';
  }
  // mode: 'ready' (download works), 'busy' (being made) or nothing.
  function setEndStatus(text, mode) {
    ui.endedStatus.textContent = text;
    ui.endedDownload.disabled = mode !== 'ready';
    ui.endedDownload.classList.toggle('waiting', mode === 'busy');
  }
  function finishEnded() {
    ui.endedLobby.disabled = false;
    ui.endedNote.textContent = '';
  }
  ui.endedDownload.addEventListener('click', () => {
    const done = state.host ? state.meta : state.result;
    if (done && done.text) saveTextFile(done.filename, done.text);
  });
  ui.endedLobby.addEventListener('click', async () => {
    await closeRoom();
    location.href = `${location.pathname}?ended`;
  });

  // Tab closed without pressing Leave: a guest still tries to hand in the sentence being said.
  // The host is warned first: the record and the transcript live in this tab.
  addEventListener('pagehide', () => { if (state.inCall && !state.host && !state.ended) stopRecorder(); });
  addEventListener('beforeunload', e => {
    if (state.host && state.meta && ['recording', 'processing'].includes(state.meta.status)) e.preventDefault();
  });

  async function copyInvite() {
    const link = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied. Share the PIN separately.');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  }
  [ui.copyLink, ui.aloneCopy, ui.peopleInvite].forEach(b => b.addEventListener('click', copyInvite));

  function updateCount() {
    ui.count.textContent = state.peers.size + 1;
    ui.alone.hidden = state.peers.size > 0 || state.ended;
    renderPeople();
    tuneVideo();
  }

  /* ================= People list ================= */

  function renderPeople() {
    if (!state.code) return;
    const people = [
      { name: state.name, self: true, mic: micLive(), cam: state.cam, screen: state.sharing },
      ...[...state.peers.values()].map(p => ({ name: p.name, mic: p.mic, cam: p.cam, screen: p.screen })),
    ];
    ui.peopleCount.textContent = people.length;
    ui.peopleList.replaceChildren(...people.map(p => {
      const video = p.cam || p.screen;
      const li = Object.assign(document.createElement('li'), { className: 'person' });
      li.innerHTML = `<span class="person-avatar"></span><span class="person-name"></span><span class="person-status">`
        + (p.screen ? '<span class="badge">Presenting</span>' : '')
        + (video ? '' : `<span class="cam-off">${CAM_OFF}</span>`)
        + (p.mic ? '' : `<span class="mic-off">${MIC_OFF}</span>`)
        + '</span>';
      const avatar = li.querySelector('.person-avatar');
      avatar.textContent = initials(p.name);
      avatar.style.background = colorFor(p.name);
      li.querySelector('.person-name').textContent = displayName(p.name, p.self);
      const status = [p.screen && 'presenting', !video && 'camera off', !p.mic && 'muted'].filter(Boolean);
      li.title = status.length ? `${p.name}: ${status.join(', ')}` : p.name;
      return li;
    }));
  }

  let clockTimer = null;
  function startClock() {
    const two = n => String(n).padStart(2, '0');
    const tick = () => {
      const s = Math.floor((Date.now() - state.joinedAt) / 1000);
      ui.timer.textContent = (s >= 3600 ? `${Math.floor(s / 3600)}:` : '') + `${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    };
    clearInterval(clockTimer);
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  /* ================= Chat ================= */

  // Puts text into an element, turning http(s) links into clickable links (built as DOM nodes, never HTML).
  function fillText(el, text) {
    el.replaceChildren(...text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, i) => (i % 2 === 0
      ? part
      : Object.assign(document.createElement('a'), { href: part, textContent: part, target: '_blank', rel: 'noopener noreferrer' }))));
  }

  function renderChat(m) {
    const list = ui.chatList;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const last = list.lastElementChild;
    const p = document.createElement('p');
    fillText(p, m.text);
    if (last && last.dataset.speaker === m.id) {
      last.append(p);                             // same person again: group lines under one name, like Discord
    } else {
      const li = document.createElement('li');
      li.dataset.speaker = m.id;
      li.innerHTML = '<div class="meta"><b></b><time></time></div>';
      const b = li.querySelector('b');
      b.textContent = displayName(m.name, m.id === state.selfId);
      b.style.color = colorFor(m.name);
      li.querySelector('time').textContent = m.time;
      li.append(p);
      list.append(li);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  const cleanChat = t => String(t || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);

  // A chat message from someone in the call (each browser shows it at the time it arrives).
  function onChat(data, { peerId }) {
    const peer = state.peers.get(peerId);
    const text = cleanChat(data && data.text);
    if (peer && text) addChat({ id: peerId, name: peer.name, text });
  }

  function addChat({ id, name, text }) {
    const ts = Date.now();
    const msg = { id, name, time: clock(ts), text };
    renderChat(msg);
    if (state.host) {                               // the host keeps it: for the transcript and for late joiners
      state.chat.push(msg);
      if (state.chat.length > 1000) state.chat.shift();
      meeting.addEntry(state.meta, { kind: 'chat', ts, name, text });
    }
    if (panelView !== 'chat' && id !== state.selfId) {
      ui.chatBtn.classList.add('has-unread');
      toast(`${name}: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`, 4000);
    }
  }

  function sizeChatInput() {
    ui.chatInput.style.height = 'auto';
    ui.chatInput.style.height = `${ui.chatInput.scrollHeight}px`;
    ui.chatSend.disabled = !ui.chatInput.value.trim();
  }
  ui.chatInput.addEventListener('input', sizeChatInput);
  ui.chatInput.addEventListener('keydown', e => {
    // Enter sends, Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ui.chatForm.requestSubmit();
    }
  });
  ui.chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = cleanChat(ui.chatInput.value);
    if (!text || !state.act.chat) return;
    state.act.chat.send({ text }).catch(noop);
    addChat({ id: state.selfId, name: state.name, text });
    ui.chatInput.value = '';
    sizeChatInput();
    ui.chatList.scrollTop = ui.chatList.scrollHeight;
  });

  // Saves text as a .txt download.
  function saveTextFile(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ================= Background recording (for the after-meeting transcript) ================= */
  // Nothing is transcribed during the call. While your microphone is on, your browser records only
  // your own voice: a simple voice detector keeps the parts where you actually speak, as 16 kHz audio,
  // and sends each piece, with the moment you started speaking, straight to the host's browser. After the
  // meeting the host's browser turns everything into text (Gemini) and builds the .txt file.

  const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const REC_RATE = 16000;
  const FRAME = 480;                 // 30 ms at 16 kHz
  const FRAME_MS = 30;
  const VAD = {
    startFrames: 3,        // ~90 ms of voice starts a piece
    endSilenceMs: 2000,    // this long a pause ends it (shorter thinking pauses stay inside, so sentences stay whole)
    preRollFrames: 20,     // keep ~0.6 s from before the voice, so first syllables are not cut off
    maxMs: 20000,          // tested: Whisper drops the end of pieces close to its 30 s limit
    splitWindowMs: 7000,   // a piece that reaches the limit is cut at its quietest moment in the last 7 s
    minVoiceMs: 400,       // shorter blips (clicks, coughs) are dropped
    floor: 0.004,          // quietest level that can still count as voice (quiet laptop microphones)
    noiseBlock: 17,        // background noise = the quietest ~0.5 s ...
    noiseBlocks: 8,        // ... of the last ~4 s
  };
  // Runs in the audio thread: hands the raw microphone samples to the page in blocks.
  const WORKLET_SRC = `class LinkasTap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor('linkas-tap', LinkasTap);`;

  const rec = {
    supported: typeof AudioWorkletNode === 'function',
    ctx: null, workletReady: false, source: null, node: null, sink: null, filters: [], track: null, ownTrack: false, failed: false,
    step: 1, pos: 0, last: 0,                     // resampling to 16 kHz (only if the browser can't do it)
    frame: new Float32Array(FRAME), fi: 0,
    noise: 0.003, blockMin: Infinity, blockN: 0, mins: [],
    voiceRun: 0, silenceMs: 0,
    pre: [], preLevels: [],                       // the last frames before speech started (and how loud they were)
    clip: null, levels: [], voiced: [], clipStart: 0,   // the piece being recorded right now, frame by frame
    unsent: [],                                   // finished pieces the host's browser has not confirmed yet
    prefix: crypto.randomUUID().slice(0, 8), count: 0,   // every piece gets a unique id (no doubles after resending)
  };

  // The recorder uses its own copy of the microphone WITHOUT automatic gain and noise suppression:
  // tested, the gain control turned the first words up until they clipped, which made Whisper derail.
  // Echo cancellation stays on, so other people's voices from your speakers are not recorded as yours.
  async function recordingCopy(callTrack) {
    if (IS_SAFARI) return null;   // Safari silences the call's microphone when it is opened a second time
    const { deviceId } = callTrack.getSettings();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1,
      } });
      return s.getAudioTracks()[0];
    } catch (err) {
      console.warn('Separate recording mic not available, using the call mic', err);
      return null;
    }
  }

  // The recording audio engine and its worklet are created once and reused.
  async function recorderContext() {
    if (!rec.ctx) {
      // Running at 16 kHz makes the browser do a high-quality conversion of the mic
      // (tested: a crude conversion made Whisper lose words).
      try { rec.ctx = new AudioContext({ sampleRate: REC_RATE }); } catch { rec.ctx = new AudioContext(); }
    }
    if (rec.ctx.state === 'suspended') await rec.ctx.resume();
    if (!rec.workletReady) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await rec.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      rec.workletReady = true;
    }
    return rec.ctx;
  }

  async function startRecorder(callTrack) {
    if (!rec.supported || rec.source) return renderRecStatus();
    stopRecorder();
    const copy = await recordingCopy(callTrack);
    const track = copy || callTrack;
    rec.ownTrack = !!copy;
    try {
      const ctx = await recorderContext();
      rec.source = ctx.createMediaStreamSource(new MediaStream([track]));
      rec.node = new AudioWorkletNode(ctx, 'linkas-tap');
      rec.sink = ctx.createGain();
      rec.sink.gain.value = 0;                     // keeps the recorder running without making any sound
      rec.step = ctx.sampleRate / REC_RATE;
      // Fallback when the engine is not at 16 kHz: cut everything above 7 kHz first (two filters = steep),
      // otherwise the conversion below distorts the voice.
      rec.filters = rec.step === 1 ? [] : [0, 1].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 7000;
        f.Q.value = 0.707;
        return f;
      });
      [rec.source, ...rec.filters, rec.node, rec.sink, ctx.destination].reduce((a, b) => a.connect(b));
      rec.node.port.onmessage = e => feed(e.data);
      rec.track = track;
      track.enabled = state.mic;                   // muted while the recorder was starting: stay muted
      rec.failed = false;
    } catch (err) {
      console.warn('Recorder failed to start', err);
      rec.failed = true;
      toast('Your voice cannot be recorded in this browser, so it will be missing from the transcript.', 8000);
    }
    renderRecStatus();
  }

  function stopRecorder() {
    if (rec.clip) finishClip(rec.clip.length);    // upload the piece being recorded right now
    Object.assign(rec, { pre: [], preLevels: [], voiceRun: 0 });
    if (rec.node) rec.node.port.onmessage = null;
    [rec.source, ...rec.filters, rec.node, rec.sink].forEach(n => n?.disconnect());
    if (rec.ownTrack) rec.track?.stop();
    Object.assign(rec, { source: null, node: null, sink: null, filters: [], track: null, ownTrack: false });
  }

  // Microphone samples -> 30 ms frames at 16 kHz.
  function pushSample(v) {
    rec.frame[rec.fi++] = v;
    if (rec.fi === FRAME) {
      onFrame(rec.frame);
      rec.frame = new Float32Array(FRAME);
      rec.fi = 0;
    }
  }
  function feed(input) {
    if (rec.step === 1) {                         // normal case: already 16 kHz
      for (let i = 0; i < input.length; i++) pushSample(input[i]);
      return;
    }
    // fallback: linear interpolation of the (already low-passed) signal
    const buf = new Float32Array(input.length + 1);
    buf[0] = rec.last;
    buf.set(input, 1);
    let p = rec.pos;
    while (p < buf.length - 1) {
      const i = Math.floor(p), f = p - i;
      pushSample(buf[i] * (1 - f) + buf[i + 1] * f);
      p += rec.step;
    }
    rec.pos = p - (buf.length - 1);
    rec.last = buf[buf.length - 1];
  }

  // The voice detector.
  function onFrame(frame) {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / frame.length);
    // Background-noise level = the quietest moment of the last few seconds. Even fluent speech has tiny
    // gaps between words, so talking for a long time never raises it (the old running average did, and
    // then stopped hearing the speaker); a fan or street noise is constant, so it is learned in seconds.
    if (rms > 0) {                                // exact silence = muted: tells nothing about the room
      rec.blockMin = Math.min(rec.blockMin, rms);
      if (++rec.blockN === VAD.noiseBlock) {
        rec.mins.push(rec.blockMin);
        if (rec.mins.length > VAD.noiseBlocks) rec.mins.shift();
        Object.assign(rec, { noise: Math.min(...rec.mins), blockMin: Infinity, blockN: 0 });
      }
    }
    const threshold = Math.max(VAD.floor, rec.noise * 3);

    if (!rec.clip) {
      rec.pre.push(frame);
      rec.preLevels.push(rms);
      if (rec.pre.length > VAD.preRollFrames) { rec.pre.shift(); rec.preLevels.shift(); }
      rec.voiceRun = rms > threshold ? rec.voiceRun + 1 : 0;
      if (rec.voiceRun >= VAD.startFrames) {
        Object.assign(rec, {
          clip: rec.pre, levels: rec.preLevels, voiced: rec.preLevels.map(l => l > threshold * 0.7),
          pre: [], preLevels: [], clipStart: performance.now() - rec.pre.length * FRAME_MS, silenceMs: 0,
        });
      }
      return;
    }

    const voiced = rms > threshold * 0.7;
    rec.clip.push(frame);
    rec.levels.push(rms);
    rec.voiced.push(voiced);
    rec.silenceMs = voiced ? 0 : rec.silenceMs + FRAME_MS;
    if (rec.silenceMs >= VAD.endSilenceMs) finishClip(rec.clip.length);
    else if (rec.clip.length * FRAME_MS >= VAD.maxMs) finishClip(quietestFrame());   // talking on: cut between words
  }

  // Where to cut a piece that got too long: the quietest ~0.2 s of its last seconds (a gap between words).
  function quietestFrame() {
    const lv = rec.levels;
    const to = lv.length - 17;                    // leave at least 0.5 s for the next piece
    let best = to, bestSum = Infinity;
    for (let i = lv.length - VAD.splitWindowMs / FRAME_MS; i < to; i++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) sum += lv[i + k];
      if (sum < bestSum) { bestSum = sum; best = i; }
    }
    return best;
  }

  // Hands in the first `cut` frames of the current piece; whatever comes after them starts the next piece.
  function finishClip(cut) {
    const { clip, levels, voiced, clipStart } = rec;
    Object.assign(rec, cut < clip.length
      ? { clip: clip.slice(cut), levels: levels.slice(cut), voiced: voiced.slice(cut), clipStart: clipStart + cut * FRAME_MS }
      : { clip: null, levels: [], voiced: [], voiceRun: 0, silenceMs: 0 });
    let voice = 0, end = 0;
    for (let f = 0; f < cut; f++) if (voiced[f]) { voice++; end = f + 1; }
    if (voice * FRAME_MS < VAD.minVoiceMs) return;
    const keep = Math.min(cut, end + 10);         // keep ~0.3 s of the silence after the last word
    const pcm = new Int16Array(keep * FRAME);
    for (let f = 0; f < keep; f++) {
      for (let i = 0; i < FRAME; i++) pcm[f * FRAME + i] = Math.max(-1, Math.min(1, clip[f][i])) * 32767;
    }
    rec.unsent.push({ id: `${rec.prefix}-${++rec.count}`, pcm: pcm.buffer, start: clipStart });
    if (rec.unsent.length > 60) rec.unsent.shift();           // host away for very long: keep the newest
    flushClips();
  }

  // Hands finished pieces to the host's browser; each stays here until the host confirms it is stored.
  // While the host is away they wait and go out when the host is back, still with the right time
  // ("at" is the moment the person started speaking, on this device's clock; the host corrects the difference).
  function flushClips() {
    const at = c => Date.now() - (performance.now() - c.start);
    if (state.host) {                                         // our own speech goes straight into the record
      for (const c of rec.unsent.splice(0)) meeting.addAudio(state.meta, { id: `self:${c.id}`, name: state.name, ts: at(c), pcm: c.pcm });
      return;
    }
    if (!state.hostId || !state.act.clip) return;
    for (const c of rec.unsent) {
      if (c.sending) continue;
      c.sending = true;
      state.act.clip.request(c.pcm, { target: state.hostId, metadata: { id: c.id, at: at(c) }, timeoutMs: 60000 })
        .then(() => { rec.unsent = rec.unsent.filter(x => x !== c); })
        .catch(noop)                                          // sent again when the host is back
        .finally(() => { c.sending = false; });
    }
  }

  // Small indicator in the top bar, so everyone knows the call is recorded for the transcript.
  const REC_STATUS = {
    live: 'This call is recorded for the written transcript (made in the host’s browser), including your voice.',
    idle: 'This call is recorded for the transcript (made in the host’s browser). Your voice is included while your microphone is on.',
    off: 'This call is recorded for the transcript, but this browser cannot record your voice. Use a current Chrome, Edge or Safari.',
  };
  function renderRecStatus() {
    if (!state.code) return;
    const status = !rec.supported || rec.failed ? 'off' : state.mic ? 'live' : 'idle';
    ui.recChip.dataset.status = status;
    ui.recChip.title = REC_STATUS[status];
    ui.recChip.setAttribute('aria-label', REC_STATUS[status]);
  }
})();
