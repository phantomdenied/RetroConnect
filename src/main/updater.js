'use strict';
// "Is there a newer RetroConnect?" check.
//
// Built-in source: the repo's GitHub Releases (package.json
// "retroconnect.githubRepo"). Pushing a tag like v0.7.2 makes the build
// workflow publish a Release with the installer, and every copy of the app
// sees it on its next check. The repo must be public for this to work.
//
// The update link can also point to any public JSON file instead:
//
//   { "version": "0.5.0",
//     "url": "https://link-to-the-installer",
//     "notes": "What changed (optional)" }
//
// The app compares versions and, if newer, offers a Download button that
// downloads the installer inside the app; "Restart to update" runs it
// silently and the new version opens by itself. Nothing is downloaded or
// installed without a click. Portable and dev copies open the release page.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { compareVersions } = require('./retroarch-installer');

const GITHUB_LATEST = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;

function validFeed(data) {
  if (!data || typeof data !== 'object') throw new Error('The update file isn\'t valid JSON');
  const version = String(data.version || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The update file needs a "version" like "1.2.3"');
  const url = String(data.url || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('The update file needs an https "url" for the download');
  return { version, url, notes: data.notes ? String(data.notes).slice(0, 2000) : '' };
}

// Release notes are markdown and can be long; the banner wants a line or two.
function plainNotes(md) {
  const text = String(md || '')
    .replace(/<!-- guide -->[\s\S]*?<!-- \/guide -->/g, '') // release-page text for newcomers
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[*-]\s+/, '• ').replace(/\*\*|__|`/g, '').trim())
    .filter((l) => l && !/^Full Changelog/i.test(l))
    .join('  ');
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

// A GitHub "latest release" API answer -> the same shape as a feed file.
// Prefers the Windows installer asset so the button downloads it directly.
function feedFromRelease(rel) {
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const pick = (re) => assets.find((a) => re.test(a.name || ''));
  const asset = pick(/-win-setup\.exe$/i) || pick(/setup.*\.exe$/i) || pick(/\.exe$/i);
  const feed = validFeed({
    version: rel.tag_name,
    url: (asset && asset.browser_download_url) || rel.html_url,
    notes: plainNotes(rel.body),
  });
  feed.pageUrl = /^https:\/\//.test(rel.html_url || '') ? rel.html_url : feed.url;
  // Only the setup installer can update in place (the portable exe can't).
  if (asset && /setup.*\.exe$/i.test(asset.name) && /^https:\/\//.test(asset.browser_download_url || '')) {
    const digest = /^sha256:[0-9a-f]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null;
    feed.asset = {
      name: path.basename(String(asset.name)).replace(/[^\w.-]/g, '_'),
      url: asset.browser_download_url,
      size: Number(asset.size) || 0,
      sha256: digest,
    };
  }
  return feed;
}

/**
 * Download the installer to `dest`, checking its size and (when GitHub gives
 * one) its SHA-256. Writes to dest.partial first so a cut-off download is
 * never mistaken for a finished one.
 */
async function downloadAsset(asset, dest, { fetchImpl = globalThis.fetch, onProgress = null } = {}) {
  const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'RetroConnect' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.partial`;
  const hash = crypto.createHash('sha256');
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    hash.update(chunk);
    if (onProgress) onProgress({ done, total });
  });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    if (asset.size && done !== asset.size) throw new Error('Download was cut off; try again');
    if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('The download is damaged (checksum mismatch); try again');
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

function isGithubRepo(s) {
  return /^[\w.-]+\/[\w.-]+$/.test(String(s || ''));
}

async function checkForUpdate({ feedUrl, githubRepo, currentVersion, fetchImpl = globalThis.fetch }) {
  const fromGithub = !feedUrl && isGithubRepo(githubRepo);
  const url = fromGithub ? GITHUB_LATEST(githubRepo) : feedUrl;
  if (!url) return { configured: false };
  if (!/^https:\/\//.test(url)) throw new Error('The update link must start with https://');
  let data;
  try {
    let res;
    if (fromGithub) {
      res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RetroConnect' } });
      if (res.status === 404) throw new Error('no releases published yet (or the repo is private)');
    } else {
      // Cache-buster: gist "raw" links are cached for a few minutes.
      const sep = url.includes('?') ? '&' : '?';
      res = await fetchImpl(`${url}${sep}t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = JSON.parse(await res.text());
  } catch (err) {
    throw new Error(`Couldn't check for updates: ${err.message}`);
  }
  // A custom update link may also point at a GitHub releases API URL.
  const feed = data && data.tag_name ? feedFromRelease(data) : validFeed(data);
  return {
    configured: true,
    current: currentVersion,
    latest: feed.version,
    available: compareVersions(feed.version, currentVersion) > 0,
    url: feed.url,
    pageUrl: feed.pageUrl || feed.url,
    asset: feed.asset || null,
    notes: feed.notes,
    source: fromGithub ? `github.com/${githubRepo}` : url,
    checkedAt: Date.now(),
  };
}

module.exports = { checkForUpdate, validFeed, feedFromRelease, downloadAsset, isGithubRepo, GITHUB_LATEST };
