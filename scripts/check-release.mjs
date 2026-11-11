import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function evaluateRelease(report) {
  const failures=[];
  if(report.baseline!=='docs/Home_Durable_Agent_v1.1/SRS.md')failures.push('需求基线必须为 v1.1');
  for(const [prefix,count] of [['AT',24],['MT',6],['GM',5]])for(let n=1;n<=count;n++) {
    const id=`${prefix}-${String(n).padStart(3,'0')}`,rows=(report.cases??[]).filter(c=>c.id===id),item=rows[0];
    if(rows.length>1)failures.push(`${id}: DUPLICATE`);
    if(!item||item.status!=='PASS'||!Array.isArray(item.evidence)||!item.evidence.length)failures.push(`${id}: ${item?.status??'MISSING'}`);
    for(const evidence of item?.evidence??[])if(typeof evidence!=='string'||!existsSync(resolve(root,evidence)))failures.push(`${id}: 证据不存在 ${String(evidence)}`);
  }
  const env=report.environment??{};
  for(const platform of ['linux/amd64','linux/arm64'])if(!env.verifiedPlatforms?.includes(platform))failures.push(`缺少实际镜像启动验收：${platform}`);
  if(!Number.isFinite(env.soakDurationMs)||env.soakDurationMs<72*3600000)failures.push('缺少完整72小时稳定性证据');
  if(env.openWrtVerified!==true)failures.push('缺少真实OpenWrt部署验收');
  if(env.realModelVerified!==true||env.realTelegramVerified!==true)failures.push('缺少真实模型或Telegram闭环验收');
  if(env.realGmailVerified!==true)failures.push('缺少真实Gmail授权及发送验收');
  for(const source of ['openclaw','hermes'])if(!env.realMigrationSourcesVerified?.includes(source))failures.push(`缺少真实来源备份验收：${source}`);
  for(const name of ['dependencyAudit','secretScan','containerScan'])if(report.security?.[name]?.status!=='PASS')failures.push(`缺少通过的安全门禁：${name}`);
  const scan=report.security?.containerScan;
  if(scan?.status==='PASS'&&(scan.high!==0||scan.critical!==0))failures.push('容器仍有未解决的高危或严重漏洞');
  return failures;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const report=JSON.parse(await readFile(new URL('../docs/acceptance-results.json',import.meta.url),'utf8'));
  const failures=evaluateRelease(report);
  console.log(JSON.stringify({releasable:failures.length===0,failures},null,2));
  if(failures.length)process.exitCode=1;
}
