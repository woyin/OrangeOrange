import type { ControlStore } from '../control/store.js';
import { GmailActions, artifactResolver, type SendDependencies } from './actions.js';
import { GoogleOAuthClient, type GoogleOAuthConfig } from './oauth.js';
import { buildGmailMimeMessage } from './mime.js';

export * from './actions.js';
export * from './oauth.js';
export * from './mime.js';

export interface AppConnector<Start = Parameters<GoogleOAuthClient['startAuthorization']>[0], Finish = Parameters<GoogleOAuthClient['completeAuthorization']>[0], StartResult = Awaited<ReturnType<GoogleOAuthClient['startAuthorization']>>, Connection = NonNullable<ReturnType<GoogleOAuthClient['connection']>>, ActionInput = Parameters<GmailActions['propose']>[0], ActionResult = ReturnType<GmailActions['propose']>> {
  manifest():ReturnType<GmailActions['manifest']>;
  discoverScopes():ReturnType<GmailActions['discoverScopes']>;
  connect(input:{phase:'start'; request:Start}):Promise<StartResult>;
  connect(input:{phase:'finish'; request:Finish}):Promise<Connection>;
  test(id:string,principalId:string):Connection|undefined;
  refresh(id:string,principalId:string):Promise<Connection>;
  revoke(id:string,principalId:string):Promise<void>;
  listActions():ReturnType<GmailActions['listActions']>;
  invoke(input:ActionInput):ActionResult;
}

/** The connector creates a governed intent; dispatch remains subject to approval. */
export class GmailConnector implements AppConnector {
  constructor(readonly oauth:GoogleOAuthClient,readonly actions:GmailActions) {}
  manifest(){return this.actions.manifest();}
  discoverScopes(){return this.actions.discoverScopes();}
  connect(input:{phase:'start';request:Parameters<GoogleOAuthClient['startAuthorization']>[0]}):ReturnType<GoogleOAuthClient['startAuthorization']>;
  connect(input:{phase:'finish';request:Parameters<GoogleOAuthClient['completeAuthorization']>[0]}):ReturnType<GoogleOAuthClient['completeAuthorization']>;
  connect(input:{phase:'start';request:Parameters<GoogleOAuthClient['startAuthorization']>[0]}|{phase:'finish';request:Parameters<GoogleOAuthClient['completeAuthorization']>[0]}) {return input.phase==='start'?this.oauth.startAuthorization(input.request):this.oauth.completeAuthorization(input.request);}
  test(id:string,principalId:string){return this.oauth.connection(id,principalId);}
  refresh(id:string,principalId:string){return this.oauth.refresh(id,principalId);}
  revoke(id:string,principalId:string){return this.oauth.revoke(id,principalId);}
  listActions(){return this.actions.listActions();}
  invoke(input:Parameters<GmailActions['propose']>[0]){return this.actions.propose(input);}
}

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
  return new GmailConnector(oauth,actions);
}
