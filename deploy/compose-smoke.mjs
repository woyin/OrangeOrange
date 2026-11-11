import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
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
let base,browser;
async function ready(){
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  const id=compose('ps','-q','hda'),info=JSON.parse(run('docker',['inspect',id]))[0];
  const port=info.NetworkSettings.Ports?.['8787/tcp']?.[0]?.HostPort;
  if(port){base='http://127.0.0.1:'+port;try{if((await fetch(base+'/health/ready',{signal:AbortSignal.timeout(2000)})).ok)return;}catch{}}
  await new Promise(r=>setTimeout(r,250));
 }
 throw new Error('COMPOSE_READINESS_TIMEOUT');
}
try{
 compose('up','-d','--no-build');await ready();
 assert.equal((await fetch(base+'/api/v1/tasks')).status,401);
 const ownerPass=randomUUID()+randomUUID(),modelKey=randomUUID();
 const fixtureServer="const http=require('node:http');http.createServer(async(req,res)=>{if(req.url==='/health'){res.end('ok');return;}if(req.url!=='/v1/chat/completions'||req.headers.authorization!=='Bearer '+process.argv[1]){res.writeHead(401);res.end();return;}for await(const chunk of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});const c={id:'compose-proxy',object:'chat.completion.chunk',created:1,model:'gpt-4.1-mini',choices:[{index:0,delta:{role:'assistant',content:'Docker proxy reply'},finish_reason:null}]};res.write('data: '+JSON.stringify(c)+'\\n\\n');res.write('data: '+JSON.stringify({...c,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\\n\\n');res.end('data: [DONE]\\n\\n');}).listen(19090,'127.0.0.1');";
 run('docker',['exec','-d',compose('ps','-q','hda'),'node','-e',fixtureServer,modelKey]);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.goto(base);await expect(page.getByRole('heading',{name:'首次配置家庭 Agent'})).toBeVisible();
 const username=page.getByLabel('管理员用户名'),passwordInput=page.getByLabel('密码',{exact:false}).first();
 await expect(passwordInput).toHaveAttribute('minlength','12');
 await username.fill('compose-owner');await passwordInput.fill('too-short');
 await page.getByLabel('模型提供商').selectOption('openai');await page.getByLabel('API 地址（可选）').fill('http://127.0.0.1:19090/v1');await page.getByLabel('模型 ID').fill('vendor/custom-model');await page.getByLabel('模型密钥').fill(modelKey);
 await page.getByRole('button',{name:'完成配置'}).click();assert.equal(await passwordInput.evaluate(input=>input.validity.tooShort),true);
 await passwordInput.evaluate(input=>input.removeAttribute('minlength'));
 await page.getByRole('button',{name:'完成配置'}).click();await expect(page.getByRole('alert')).toContainText('管理员密码至少需要 12 个字符');
 await expect(username).toHaveValue('compose-owner');await expect(page.getByLabel('模型密钥')).toHaveValue(modelKey);
 await passwordInput.fill(ownerPass);await page.getByRole('button',{name:'完成配置'}).click();await expect(page.getByRole('button',{name:'注销会话'})).toBeVisible();
 await page.getByRole('navigation').getByRole('button',{name:'对话',exact:true}).click();await expect(page.getByRole('heading',{name:'对话',exact:true,level:2})).toBeVisible();
 await page.getByRole('button',{name:'新增',exact:true}).click();await page.getByLabel('会话名称').fill('Docker endpoint check');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'查看详情'}).click();
 await page.getByLabel('消息',{exact:true}).fill('Check custom endpoint');await page.getByRole('button',{name:'发送消息'}).click();
 await expect(page.locator('.messages')).toContainText('Docker proxy reply',{timeout:20000});
 compose('restart','hda');await ready();await page.goto(base);await expect(page.getByRole('button',{name:'注销会话'})).toBeVisible();
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.getByRole('button',{name:'注销会话'}).click();
  await expect(page.getByRole('heading',{name:'登录家庭 Agent'})).toBeVisible();
  await username.fill('compose-owner');await passwordInput.fill('wrong-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('管理员用户名或密码不正确');await expect(username).toHaveValue('compose-owner');
  await passwordInput.fill(ownerPass);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'注销会话'})).toBeVisible();
 }
 console.log('PASS: production Compose + Chromium; weak-password validation and retry, setup, container restart/session persistence, desktop/mobile logout and login, real chat through a local OpenAI-compatible endpoint. Isolated volumes removed; no real external service calls.');
}finally{try{await browser?.close();}finally{try{compose('down','--volumes','--remove-orphans');}finally{await rm(dir,{recursive:true,force:true});}}}
