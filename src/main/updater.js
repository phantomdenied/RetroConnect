'use strict';
// "Is there a newer RetroConnect?" check.
//
// The code repo is private, so updates are announced through a small public
// JSON file (e.g. a public GitHub Gist) that the publisher edits after each
// release:
//
//   { "version": "0.5.0",
//     "url": "https://link-to-the-installer",
//     "notes": "What changed (optional)" }
//
// The app compares versions and, if newer, offers a Download button that
// opens `url` in the browser. Nothing is downloaded or run automatically.

const { compareVersions } = require('./retroarch-installer');

function validFeed(data) {
  if (!data || typeof data !== 'object') throw new Error('The update file isn\'t valid JSON');
  const version = String(data.version || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The update file needs a "version" like "1.2.3"');
  const url = String(data.url || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('The update file needs an https "url" for the download');
  return { version, url, notes: data.notes ? String(data.notes).slice(0, 2000) : '' };
}

async function checkForUpdate({ feedUrl, currentVersion, fetchImpl = globalThis.fetch }) {
  if (!feedUrl) return { configured: false };
  if (!/^https:\/\//.test(feedUrl)) throw new Error('The update link must start with https://');
  let data;
  try {
    // Cache-buster: gist "raw" links are cached for a few minutes.
    const sep = feedUrl.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${feedUrl}${sep}t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = JSON.parse(await res.text());
  } catch (err) {
    throw new Error(`Couldn't check for updates: ${err.message}`);
  }
  const feed = validFeed(data);
  return {
    configured: true,
    current: currentVersion,
    latest: feed.version,
    available: compareVersions(feed.version, currentVersion) > 0,
    url: feed.url,
    notes: feed.notes,
    checkedAt: Date.now(),
  };
}

module.exports = { checkForUpdate, validFeed };
