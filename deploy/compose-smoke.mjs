import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),project='hda-compose-'+randomUUID().slice(0,8);
const dir=await mkdtemp(join(tmpdir(),'hda-compose-')),file=join(dir,'compose.json');
const command=spawnSync('docker',['compose','version'],{stdio:'ignore'}).status===0?['docker',['compose']]:['docker-compose',[]];
const run=(bin,args)=>execFileSync(bin,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const compose=(...args)=>run(command[0],[...command[1],'-p',project,'-f',file,...args]);
const config=JSON.parse(run(command[0],[...command[1],'-f','deploy/compose.yml','config','--format','json']));
config.name=project;config.services.hda.image=process.env.HDA_TEST_IMAGE??'hda:p0-arm64';delete config.services.hda.build;
config.services.hda.ports=[{target:8787,published:'0',host_ip:'127.0.0.1',protocol:'tcp'}];
for(const [key,value]of Object.entries(config.volumes??{}))value.name=project+'-'+key;
for(const [key,value]of Object.entries(config.networks??{}))value.name=project+'-'+key;
await writeFile(file,JSON.stringify(config),{mode:0o600});
let base;
async function ready(){
 const id=compose('ps','-q','hda'),info=JSON.parse(run('docker',['inspect',id]))[0];
 base='http://127.0.0.1:'+info.NetworkSettings.Ports['8787/tcp'][0].HostPort;
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){try{if((await fetch(base+'/health/ready')).ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}
 throw new Error('COMPOSE_READINESS_TIMEOUT');
}
try{
 compose('up','-d','--no-build');await ready();
 assert.equal((await fetch(base+'/api/v1/tasks')).status,401);
 const password=randomUUID()+randomUUID();
 const setup=await fetch(base+'/api/v1/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'compose-owner',password,timezone:'UTC'})});assert.equal(setup.status,200);
 compose('restart','hda');await ready();
 const status=await(await fetch(base+'/api/v1/setup/status')).json();assert.equal(status.data.initialized,true);
 const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'compose-owner',password})});assert.equal(login.status,200);
 console.log('PASS: resolved production Compose with isolated volumes and ephemeral loopback port; empty-volume setup, restart persistence and owner login. No external providers configured.');
}finally{try{compose('down','--volumes','--remove-orphans');}finally{await rm(dir,{recursive:true,force:true});}}
