// Settings for this copy of Linkas. This file is part of the public web page: never put secrets here.
// (The Gemini key is not set here: the host types it in the lobby and it stays in their own browser.)

// A name only your copy of Linkas uses: browsers find each other's meetings under it.
export const APP_ID = 'linkas-p2p-1';

// Emails after the meeting are sent from this Gmail account (Google's Gmail API, straight from the host's browser).
// Google asks the host to sign in with it and allow sending, once.
export const GMAIL_SENDER = 'testlinkas@gmail.com';

// Google requires an "OAuth client ID" made for the address where Linkas is published (free, steps in HOW-TO-START.txt).
// Empty = no emails: everyone receives the transcript in Linkas and can download it.
export const GOOGLE_CLIENT_ID = '573520385161-50okl2rov887bj3q3q7t293ujuuk4n74.apps.googleusercontent.com';

// TURN servers pass the call on for people whose network blocks direct connections (some offices and mobile
// networks). Empty = direct connections only, which works for most home and office networks.
// Note: whatever is written here is public, so anyone could use this TURN login.
// Example: export const TURN = [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }];
export const TURN = [];
