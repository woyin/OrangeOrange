export type FeedOptions = { cursor:()=>string; state:(value:string)=>void; refresh:()=>void; event:(id:string,type:string,data:string)=>void; reset:()=>void; unauthorized:()=>void };
export function parseEvent(block:string):{id:string;type:string;data:string}|undefined {
 let id='',type='message';const data:string[]=[];
 for(const line of block.split('\n')) { if(line.startsWith(':'))continue;const colon=line.indexOf(':');const key=colon<0?line:line.slice(0,colon);const value=colon<0?'':line.slice(colon+1).replace(/^ /,'');if(key==='id')id=value;if(key==='event')type=value;if(key==='data')data.push(value); }
 return data.length||id ? {id,type,data:data.join('\n')} : undefined;
}
export class EventFeed {
 private stopped=false;private controller?:AbortController;private timer?:ReturnType<typeof setTimeout>;
 private options:FeedOptions;
 constructor(options:FeedOptions){this.options=options;}
 start(){void this.open();}
 close(){this.stopped=true;this.controller?.abort();if(this.timer)clearTimeout(this.timer);}
 private async open(){if(this.stopped)return;this.controller=new AbortController();this.options.state('连接中');try{
 const response=await fetch('/api/v1/events/stream?cursor='+encodeURIComponent(this.options.cursor()),{credentials:'same-origin',headers:{Accept:'text/event-stream'},signal:this.controller.signal});
 if(response.status===401||response.status===403){this.options.unauthorized();this.close();return;}
 if(response.status===409||response.status===410){this.options.reset();this.options.refresh();throw new Error('游标过期');}
 if(!response.ok||!response.body)throw new Error('事件流不可用');this.options.state('已连接');this.options.refresh();
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 while(!this.stopped){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true}).replace(/\r\n/g,'\n');let end:number;while((end=buffer.indexOf('\n\n'))>=0){const event=parseEvent(buffer.slice(0,end));buffer=buffer.slice(end+2);if(!event)continue;if(['reset','cursor.expired','resync'].includes(event.type)){this.options.reset();this.options.refresh();await reader.cancel();throw new Error('游标已重置');}if(event.id&&/^\d+$/.test(event.id)){if(BigInt(event.id)<=BigInt(this.options.cursor()))continue;this.options.event(event.id,event.type,event.data);}this.options.refresh();}if(buffer.length>1024*1024)throw new Error('事件超过大小限制');}
 }catch(error){if(this.stopped)return;}if(this.stopped)return;this.options.state('已断开，正在重连并补拉');this.options.refresh();this.timer=setTimeout(()=>void this.open(),3000);}
}
