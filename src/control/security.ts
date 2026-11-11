import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { ControlStore } from './store.js';
interface User {id:string;username:string;passwordHash:string;role:'Owner'}
interface Session {userId:string;csrf:string;expiresAt:number}
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const scryptOptions={N:32768,r:8,p:3,maxmem:64*1024*1024};
const hashPrefix='scrypt$v1$N=32768,r=8,p=3';
function passwordHash(password:string):string {const salt=randomBytes(16).toString('hex');return `${hashPrefix}$${salt}$${scryptSync(password,salt,64,scryptOptions).toString('hex')}`;}
const dummyHash=passwordHash(randomBytes(32).toString('hex'));
function verify(password:string,encoded:string):boolean {
  // Legacy salt:hash records used these exact parameters; retain login compatibility.
  const legacy=/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(encoded);
  const parts=encoded.split('$');
  const valid=legacy||(parts.length===5&&parts.slice(0,3).join('$')===hashPrefix&&/^[0-9a-f]{32}$/.test(parts[3]!)&&/^[0-9a-f]{128}$/.test(parts[4]!));
  const safe=valid?encoded:dummyHash;
  const [salt,expected]=legacy?safe.split(':'):safe.split('$').slice(3);
  const actual=scryptSync(password,salt!,64,scryptOptions);
  return timingSafeEqual(Buffer.from(expected!,'hex'),actual)&&valid;
}
export class AuthService {
  constructor(private store:ControlStore) {}
  // Maintenance permits existing authenticated reads only. Login creates a session and is refused.
  private available():void {if(this.store.maintenance)throw new Error('MAINTENANCE');}
  setup(input:{username:string;password:string;timezone:string}):void {
    if(!input.username.trim())throw new Error('INVALID_CREDENTIALS');
    if(input.password.length<12)throw new Error('WEAK_PASSWORD');
    new Intl.DateTimeFormat('en',{timeZone:input.timezone});
    this.store.transaction(()=>{
      if(this.store.list('users').length)throw new Error('ALREADY_INITIALIZED');
      const id=randomUUID();this.store.put('users',id,{id,username:input.username,passwordHash:passwordHash(input.password),role:'Owner'});
      this.store.setSetting('timezone',input.timezone);
      this.store.setSetting('initialized',true);
    });
  }
  verifyPassword(userId:string,password:string):boolean {const u=this.store.get<User>('users',userId);return !!u&&verify(password,u.passwordHash);}
  login(username:string,password:string):{token:string;csrf:string;expiresAt:number} {
    this.available();
    const user=this.store.list<User>('users').find(u=>u.username===username);
    const valid=verify(password,user?.passwordHash??dummyHash);
    if(!user||!valid)throw new Error('INVALID_CREDENTIALS');
    const token=randomBytes(32).toString('hex');const session={userId:user.id,csrf:randomBytes(32).toString('hex'),expiresAt:Date.now()+24*3600_000};
    this.store.put('sessions',digest(token),session);
    return {token,csrf:session.csrf,expiresAt:session.expiresAt};
  }
  authenticate(token:string):Session|undefined {const session=this.store.get<Session>('sessions',digest(token));return session&&session.expiresAt>Date.now()?session:undefined;}
  logout(token:string):void {this.store.remove('sessions',digest(token));}
  /** Trusted offline recovery only. Caller must hold application ownership with the service stopped. */
  recoverPassword(username:string,next:string):void {
    if(!username.trim()||next.length<12||next.length>1024)throw new Error('INVALID_CREDENTIALS');
    this.store.transaction(()=>{
      const users=this.store.list<User>('users'),user=users.find(u=>u.username===username&&u.role==='Owner');
      if(!user||users.filter(u=>u.role==='Owner').length!==1)throw new Error('OWNER_NOT_FOUND');
      this.store.put('users',user.id,{...user,passwordHash:passwordHash(next)},'offline-owner');
      for(const row of this.store.db.prepare("SELECT id FROM entities WHERE kind='sessions'").all())this.store.remove('sessions',String(row.id),'offline-owner');
      this.store.audit('offline-owner','auth.recover',user.id,'sessions.revoked');
    });
  }
  changePassword(userId:string,current:string,next:string):void {
    if(next.length<12)throw new Error('WEAK_PASSWORD');
    this.store.transaction(()=>{
      const user=this.store.get<User>('users',userId);if(!user||!verify(current,user.passwordHash))throw new Error('INVALID_CREDENTIALS');
      this.store.put('users',userId,{...user,passwordHash:passwordHash(next)},userId);
      for(const r of this.store.db.prepare('SELECT id,value FROM entities WHERE kind=?').all('sessions'))if((JSON.parse(String(r.value)) as Session).userId===userId)this.store.remove('sessions',String(r.id));
    });
  }
}
