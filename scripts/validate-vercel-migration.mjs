import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const errors = [];
const notes = [];

async function files(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (['node_modules', '.next', '.git', 'docs', 'tests'].includes(name)) continue;
    const path = join(dir, name), info = await stat(path);
    if (info.isDirectory()) out.push(...await files(path));
    else out.push(path);
  }
  return out;
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const [script, expected] of Object.entries({ dev: 'next dev', build: 'next build', start: 'next start' })) {
  if (packageJson.scripts?.[script] !== expected) errors.push(`script ${script} != ${expected}`);
}
for (const dep of ['vinext','vite','wrangler','@cloudflare/vite-plugin','@cf-wasm/photon','@cf-wasm/png','@jsquash/avif']) {
  if (packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]) errors.push(`legacy dependency: ${dep}`);
}
for (const dep of ['@libsql/client','@aws-sdk/client-s3','@vercel/functions','sharp']) {
  if (!packageJson.dependencies?.[dep]) errors.push(`missing dependency: ${dep}`);
}

const sourceFiles = (await files(root)).filter((path) => /\.(ts|tsx|js|mjs|json)$/.test(path));
for (const path of sourceFiles) {
  if (path.endsWith('scripts/validate-vercel-migration.mjs')) continue;
  const text = await readFile(path, 'utf8');
  for (const marker of ['cloudflare:workers','vinext/server','@cf-wasm/','@jsquash/']) {
    if (text.includes(marker)) errors.push(`${relative(root,path)} contains ${marker}`);
  }
}


const configCrypto = await readFile(join(root, 'lib/config-crypto.ts'), 'utf8');
if (!configCrypto.includes('getLibraryMasterKey') || !configCrypto.includes('v2.')) errors.push('persistent config must use the stable Library master key');
const masterKey = await readFile(join(root, 'lib/master-key.ts'), 'utf8');
for (const marker of ['library_master_key_v1','TURSO_AUTH_TOKEN','passwordWrapSalt']) if (!masterKey.includes(marker)) errors.push(`master-key recovery missing ${marker}`);
const auth = await readFile(join(root, 'lib/auth.ts'), 'utf8');
for (const marker of ['library_auth_v1','corvo_library_session','PBKDF2','HttpOnly']) if (!auth.includes(marker)) errors.push(`Library auth missing ${marker}`);
const access = await readFile(join(root, 'lib/mcp-access.ts'), 'utf8');
if (access.includes('sec-fetch-site') || access.includes('oai-authenticated-user-email')) errors.push('owner auth still trusts legacy/same-origin headers');
const secureSettings = await readFile(join(root, 'lib/secure-settings.ts'), 'utf8');
for (const marker of ['d1ApiToken','d1DatabaseId','encryptPersistedConfig']) {
  if (!secureSettings.includes(marker)) errors.push(`persistent Cloudflare config missing ${marker}`);
}
const cloudflareRoute = await readFile(join(root, 'app/api/cloudflare-connection/route.ts'), 'utf8');
if (!cloudflareRoute.includes('resolveCorvoD1Database')) errors.push('Cloudflare UI route must validate/discover D1 before save');
notes.push('persistent config: R2 + D1 in Turso with stable master-key recovery');
notes.push('dashboard auth: username/password + persistent HttpOnly session');
const legacyReference = await readFile(join(root, 'lib/legacy-config-reference.ts'), 'utf8');
for (const marker of ['cloudflare_connection_manifest_v1','secret_cloudflare_connection','corvo-library']) {
  if (!legacyReference.includes(marker)) errors.push(`legacy config reference missing ${marker}`);
}
if (!secureSettings.includes('saveCloudflareManifest')) errors.push('persistent Cloudflare config must maintain non-secret recovery manifest');
const migrationScript = await readFile(join(root, 'scripts/migrate-sqlite-to-turso.mjs'), 'utf8');
if (!migrationScript.includes('cloudflare_connection_manifest_v1')) errors.push('D1 migration must create inherited config reference manifest');
notes.push('legacy config: imported settings preserved + non-secret recovery manifest');

const d1Migration = await readFile(join(root, 'lib/d1-to-turso-migration.ts'), 'utf8');
for (const marker of ['createTargetBackup','rollbackLastD1Migration','restoreVercelBootstrapSettings']) if (!d1Migration.includes(marker)) errors.push(`D1 migration safety missing ${marker}`);
notes.push('D1 migration: R2 snapshot + automatic/manual rollback');

const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
if (Array.isArray(vercel.crons) && vercel.crons.length > 0) {
  errors.push('Vercel Cron must stay disabled; periodic scheduling is ChatGPT -> MCP');
}

const routeFiles = sourceFiles.filter((path) => path.endsWith('/route.ts'));
notes.push(`route handlers: ${routeFiles.length}`);
notes.push(`runtime adapter: lib/platform/runtime.ts`);
notes.push(`data plane: lib/data-plane.ts`);

if (errors.length) {
  console.error('VERCEL_MIGRATION_VALIDATION_FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('VERCEL_MIGRATION_STATIC_OK');
for (const note of notes) console.log(`- ${note}`);
