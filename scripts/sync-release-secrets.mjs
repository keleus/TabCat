import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// pnpm release:secrets [--skip-check]
// Copy the Chrome Web Store credentials from local environment variables into GitHub
// Actions secrets, after checking them against the store with a dry-run submission.
//
//   CHROME_PUBLISHER_ID                    Developer Dashboard → Account → Publisher ID
//   CHROME_SERVICE_ACCOUNT_KEY_FILE        path to the service account's JSON key, or instead:
//   CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL    client_email from that JSON key
//   CHROME_SERVICE_ACCOUNT_PRIVATE_KEY     private_key from that JSON key ("\n" escapes are fine)
const EXTENSION_ID = 'hgblemcigdpgbhdmkhfoeicmpnhkmngg';
const env = process.env;
const fail = message => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

let clientEmail = env.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL;
let privateKey = env.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY;
if (env.CHROME_SERVICE_ACCOUNT_KEY_FILE) {
  const keyFile = JSON.parse(readFileSync(env.CHROME_SERVICE_ACCOUNT_KEY_FILE, 'utf8'));
  clientEmail = keyFile.client_email;
  privateKey = keyFile.private_key;
}
privateKey = privateKey?.replaceAll('\\n', '\n').trim();

const secrets = {
  CHROME_PUBLISHER_ID: env.CHROME_PUBLISHER_ID?.trim(),
  CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: clientEmail?.trim(),
  CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
};
const missing = Object.entries(secrets).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) fail(`Missing ${missing.join(', ')} (see the comment at the top of this script)`);

if (!process.argv.includes('--skip-check')) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const zip = `output/tabcat-${version}-chrome.zip`;
  if (!existsSync(zip)) execFileSync('pnpm', ['zip'], { stdio: 'inherit' });
  console.log('Checking credentials against the Chrome Web Store (dry run, nothing is uploaded)…');
  execFileSync('pnpm', ['wxt', 'submit', '--dry-run', '--chrome-zip', zip], {
    stdio: 'inherit',
    env: { ...env, ...secrets, CHROME_API_VERSION: 'v2', CHROME_EXTENSION_ID: EXTENSION_ID },
  });
}

for (const [name, value] of Object.entries(secrets)) {
  execFileSync('gh', ['secret', 'set', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
}
console.log('✔ GitHub Actions secrets updated');
