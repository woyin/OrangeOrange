/** 源码核对与测试夹具不是实际来源备份验收。 */
export interface CompatibilityEntry {
  system:'openclaw'|'hermes';
  sourceVersion:string;
  sourceCommit:string;
  schema:{component:string; version:number};
  fixture:{kind:'synthetic'; path:string; scope:string[]};
  status:'unverified';
  unverified:string[];
}
export const compatibilityMatrix:readonly CompatibilityEntry[] = [
  {system:'openclaw',sourceVersion:'2026.11.2（主干未发布 schema）',sourceCommit:'d290127ec6750ac3b3504d44ab50b7cee5f92ec7',schema:{component:'agent',version:41},fixture:{kind:'synthetic',path:'tests/fixtures/migrations/openclaw/agent-schema41.sql',scope:['schema 部分字段','会话和文本轨迹','受控示例文件']},status:'unverified',unverified:['真实版本生成的数据库与备份','完整 schema 与全部字段','真实备份 fixture','端到端来源验收']},
  {system:'openclaw',sourceVersion:'v2026.11.3',sourceCommit:'847611dcaa3bf0e2783335f961dd1fd0580e4d9f',schema:{component:'agent',version:27},fixture:{kind:'synthetic',path:'tests/fixtures/migrations/openclaw/agent-schema27.sql',scope:['schema 部分字段','会话和文本轨迹']},status:'unverified',unverified:['真实版本生成的数据库与备份','完整 schema 与全部字段','端到端来源验收']},
  {system:'hermes',sourceVersion:'v0.23.0',sourceCommit:'2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19',schema:{component:'state.db',version:32},fixture:{kind:'synthetic',path:'tests/fixtures/migrations/hermes/state-schema32.sql',scope:['schema 部分字段','会话和文本轨迹']},status:'unverified',unverified:['真实版本生成的数据库与备份','完整 schema 与全部字段','端到端来源验收']},
  {system:'hermes',sourceVersion:'未验证',sourceCommit:'47edbcd170be6a2edf876eaa5c4b9a8595bc4cf0',schema:{component:'state.db',version:33},fixture:{kind:'synthetic',path:'tests/fixtures/migrations/hermes/state-schema33.sql',scope:['schema 部分字段','会话和文本轨迹','受控示例文件']},status:'unverified',unverified:['真实版本生成的数据库与备份','完整 schema 与全部字段','真实备份 fixture','端到端来源验收']},
];
