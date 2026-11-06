'use strict';
// One code that has everything a buddy needs to connect:
//   the shared secret, optionally a Tailscale key, and the inviter's address.
//
//   RC1-<base64url JSON>   e.g. RC1-eyJzIjoi...
//
// The friend pastes it once; their app saves the secret, installs and joins
// Tailscale with the key, and points at the inviter's address. The code holds
// secrets (the shared secret and a one-time Tailscale key), so it is sent
// privately, like the secret was before.

const PREFIX = 'RC1-';
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

function makeInvite({ secret, tsKey = null, address = null, nickname = '' }) {
  secret = String(secret || '').trim();
  if (!secret) throw new Error('Set up a shared secret first');
  tsKey = tsKey ? String(tsKey).trim() : null;
  if (tsKey && !/^tskey-/.test(tsKey)) throw new Error('That doesn\'t look like a Tailscale key (they start with "tskey-")');
  address = address ? String(address).trim() : null;
  if (address && !IP.test(address)) throw new Error('Bad address in invite');
  const body = { v: 1, s: secret };
  if (tsKey) body.k = tsKey;
  if (address) body.a = address;
  if (nickname) body.n = String(nickname).slice(0, 40);
  return PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
}

function isInvite(text) {
  return String(text || '').trim().toUpperCase().startsWith(PREFIX);
}

/** Returns { secret, tsKey, address, nickname }, or throws for a broken code. */
function parseInvite(text) {
  const raw = String(text || '').replace(/\s+/g, '');
  if (!isInvite(raw)) throw new Error('That isn\'t a RetroConnect invite code');
  let body;
  try {
    body = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('That invite code is cut off or mistyped. Copy the whole thing again.');
  }
  const secret = String((body && body.s) || '').trim();
  if (!secret) throw new Error('That invite code is cut off or mistyped. Copy the whole thing again.');
  const tsKey = body.k && /^tskey-/.test(body.k) ? String(body.k) : null;
  const address = body.a && IP.test(body.a) ? String(body.a) : null;
  return { secret, tsKey, address, nickname: body.n ? String(body.n).slice(0, 40) : '' };
}

module.exports = { makeInvite, parseInvite, isInvite, PREFIX };
