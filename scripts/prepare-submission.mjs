#!/usr/bin/env node
// Private export and secret-free source packaging; never prints secret values.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function command(name, args, options = {}) {
  const result = spawnSync(name, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status}); no credential output is displayed.`);
  return result.stdout;
}
const rawEnvironment = readFileSync(join(root, '.env'), 'utf8');
const values = new Map();
for (const line of rawEnvironment.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if (/^['"]/.test(value)) {
    const quote = value[0];
    if (value.at(-1) !== quote) throw new Error(`Unsupported multiline/quoted value for ${match[1]}; export halted.`);
    value = value.slice(1, -1);
  } else value = value.replace(/\s+#.*$/, '').trim();
  values.set(match[1], value);
}
const credentialName = /(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCOUNT_SID|VERIFY_SERVICE_SID|MESSAGING_SERVICE_SID|TEMPLATE_SID)/;
const documentedDevelopmentSecrets = new Set(['change-me-in-production', 'local-development-secret-change-this-32chars', 'replace-with-a-local-secret']);
const keys = [...values].filter(([name, value]) => credentialName.test(name) && value);
const configuredNeedles = keys.filter(([name, value]) => value.length >= 12 && !(name === 'JWT_SECRET' && documentedDevelopmentSecrets.has(value)));
const findings = [];
const strongPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
function inspect(content, location) {
  for (const [name, value] of configuredNeedles) {
    if (content.includes(value)) findings.push(`${location}: contains configured ${name}`);
  }
  for (const pattern of strongPatterns) {
    if (pattern.test(content)) findings.push(`${location}: recognizable private key/token pattern`);
  }
}
function inspectArchive(bytes, location) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return;
  const directory = mkdtempSync(join(tmpdir(), 'bharatmail-key-audit-'));
  const archive = join(directory, 'source.zip');
  writeFileSync(archive, bytes, { mode: 0o600 });
  // Extract to memory, not to a path controlled by an untrusted ZIP member.
  const text = command('unzip', ['-p', archive], { maxBuffer: 128 * 1024 * 1024 });
  inspect(text, `${location} (uncompressed ZIP contents)`);
}
const sourceFiles = [...new Set(command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
const excluded = /(^|\/)(?:\.git|node_modules|dist|build|coverage|test-results|playwright-report|storage|local-mail|\.expo)(\/|$)|(^|\/)\.env(?:\..*)?$|(?:auth-keys.*|.*environment-upload.*)\.txt$|\.zip$|(?:^|\/)\.DS_Store$/;
const files = sourceFiles.filter(path => !excluded.test(path) || /(?:^|\/)\.env\.example$/.test(path));
for (const path of files) {
  const bytes = readFileSync(join(root, path));
  inspect(bytes.toString('utf8'), path);
  inspectArchive(bytes, path);
}
const currentSourceFindings = findings.length;

// Inspect publishable branches/tags, including deleted files. Local stashes are
// private recovery data: normal `git push origin main` does not publish them.
const publishableRefs = command('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']).trim().split('\n').filter(Boolean);
const objects = command('git', ['rev-list', '--objects', ...publishableRefs]).trim().split('\n').filter(Boolean).map(line => line.split(' ')[0]);
const batch = command('git', ['cat-file', '--batch'], { input: objects.join('\n') + '\n', encoding: null });
let offset = 0;
while (offset < batch.length) {
  const end = batch.indexOf(10, offset);
  if (end < 0) break;
  const [sha, type, sizeText] = batch.subarray(offset, end).toString().split(' ');
  const size = Number(sizeText);
  if (!Number.isFinite(size)) throw new Error('Cannot inspect Git history object.');
  const content = batch.subarray(end + 1, end + 1 + size);
  if (type === 'blob') {
    inspect(content.toString('utf8'), `history blob ${sha.slice(0, 12)}`);
    inspectArchive(content, `history blob ${sha.slice(0, 12)}`);
  }
  offset = end + 1 + size + 1;
}
if (findings.length) {
  console.error('Secret scan findings (values withheld):\n' + [...new Set(findings)].join('\n'));
  if (currentSourceFindings || !process.argv.includes('--export-private')) process.exit(1);
  console.error('Exporting clean current source only. REPOSITORY MUST STAY PRIVATE: published-history credential cleanup and provider rotation require owner approval.');
}
else console.log(`Secret scan passed: ${files.length} source files and ${objects.length} publishable historical Git objects; local stashes excluded, not a guarantee against unknown secret formats.`);
if (process.argv.includes('--audit-only')) process.exit(0);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || join(homedir(), 'Downloads', `bharatmail-submission-${stamp}`));
if (output === root || !relative(root, output).startsWith('..')) throw new Error('Private output must be outside the repository.');
mkdirSync(output, { recursive: false, mode: 0o700 });
const privateDirectory = join(output, 'private');
mkdirSync(privateDirectory, { mode: 0o700 });
// A fresh evaluator DB must not reuse the publicly documented development signer.
// Do not invalidate owner sessions by changing the running repository environment.
const refreshSubmissionSigner = documentedDevelopmentSecrets.has(values.get('JWT_SECRET')) || (values.get('JWT_SECRET') || '').length < 32;
let exportedEnvironment = rawEnvironment;
if (refreshSubmissionSigner) {
  const signingSecret = randomBytes(32).toString('hex');
  values.set('JWT_SECRET', signingSecret);
  const existing = keys.findIndex(([name]) => name === 'JWT_SECRET');
  if (existing >= 0) keys[existing] = ['JWT_SECRET', signingSecret];
  else keys.push(['JWT_SECRET', signingSecret]);
  exportedEnvironment = rawEnvironment.replace(/^\s*(?:export\s+)?JWT_SECRET\s*=.*$/gm, `JWT_SECRET=${signingSecret}`);
  if (!/^JWT_SECRET=/m.test(exportedEnvironment)) exportedEnvironment += `\nJWT_SECRET=${signingSecret}\n`;
}
for (const filename of ['.env', 'bharatmail-environment-upload.txt']) {
  writeFileSync(join(privateDirectory, filename), exportedEnvironment, { mode: 0o600 });
}
writeFileSync(join(privateDirectory, 'auth-keys.txt'), keys.map(([name, value]) => `.env ${name} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });

