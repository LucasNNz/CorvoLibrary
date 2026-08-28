import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/mcp/route.ts', import.meta.url), 'utf8');
const cap = fs.readFileSync(new URL('../app/c/[code]/mcp/route.ts', import.meta.url), 'utf8');
const connection = fs.readFileSync(new URL('../app/api/mcp-connection/route.ts', import.meta.url), 'utf8');

test('MCP public capability endpoint is independent from panel login', () => {
  assert.ok(!route.includes('getLibrarySession'));
  assert.ok(!route.includes('isOwnerRequest'));
  assert.match(route, /export async function HEAD\(\)/);
  assert.match(route, /authentication:\s*"none"/);
  assert.match(route, /MCP endpoint not found\./);
  assert.ok(!route.includes('Código MCP inválido ou revogado." }, 401'));
  assert.match(cap, /HEAD/);
});

test('MCP connection UI explicitly instructs ChatGPT No authentication and public Vercel production', () => {
  assert.match(connection, /authentication_type:\s*"none"/);
  assert.match(connection, /Sem autenticação/);
  assert.match(connection, /Deployment Protection desativado/);
});
