import {expect,test} from 'vitest';
const script='../scripts/check-release.mjs';
const ids=[...Array.from({length:24},(_,i)=>`AT-${String(i+1).padStart(3,'0')}`),...Array.from({length:6},(_,i)=>`MT-${String(i+1).padStart(3,'0')}`),...Array.from({length:5},(_,i)=>`GM-${String(i+1).padStart(3,'0')}`)];
function report(){return {security:{dependencyAudit:{status:'PASS'},secretScan:{status:'PASS'},containerScan:{status:'PASS',high:0,critical:0}},baseline:'docs/Home_Durable_Agent_v1.1/SRS.md',environment:{verifiedPlatforms:['linux/arm64','linux/amd64'],soakDurationMs:72*3600000,openWrtVerified:true,realModelVerified:true,realTelegramVerified:true,realGmailVerified:true,realMigrationSourcesVerified:['openclaw','hermes']},cases:ids.map(id=>({id,status:'PASS',evidence:['tests/control-health.test.ts']}))};}
test('v1.1 release gate requires all P0 acceptance families and actual external verification',async()=>{
 const {evaluateRelease}=await import(script);const r=report();
 expect(evaluateRelease(r)).toEqual([]);
 for(const id of ['MT-001','GM-001']){const missing=report();missing.cases=missing.cases.filter(c=>c.id!==id);expect(evaluateRelease(missing)).toContain(`${id}: MISSING`);}
 const external=report();external.environment.realGmailVerified=false;external.environment.realMigrationSourcesVerified=[];expect(evaluateRelease(external).length).toBeGreaterThanOrEqual(3);
 const vulnerable=report();vulnerable.security.containerScan.high=1;expect(evaluateRelease(vulnerable).some((f:string)=>f.includes('漏洞'))).toBe(true);
 const bad=report();bad.cases[0]!.evidence=['missing-evidence-file'];expect(evaluateRelease(bad).some((f:string)=>f.includes('missing-evidence-file'))).toBe(true);
 const duplicate=report();duplicate.cases.push({...duplicate.cases[0]!});expect(evaluateRelease(duplicate).some((f:string)=>f.includes('DUPLICATE'))).toBe(true);
});
