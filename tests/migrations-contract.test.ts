import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../src/control/store.js';
import { MigrationEngine } from '../src/migrations/core.js';
import { MigrationService, type SourceImporter } from '../src/migrations/index.js';
import { createGmailConnector, type AppConnector } from '../src/connectors/index.js';

test('cron draft preserves source metadata and reports missing fields',()=>{
  const dir=mkdtempSync(join(tmpdir(),'migration-contract-'));const store=new ControlStore(dir);
  try {const engine=new MigrationEngine(store);const plan=engine.plan({system:'hermes',instanceId:'a',version:'test',warnings:[],items:[{type:'cron',sourceId:'1',content:{name:'a',expression:'0 9 * * *',timezone:'UTC',prompt:'x',runMode:'isolated',targetChannel:'telegram',requiredCapabilities:['web']}},{type:'cron',sourceId:'2',content:{}}]});engine.stage(plan);engine.apply(plan.id,plan.hash);expect(engine.nativeDraft(plan.items[0]!.targetId)).toMatchObject({enabled:false,draft:{runMode:'isolated',targetChannel:'telegram',requiredCapabilities:['web'],enabled:false},missing:[]});expect(engine.nativeDraft(plan.items[1]!.targetId).missing).toEqual(expect.arrayContaining(['runMode','targetChannel','requiredCapabilities']));expect(store.list('schedules')).toHaveLength(0);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('production importer contract uses real stages and rejects unapproved apply',()=>{
  const dir=mkdtempSync(join(tmpdir(),'migration-contract-'));const store=new ControlStore(dir);
  try {const importer:SourceImporter=new MigrationService(store,{readonlyRoots:[]});const inventory={system:'hermes' as const,instanceId:'one',version:'hermes:state-schema-33',formatVersion:'hermes:state-schema-33',sourceVersion:null,warnings:[],items:[{type:'memory',sourceId:'m',content:'hello'}]};importer.validate(inventory);const plan=importer.plan(inventory);expect(plan.inventory).toMatchObject({formatVersion:'hermes:state-schema-33',sourceVersion:null});const batch=importer.stage(plan);expect(()=>importer.apply(batch.id,'wrong')).toThrow('MIGRATION_APPROVAL_MISMATCH');importer.apply(batch.id,plan.hash);expect(importer.verify(batch.id).ok).toBe(true);expect(importer.rollback(batch.id).removed).toHaveLength(1);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('production Gmail connector delegates authorization and creates only governed intents',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'connector-contract-'));const store=new ControlStore(dir);
  try {const redirect='https://example.com/callback';const connector:AppConnector=createGmailConnector(store,{oauth:{clientId:'test',redirectUris:[redirect]},artifacts:{read:()=>{throw new Error('unused');}},accountForConnection:()=>undefined});expect(connector.manifest().name).toBe('gmail');expect(connector.listActions()[0]?.risk).toBe('EXTERNAL_SEND');expect(connector.discoverScopes()).toHaveLength(1);await expect(connector.connect({phase:'start',request:{principalId:'other',redirectUri:redirect}})).rejects.toThrow('Owner');const started=await connector.connect({phase:'start',request:{principalId:'owner',redirectUri:redirect}});expect(started.authorizationUrl).toContain('accounts.google.com');expect(()=>connector.test('missing','other')).toThrow('Owner');expect(connector.test('missing','owner')).toBeUndefined();expect(()=>connector.invoke({connectionId:'missing',account:'a@example.com',taskId:'t',principalId:'owner',profileId:'p',workflowId:'w',templateId:'x',expiresAt:Date.now()+10000,mail:{to:['b@example.com'],subject:'s',plainText:'body'}})).toThrow('CONNECTION_UNAVAILABLE');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
