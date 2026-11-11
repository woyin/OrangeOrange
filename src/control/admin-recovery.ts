import { constants, closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireOwnership } from '../ownership.js';
import { AuthService } from './security.js';
import { ControlStore } from './store.js';

function readPassword(file:string):string {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>4096)throw new Error('UNSAFE_PASSWORD_FILE');
    const bytes=Buffer.alloc(4097);let length=0;
    while(length<bytes.length) {
      const count=readSync(fd,bytes,length,bytes.length-length,null);
      if(count===0)break;
      length+=count;
    }
    if(length>4096)throw new Error('UNSAFE_PASSWORD_FILE');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
    return text.replace(/\r?\n$/, '');
  } finally {closeSync(fd);}
}

export async function recoverAdmin(args:string[]):Promise<void> {
  const values:Record<string,string>={};let confirmed=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i]!;
    if(arg==='--confirm-reset'&&!confirmed) {confirmed=true;continue;}
    if(!['--data-dir','--username','--password-file'].includes(arg)||values[arg]!==undefined||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('INVALID_ARGUMENTS');
    values[arg]=args[++i]!;
  }
  const dataDir=values['--data-dir'],username=values['--username'],file=values['--password-file'];
  if(!confirmed||!dataDir||!username||!file)throw new Error('INVALID_ARGUMENTS');
  // Refuse to initialize a new store or generate a replacement key during recovery.
  if(!statSync(join(dataDir,'app.sqlite')).isFile())throw new Error('DATABASE_MISSING');
  const keyFile=process.env.HDA_MASTER_KEY_FILE??join(dataDir,'master.key');
  if(!statSync(keyFile).isFile())throw new Error('MASTER_KEY_MISSING');
  const release=await acquireOwnership(dataDir);
  try {
    const store=new ControlStore(dataDir);
    try {new AuthService(store).recoverPassword(username,readPassword(file));}
    finally {store.close();}
  } finally {await release();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  recoverAdmin(process.argv.slice(2)).then(()=>{
    console.log('Administrator password recovery completed.');
  }).catch(()=>{
    console.error('Administrator password recovery failed. Check the service is stopped, arguments, database, master key and password file.');
    process.exitCode=1;
  });
}
