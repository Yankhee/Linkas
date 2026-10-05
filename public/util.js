// Small helpers shared by the browser files.

const pad = n => String(n).padStart(2, '0');

// Local time formats used in the transcript and in file names (accept a Date or a timestamp).
export const clock = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const isoDate = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// A meeting name as part of a file name: keeps letters (also Lithuanian) and spaces, drops what Windows forbids.
export const fileName = s => s.replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 60).trim()
  || 'Linkas meeting';

// Single-line text, trimmed and limited in length.
export const cleanText = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

export const isEmail = e => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/.test(e);
