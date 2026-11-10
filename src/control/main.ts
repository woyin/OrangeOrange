import { startControlServer } from './server.js';
const app = await startControlServer({ dataDir: process.env.HDA_DATA_DIR ?? '/data', workspace: process.env.HDA_WORKSPACE ?? '/workspace', host: process.env.HDA_HOST ?? '0.0.0.0', port: Number(process.env.HDA_PORT ?? 8787), webDir: process.env.HDA_WEB_DIR ?? 'apps/web/dist', publicOrigin: process.env.HDA_PUBLIC_ORIGIN, trustProxy: process.env.HDA_TRUST_PROXY === 'true' });
console.log(JSON.stringify({ level: 'info', event: 'control.started', port: Number(process.env.HDA_PORT ?? 8787) }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => { if (closing)
        return; closing = true; void app.close().then(() => process.exit(0), () => process.exit(1)); });
