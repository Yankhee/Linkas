// TURN servers: they pass the call on for people whose network blocks direct connections.
// The list is the fixed TURN from config.js plus the logins fetched from TURN_API (a TURN provider's address that
// hands them out, e.g. Metered), fetched straight from the browser before a room is opened.

import { TURN, TURN_API } from './config.js';

const FETCH_TIMEOUT_MS = 6000;
const REFRESH_MS = 6 * 3600e3;     // fetch new logins after this long (providers' logins can expire)

let fetched = [];
let fetchedAt = 0;
let loading = null;

// The provider's answer: a list of ICE servers, or { iceServers: list or one server }.
function readServers(data) {
  const list = Array.isArray(data) ? data : data && data.iceServers;
  return (Array.isArray(list) ? list : list ? [list] : []).filter(s => s && s.urls);
}

// The TURN servers to use right now (call load() first).
export const servers = () => [...TURN, ...fetched];

export const configured = () => TURN.length > 0 || !!TURN_API;

// Fetches the logins from TURN_API, unless they are still fresh. Never fails: without an answer the last
// logins (or none) are used, so the call still works where direct connections do.
export function load() {
  if (!TURN_API || Date.now() - fetchedAt < REFRESH_MS) return Promise.resolve(servers());
  loading ||= fetch(TURN_API, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(data => {
      const list = readServers(data);
      if (!list.length) throw new Error('no servers in the answer');
      fetched = list;
      fetchedAt = Date.now();
    })
    .catch(err => console.warn('Could not get the TURN logins from TURN_API:', err.message))
    .then(() => { loading = null; return servers(); });
  return loading;
}
