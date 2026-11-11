const STATUS: Record<string,string> = {
  CREATED:'已创建',QUEUED:'排队中',RUNNING:'运行中',WAITING_APPROVAL:'等待审批',RETRY_WAIT:'等待重试',PAUSED:'已暂停',SUCCEEDED:'已完成',FAILED:'失败',CANCELLED:'已取消',CANCELED:'已取消',
  online:'连接正常',connected:'已连接',CONNECTED:'已连接',DISCONNECTED:'未连接',REVOKED:'已撤销',invalid_credentials:'凭据无效',unavailable:'服务不可用',unverified:'尚未验证',disabled:'已停用',enabled:'已启用',
  CONFIRMED:'已确认',CANCELLED_BY_OWNER:'已取消',SEND_UNCERTAIN:'发送结果待核对',SENT:'已发送',SENDING:'发送中',DRAFT:'草稿',WAITING:'等待中',INTENT_CANCELLED:'意图已取消',RULE_ACTIVE:'规则已启用',RULE_DISABLED:'规则已停用',
  PENDING:'待决定',APPROVED:'已批准',REJECTED:'已拒绝',EXPIRED:'已过期',
  NOT_REQUIRED:'无需投递',DELIVERY_PENDING:'待投递',DELIVERY_SENDING:'发送中',DELIVERY_SENT:'已发送',DELIVERY_UNCERTAIN:'待人工核对',
  active:'有效',blocked:'已阻止',expired:'已过期',deleted:'已删除',conflict:'存在冲突',created:'已创建',COMPLETED:'已完成',RECEIVED:'已接收',APPLIED:'已处理',
  settle:''
};
const ERRORS: Record<string,string> = {
  INVALID_CREDENTIALS:'管理员用户名或密码不正确。',
  WEAK_PASSWORD:'管理员密码至少需要 12 个字符。',
  AUTH_REQUIRED:'登录已过期，请重新登录。',
  MAINTENANCE:'服务正在维护，暂时只读。',
  PROVIDER_CHANGE_REQUIRES_IDLE:'有任务正在运行，请等待结束或暂停后再修改模型。',
  UNSUPPORTED_PROVIDER:'提供商类型请选择 openai；API 地址填写在单独的地址栏。',
  INVALID_PROVIDER_URL:'API 地址无效：须为 HTTPS，且不能含账号、密码、查询参数或片段。',
  UNSUPPORTED_MODEL:'未填写 API 地址时只能使用官方模型 ID。',
  INVALID_MODEL_CONFIG:'模型上限或单价无效：上限须为正整数，输出不能超过上下文，单价须同时填写或同时留空。',
  BUDGET_PRICE_UNKNOWN:'该模型未填写单价，但已设置金额预算。请填写输入和输出单价，或改用 Token 上限。',
  BUDGET_EXHAUSTED:'已达到预算或 Token 上限，任务未执行。',
  BUDGET_SOFT_LIMIT:'已达到费用软上限，任务已暂停。',
  MODEL_OR_BUDGET_FAILURE:'模型调用未完成。请检查模型配置、网络与预算后重试。',
  TRANSIENT_MODEL_ERROR:'模型服务暂时不可用，稍后重试。',
  QUEUE_FULL:'排队任务过多，请稍后再试。',
  CONVERSATION_ARCHIVED:'会话已归档，不能继续发送消息。',
  READ_ONLY_PROTECTION:'服务当前为只读保护状态，未写入任何更改。',
  IDEMPOTENCY_UNCERTAIN:'上一次相同请求结果不确定，请先核对再重试。',
  APPROVAL_INVALID:'审批已失效或操作内容已变化，请重新发起。',
  RATE_LIMITED:'操作过于频繁，请稍后再试。',
  NOT_FOUND:'找不到这条记录，它可能已被删除。',
  OWNER_NOT_FOUND:'未找到唯一的管理员账户。',
  MASTER_KEY_INVALID:'主密钥无效，无法读取加密凭据。',
  INVALID_INPUT:'填写内容不符合要求，请检查必填项和格式。',
  INVALID_FIELDS:'提交内容包含不支持的字段。',
  INVALID_NUMBER:'数值超出允许范围。',
  REQUEST_FAILED:'操作未完成，请查看技术详情或系统日志。',
  DELIVERY_UNCERTAIN:'消息是否送达尚不确定，请先到平台核对。'
};
const LABELS: Record<string,string> = {
  id:'记录编号',name:'名称',goal:'任务指令',status:'状态',error:'错误',source:'来源',ownerId:'所有者',conversationId:'所属会话',channelId:'消息通道',
  budget:'预算',usage:'用量',model:'模型',modelId:'模型',vendor:'提供商',baseUrl:'API 地址',pricingKnown:'价格是否已知',
  createdAt:'创建时间',updatedAt:'更新时间',startedAt:'开始时间',finishedAt:'结束时间',occurredAt:'发生时间',expiresAt:'截止时间',testedAt:'测试时间',nextFireAt:'下次运行',lastFireAt:'上次运行',
  expression:'运行规则',timezone:'时区',prompt:'任务指令',enabled:'是否启用',intervalSeconds:'检查间隔（秒）',
  kind:'类型',scope:'作用域',content:'记忆正文',category:'类别',sensitive:'含敏感内容',confirmSensitive:'已确认敏感内容',confidence:'置信度',
  risk:'风险',summary:'摘要',argsSummary:'参数摘要',operationHash:'操作校验码',taskId:'关联任务',
  reason:'原因',detail:'详情',retryable:'可重试',attempt:'尝试次数',result:'结果',
  version:'版本',content_hash:'内容校验码',contentHash:'内容校验码',provider:'提供商',priority:'优先级',dailyBudget:'每日预算',taskBudget:'每任务预算',
  maxTokens:'上下文 Token 上限',maxCost:'单任务金额上限',modelCalls:'模型调用次数',toolCalls:'工具调用次数',reservedTokens:'预留 Token',reservedCost:'预留费用',costUnknown:'费用未知',
  state:'状态',execution:'执行方式',target:'对象',impact:'影响',parameters:'参数',
  role:'角色',text:'文本',type:'类型',at:'时间',message:'消息',action:'操作',actor:'操作者'
};
export function statusText(value:unknown):string {
  if(value===undefined||value===null||value==='')return '';
  const key=String(value);
  return STATUS[key]??statusTextFromCode(key);
}
function statusTextFromCode(key:string):string {
  if(/^[A-Z][A-Z0-9_]{2,}$/.test(key))return '处理中';
  return String(key);
}
export function errorText(code:unknown):string {
  if(!code)return '';
  const value=typeof code==='string'?code:String((code as any)?.code??code);
  return ERRORS[value]??'操作未完成，请查看技术详情或系统日志。';
}
export function riskText(value:unknown):string { const map:Record<string,string>={read:'只读',low:'低风险',medium:'中风险',high:'高风险',critical:'严重风险',non_idempotent_write:'不可重复的外部操作',idempotent_write:'可重复写入',external_send:'对外发送'};return map[String(value)]??''; }
export function roleText(value:unknown):string { const map:Record<string,string>={user:'你',assistant:'助手',system:'系统',tool:'工具',owner:'所有者',cron:'定时任务',heartbeat:'例行检查',telegram:'Telegram'};return map[String(value)]??String(value??''); }
export function label(key:string):string { return LABELS[key]??key; }
export function scalar(value:unknown,key=''):string {
  if(value===null||value===undefined)return '未提供';
  if(typeof value==='boolean')return value?'是':'否';
  if(typeof value==='number'){
    if(/At$|time$/i.test(key)&&value>1e12)return new Date(value).toLocaleString();
    return value.toLocaleString();
  }
  if(typeof value==='string'){
    if(/At$|time$/i.test(key)&&/^\d{10,}$/.test(value))return new Date(Number(value)).toLocaleString();
    if(STATUS[value])return STATUS[value]!;
    if(ERRORS[value])return ERRORS[value]!;
    return value;
  }
  if(Array.isArray(value))return value.length?`${value.length} 项`:'无';
  return '';
}
export function isDetail(value:unknown):boolean { return typeof value==='object'&&value!==null; }
export function testOutcome(kind:'provider'|'channel',result:any):{title:string;detail:string;ok:boolean} {
  const status=String(result?.status??'');
  const target=kind==='provider'?'模型服务':'消息通道';
  if(status==='online'||status==='connected')return {ok:true,title:`${target}连接正常`,detail:kind==='provider'?'已能访问该地址，实际回复质量由对话内容决定。':'已能访问该通道，实际收发仍受平台限制。'};
  if(status==='invalid_credentials')return {ok:false,title:`${target}拒绝了密钥`,detail:kind==='provider'?'请确认密钥正确、未过期，且属于该 API 地址对应的账号。':'请确认 Bot Token 正确、未撤销，并属于预期机器人。'};
  if(status==='model_not_listed')return {ok:false,title:'该地址没有提供这个模型',detail:'密钥有效，但模型 ID 不在服务的模型列表中。请核对模型名（区分点号与连字符）后重试。'};
  if(status==='unverified')return {ok:true,title:`${target}地址可达`,detail:'该服务没有提供模型列表接口，因此只确认了地址连通；密钥是否正确需通过实际对话确认。'};
  if(status==='unavailable')return {ok:false,title:`无法连接${target}`,detail:'请确认地址可访问、网络通畅，且服务未处于限制状态。'};
  return {ok:false,title:`${target}测试未完成`,detail:'请稍后重试；若持续失败，请查看技术详情。'};
}
