import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.env.HDA_TEST_IMAGE ?? 'hda:runtime';
const suffix = randomUUID().slice(0, 8);
const container = `hda-smoke-${suffix}`;
const data = `${container}-data`;
const workspace = `${container}-workspace`;
const restoredContainer = `${container}-restore`, restoredData = `${restoredContainer}-data`, restoredWorkspace = `${restoredContainer}-workspace`;
let snapshotDirectory;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
async function waitReady(name) {
  const deadline=Date.now()+60000;
  while(Date.now()<deadline) {
    const info=JSON.parse(docker('inspect',name))[0];
    if(info.State?.Status==='exited')throw new Error('Container exited before readiness');
    const port=info.NetworkSettings.Ports?.['8787/tcp']?.[0]?.HostPort;
    if(port) {
      base=`http://127.0.0.1:${port}`;
      try{if((await fetch(`${base}/health/ready`,{signal:AbortSignal.timeout(2000)})).ok)return;}catch{}
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Container port mapping or readiness exceeded 60 seconds');
}
try {
  docker('run', '-d', '--name', container, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--memory', '1g', '--cpus', '2', '-p', '127.0.0.1::8787', '-v', `${data}:/data`, '-v', `${workspace}:/workspace:ro`, image);
  await waitReady(container);
  const inspected = JSON.parse(docker('inspect', container))[0];
  assert.equal(inspected.Config.User, 'node');
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.Privileged, false);
  assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
  assert.ok(inspected.Mounts.every(m => m.Type === 'volume'));
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/tasks`)).status, 401);
  const setup = await (await fetch(`${base}/api/v1/setup/status`)).json();
  assert.equal(setup.data.initialized, false);
  docker('restart', container);
  await waitReady(container);
  const ownerPassword = randomUUID() + randomUUID();
  let cookie = '', csrf = '';
  async function api(path, method = 'GET', body) {
    const response = await fetch(`${base}/api/v1/${path}`, { method, headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    return { response, json };
  }
  const initialized = await api('setup', 'POST', { username: 'smoke-owner', password: ownerPassword, timezone: 'UTC' });
  assert.equal(initialized.response.status, 200);
  cookie = initialized.response.headers.get('set-cookie').split(';')[0]; csrf = initialized.json.data.csrf;
  const conversation = await api('conversations', 'POST', { name: 'container-persistence' });
  assert.equal(conversation.response.status, 200);
  const memory = await api('memories', 'POST', { kind: 'semantic', scope: 'owner', content: 'container-memory', source: 'owner' });
  assert.equal(memory.response.status, 200);
  docker('restart', container);
  await waitReady(container);
  assert.equal((await api('auth/session')).response.status, 200);
  assert.equal((await api(`conversations/${conversation.json.data.id}`)).json.data.name, 'container-persistence');
  const snapshot = await api('backup', 'POST', { confirm: true, password: ownerPassword });
  assert.equal(snapshot.response.status, 200);
  assert.equal((await api(`conversations/${conversation.json.data.id}`, 'PATCH', { name: 'changed' })).response.status, 200);
  const restored = await api('restore', 'POST', { backupId: snapshot.json.data.id, confirm: true, password: ownerPassword });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.json.data.credentialsRequired, true);
  assert.equal((await api('auth/session')).response.status, 401);
  const login = await api('auth/login', 'POST', { username: 'smoke-owner', password: ownerPassword });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0]; csrf = login.json.data.csrf;
  assert.equal((await api(`conversations/${conversation.json.data.id}`)).json.data.name, 'container-persistence');
  assert.equal((await api('memories?q=container-memory&scope=owner')).json.data.items.length, 1);
  // Provision a separate empty volume, then restore a server-generated backup into it.
  // The fixture is copied with the container's normal node identity; no added capabilities.
  snapshotDirectory = await mkdtemp(join(tmpdir(), 'hda-container-restore-'));
  docker('cp', `${container}:/data/backups/${snapshot.json.data.id}`, snapshotDirectory);
  docker('run', '-d', '--name', restoredContainer, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--memory', '1g', '--cpus', '2', '-p', '127.0.0.1::8787', '-v', `${restoredData}:/data`, '-v', `${restoredWorkspace}:/workspace:ro`, image);
  await waitReady(restoredContainer); cookie = ''; csrf = '';
  const fresh = await api('setup', 'POST', { username: 'fresh-owner', password: ownerPassword, timezone: 'UTC' });
  assert.equal(fresh.response.status, 200);
  cookie = fresh.response.headers.get('set-cookie').split(';')[0]; csrf = fresh.json.data.csrf;
  assert.equal((await api('backups')).response.status, 200);
  const fixtureFiles = {};
  for (const name of ['app.sqlite', 'pi.sqlite', 'manifest.json']) fixtureFiles[name] = (await readFile(join(snapshotDirectory, snapshot.json.data.id, name))).toString('base64');
  execFileSync('docker', ['exec', '-i', restoredContainer, 'node', '-e', "const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const dir='/data/backups/'+process.argv[1];fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const name of ['app.sqlite','pi.sqlite','manifest.json'])fs.writeFileSync(dir+'/'+name,Buffer.from(input[name],'base64'),{mode:0o600});", snapshot.json.data.id], { input: JSON.stringify(fixtureFiles), encoding: 'utf8' });
  const cleanRestore = await api('restore', 'POST', { backupId: snapshot.json.data.id, confirm: true, password: ownerPassword });
  assert.equal(cleanRestore.response.status, 200);
  const restoredLogin = await api('auth/login', 'POST', { username: 'smoke-owner', password: ownerPassword });
  assert.equal(restoredLogin.response.status, 200);
  cookie = restoredLogin.response.headers.get('set-cookie').split(';')[0]; csrf = restoredLogin.json.data.csrf;
  assert.equal((await api(`conversations/${conversation.json.data.id}`)).json.data.name, 'container-persistence');
  assert.equal((await api('memories?q=container-memory&scope=owner')).json.data.items.length, 1);
  console.log('PASS: fresh-container restore; production image, non-root/read-only/cap-drop, health, Web, authentication, initialized volume restart, two-database backup/restore, old session revoked; no external model or Telegram verification');
} finally {
  for (const name of [container, restoredContainer]) { try { docker('rm', '-f', name); } catch {} }
  for (const volume of [data, workspace, restoredData, restoredWorkspace]) { try { docker('volume', 'rm', volume); } catch {} }
  if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true });
}
