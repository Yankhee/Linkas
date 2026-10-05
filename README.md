# Linkas

Simple private video calls (like Google Meet), **peer to peer: no server, nobody's PC in the middle**.
After the call, every participant gets the summary and the full written transcript (.txt).

- Video/audio calls for up to 8 people, directly between the browsers (WebRTC)
- Every meeting is protected with a 4-digit PIN
- Name + email when creating or joining (the email is only used to send the summary; no accounts)
- The person who created the meeting is the host and ends the meeting for everyone
- Everyone joins with camera and microphone off
- Screen sharing, mute, camera on/off, "speaking" indicator, Ctrl+D / Ctrl+E shortcuts
- Background blur (Off / Light / Strong), processed locally in the browser (MediaPipe)
- Mini window (picture-in-picture) that stays on top while you use other apps
- Right-hand side panel with People and Chat
- Dark, Discord-style design with a green accent

## How it works without a server

Linkas is a **static web page** (the `public/` folder). A free static host such as GitHub Pages only hands out
these files. It takes no part in the call and never sees anything from it.

1. **Finding each other.** The browsers of one meeting find each other through public relays (the Nostr network,
   via the [Trystero](https://github.com/dmotz/trystero) library). Only the connection handshake passes there,
   encrypted with the PIN. Wrong PIN = no connection.
2. **The call.** Every browser connects directly to every other one. Video, sound, chat and everything else go
   straight between the browsers, encrypted by WebRTC.
3. **Recording.** While a microphone is on, that browser records only its own voice (a voice detector keeps just
   the moments of speech) and sends each piece **directly to the host's browser**, with the time it started. The
   host's browser confirms each piece, so nothing is lost when a connection drops. It stores the pieces in
   the browser (IndexedDB), so even a page reload loses nothing.
4. **After the meeting** (the host presses *End meeting for everyone*), everyone's browser hands in its last
   sentence. Then the **host's browser** does what the server used to do:
   - each person's speech → one recording → **Gemini** writes it down word for word, with time stamps
   - everything (speech, chat, joins/leaves) is put in time order → Gemini writes the **summary**
     (topics, agreements, action items)
   - the .txt is **sent directly to everyone still in the call** (they download it), and
   - **emailed** to every participant from testlinkas@gmail.com (if set up, see below)
   - the recorded audio is deleted.

The only outside services: the public relays (they only see the encrypted handshake), Google Gemini (the
speech, for the transcript) and Gmail (the emails). The same Gemini and Gmail as before, now called by the
host's browser instead of a server.

Example file:

```
LINKAS · POKALBIO STENOGRAMA
========================================================
Susitikimas:     Projekto aptarimas
Data:            2026-09-30
Pradžia:         14:02
Pabaiga:         14:47 (trukmė 45 min.)
Dalyviai:        Ignas, Tomas
Kambario kodas:  kfp-wxra-mtd
Transkripcija:   Gemini (gemini-flash-latest)
========================================================

POKALBIS

[14:02:11] — Ignas prisijungė —
[14:02:19] Ignas: Labas, ar girdi mane?
[14:02:25] Tomas: Taip, girdžiu puikiai.
[14:03:02] Tomas (žinutė): Dokumentas: https://example.com

--------------------------------------------------------

SANTRAUKA

TEMOS
- ...
SUTARIMAI
- ...
VEIKSMŲ PUNKTAI
- Tomas: paruošti dizaino pakeitimus (iki penktadienio)
```

## Setup

`HOW-TO-START.txt` has every step written out. In short:

1. **Publish `public/`** on any free static host. GitHub Pages: a repository containing the files of
   `public/`, then *Settings → Pages → Deploy from a branch*. You get a fixed `https://…` address that works
   whether your PC is on or off.
2. **Gemini key** (for the transcript and summary): free at https://aistudio.google.com/apikey. The host
   pastes it into the lobby when creating a meeting. It is stored only in the host's browser and sent only to
   Google. **Never put it in a file of `public/`**: the whole folder is public.
3. **Emails (optional)**: set `GOOGLE_CLIENT_ID` in `public/config.js` (steps in `HOW-TO-START.txt`). Without
   it, everyone who is still in the call when it ends gets the transcript directly, and the host can download
   it from the lobby and forward it.
4. **TURN (optional)**: a few strict networks (some offices, mobile carriers) block direct connections.
   For them, put a TURN server in `public/config.js` (e.g. Cloudflare's free TURN or metered.ca).

### Try it on this PC

Requires [Node.js](https://nodejs.org). `npm start` serves `public/` on http://localhost:3000 (browsers only
allow the camera and microphone on HTTPS or localhost). Open it in a normal window and in a private window,
create a meeting in one and join it from the other. The meetings themselves still connect through the public
relays, so the PC needs internet.

## What happens when…

- **the host ends the meeting**: everyone sees *The meeting has ended*. A minute or two later the summary
  arrives on that screen (*Download summary*) and by email. **The host keeps the tab open until it says
  *Ready*** (the browser warns before closing it).
- **the host leaves**: the host's browser is where the meeting is recorded, so leaving = ending the meeting
  for everyone.
- **a guest leaves early**: their last sentence is handed in, and they see *You left the meeting — waiting
  for the meeting to end*. When it ends, the summary appears on that screen. If they close the tab, the
  *Last meeting* card in their Linkas lobby gets it from the host's browser whenever both are online (and it
  is emailed, if set up).
- **the host's tab closes without ending the meeting**: open the same link again and join with the same code
  and PIN to carry on, with nothing lost. If the host does not come back, the next time they open Linkas (after 2
  quiet minutes) the meeting is ended and transcribed by itself, and sent to everyone, including guests
  still waiting in the call. Speech recorded while the host was away is included. The emails then need
  one click on the lobby card (*Email it*), because Google asks for permission on a click.
- **Gemini fails** (key wrong, free limit used up): the host sees why, and the lobby card has *Try again*. The
  recordings stay in the host's browser until a transcript is made.
- **an email fails**: the lobby card says so and has *Send again*; *Download summary* always works.
- **two people use the same name**: the second becomes "Tomas (2)", so the transcript always shows who spoke.
- **someone's network drops**: the connection is made again by itself, and speech recorded meanwhile is handed in.
- **someone has no camera, or blocks the camera/microphone**: they stay in the call and see, hear and chat;
  without a microphone their voice is simply not in the transcript.

## Security and privacy

- **No server**: no one stores the call. Video, sound and chat go only between the browsers in the call.
- The meeting code (10 random letters) and the PIN are needed to connect. The handshake on the public relays is
  encrypted with them, so the relays cannot read it. A server used to block a guessed PIN after 5 tries; with
  no server, nothing can count wrong tries, so **the invite link is the real key**. Share it only with the
  people you invite, and tell them the PIN separately.
- The recorded speech goes only to the host's browser (and from there to Google Gemini for the transcript). It
  is deleted once the transcript is made.
- The Gemini key stays in the host's browser. Emails are sent from testlinkas@gmail.com with a permission
  that lasts one hour and is never stored.
- With Gemini's free tier, Google may use the audio to improve its products. For confidential meetings use a
  paid Gemini key.

## Good to know

- Works in **Chrome**, **Edge** and **Safari** (current versions). Headphones and a decent microphone give the best transcript.
- The small arrow on the microphone button chooses **which microphone** is used (laptop or headset).
- Every browser sends its video to every other one. Linkas lowers the video quality as more people join, so
  a normal home connection keeps up with up to 8 people.
- Accuracy for Lithuanian is good but not perfect (mostly small word-ending mistakes); the summary smooths those out.
- Updating the P2P library: `npm install`, then `npm run vendor` (rebuilds `public/vendor/trystero.mjs`).

## Files

```
public/              the whole app (this folder is what gets published)
  index.html         the page: lobby, call, "meeting ended" screen
  app.js             everything in the call: joining, P2P connections, buttons, chat, blur, mini window, voice recording
  meeting.js         the host's record of the meeting and the after-meeting steps (transcript, summary, emails)
  gemini.js          Gemini: speech-to-text and summary
  gmail.js           sending the emails from the host's Gmail
  config.js          settings of your copy (email client ID, TURN) - public, no secrets
  util.js            small helpers (time formats, file names)
  style.css          the look
  vendor/trystero.mjs  the P2P library (finding each other + connections)
  models/            background-blur model
serve.js             local test server (npm start)
```
