import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// pnpm release [patch|minor|major|x.y.z] [--dry-run]
// Bump the version, commit, tag and push. The tag triggers .github/workflows/release.yml,
// which builds the zip, publishes a GitHub release and submits it to the Chrome Web Store.
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find(arg => !arg.startsWith('--')) ?? 'patch';

const run = (cmd, cmdArgs, options = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })?.trim();
const step = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
const fail = message => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  fail(`Unknown bump "${bump}", use patch, minor, major or x.y.z`);
}

const isNewer = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`Releases are cut from main, currently on ${branch}`);
if (run('git', ['status', '--porcelain'])) fail('Working tree has uncommitted changes');

run('git', ['fetch', 'origin', 'main', '--tags']);
const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).split(/\s+/).map(Number);
if (behind > 0) fail(`main is ${behind} commit(s) behind origin/main, pull first`);

const pkgPath = new URL('../package.json', import.meta.url);
const pkgText = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgText);
const version = nextVersion(pkg.version, bump);
const tag = `v${version}`;
if (!isNewer(version, pkg.version)) fail(`${version} is not newer than the current ${pkg.version}`);
if (run('git', ['tag', '--list', tag])) fail(`Tag ${tag} already exists`);

console.log(`Releasing ${pkg.version} → ${version}${ahead ? ` (also pushing ${ahead} unpushed commit(s))` : ''}`);

step('pnpm', ['test']);
step('pnpm', ['zip']);

if (dryRun) {
  console.log(`Dry run: would commit, tag ${tag} and push to origin`);
  process.exit(0);
}

writeFileSync(pkgPath, pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
step('git', ['commit', '--quiet', '-m', `chore: release ${tag}`, '--', 'package.json']);
step('git', ['tag', '-a', tag, '-m', tag]);
step('git', ['push', '--atomic', 'origin', 'main', tag]);

const repo = run('git', ['remote', 'get-url', 'origin']).replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
console.log(`✔ Pushed ${tag}. Build, GitHub release and Chrome Web Store submission run in CI: ${repo}/actions`);
