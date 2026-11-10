import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { startControlServer } from '../../src/control/server.js';
export async function fixture(useFaux = true) {
 const dir = await mkdtemp(join(tmpdir(), 'orange-browser-'));
 const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
 faux.setResponses(Array.from({length: 30}, () => fauxAssistantMessage('浏览器真实模型回答')));
 const app = await startControlServer({dataDir: join(dir,'data'), workspace: join(dir,'workspace'), webDir: 'apps/web/dist', port: 0, ...(useFaux ? {runtimeOptions: {models, provider:'faux'}} : {}), diskProbe: async()=>1e9});
 return {...app, async cleanup(){await app.close();await rm(dir,{recursive:true,force:true});}};
}
// Build once before all projects. Each test owns and cleans up its real server.
export default function buildWeb() {
 execFileSync('npm', ['run', 'build:web'], {stdio:'inherit'});
}
