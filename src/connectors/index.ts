import type { ControlStore } from '../control/store.js';
import { GmailActions, artifactResolver, type SendDependencies } from './actions.js';
import { GoogleOAuthClient, type GoogleOAuthConfig } from './oauth.js';
import { buildGmailMimeMessage } from './mime.js';

export * from './actions.js';
export * from './oauth.js';
export * from './mime.js';

/** Account addresses must come from an Owner-controlled binding, never model input. */
export function createGmailConnector(store:ControlStore, options:{
  oauth:GoogleOAuthConfig;
  artifacts:{read(id:string):{bytes:Buffer;sha256:string;mimeType:string}};
  accountForConnection:(id:string)=>string|undefined;
  fetcher?:typeof fetch;
  now?:()=>number;
  authorizeTask?:SendDependencies['authorizeTask'];
}) {
  const oauth=new GoogleOAuthClient(store,options.oauth);
  const actions=new GmailActions(store,{
    authorizeTask:options.authorizeTask,
    connection:id=>{const status=oauth.publicStatus(id),account=options.accountForConnection(id);return status&&account?{status:status.status,account}:undefined;},
    accessToken:async id=>(await oauth.accessToken(id,'owner')).accessToken,
    resolveArtifact:artifactResolver(options.artifacts),
    buildMessage:async (mail,messageId,attachments,account)=>buildGmailMimeMessage({from:account,to:mail.to,cc:mail.cc,bcc:mail.bcc,subject:mail.subject,plainText:mail.plainText,html:mail.html,messageId,attachments:attachments.map(a=>({filename:a.filename,mimeType:a.contentType,bytes:a.bytes,sha256:a.sha256,sizeBytes:a.size}))}).raw,
    fetch:options.fetcher,
    now:options.now,
    markNeedsReauth:id=>{const c=store.get<Record<string,unknown>>('app_connections',id);if(c&&c.status!=='REVOKED')store.put('app_connections',id,{...c,status:'NEEDS_REAUTH',updatedAt:(options.now??Date.now)(),error:{code:'REAUTHORIZATION_REQUIRED',message:'Gmail rejected the access token',at:(options.now??Date.now)()}});},
  });
  return {oauth,actions};
}
