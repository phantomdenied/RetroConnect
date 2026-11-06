#!/usr/bin/env node
'use strict';
// Prints the update file to paste into your public Gist after a release:
//   npm run update-feed -- "https://link-to-the-installer" "What changed"
const { version } = require('../package.json');
const [url, notes = ''] = process.argv.slice(2);
if (!url || !/^https:\/\//.test(url)) {
  console.error('Usage: npm run update-feed -- "<https download link>" ["release notes"]');
  process.exit(1);
}
console.log(JSON.stringify({ version, url, notes }, null, 2));