const staging = mkdtempSync(join(tmpdir(), 'bharatmail-submission-'));
const stagedRoot = join(staging, 'bharatmail');
mkdirSync(stagedRoot, { mode: 0o700 });
for (const path of files) {
  const target = join(stagedRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, path), target);
}
writeFileSync(join(stagedRoot, '.env'), '', { mode: 0o600 });
const archive = join(output, 'bharatmail-source.zip');
command('zip', ['-q', '-r', archive, 'bharatmail'], { cwd: staging });
const members = command('unzip', ['-Z1', archive]).split('\n').filter(Boolean);
if (members.some(path => /(?:^|\/)(?:\.git|node_modules|dist|private)(?:\/|$)/.test(path))) throw new Error('Unexpected private/generated archive member.');
if (command('unzip', ['-p', archive, 'bharatmail/.env']) !== '') throw new Error('Archive environment placeholder must be empty.');
const manifest = {
  created: new Date().toISOString(), branch: command('git', ['branch', '--show-current']).trim(),
  head: command('git', ['rev-parse', 'HEAD']).trim(),
  workingTreeChanged: Boolean(command('git', ['status', '--porcelain']).trim()),
  sourceFiles: files.length, archiveEntries: members.length,
  archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  rootEnvironmentPlaceholder: 'empty and present in source ZIP; ignored in Git',
  freshSubmissionSigningSecret: refreshSubmissionSigner,
  privateEnvironmentLocations: ['private/.env', 'private/bharatmail-environment-upload.txt'],
  authKeyLocation: 'private/auth-keys.txt', credentialVariables: keys.map(([name]) => name),
  secretScan: 'Configured credentials of length >=12 and recognizable token/private-key patterns; current source and publishable local/remote branches and tags, including ZIP contents. Private local stashes excluded. Unknown secrets may require manual review.',
  auditedRefs: publishableRefs,
  localRecoveryWarning: 'Local stash includes a historical review ZIP containing a real .env. It is not reachable from main/origin/main and is excluded from normal main pushes and source exports. Keep it private; do not push --mirror or upload .git.',
  currentSourceSecretScanPassed: currentSourceFindings === 0,
  gitHistorySecretScanPassed: findings.length === 0,
  historyCredentialFindings: [...new Set(findings)],
  publicRepositoryReady: findings.length === 0,
  deadline: 'Not supplied; compare final main commit time with evaluator cutoff.',
  note: 'Never upload the private directory to GitHub. This archive excludes database contents and existing accounts.'
};
writeFileSync(join(output, 'submission-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
chmodSync(archive, 0o600);
console.log(JSON.stringify({ output, archive, environmentText: join(privateDirectory, 'bharatmail-environment-upload.txt'), authKeys: join(privateDirectory, 'auth-keys.txt'), credentialCount: keys.length, manifest: join(output, 'submission-manifest.json') }, null, 2));
