<script setup lang="ts">
import {ref,onMounted} from 'vue';
import {api,items} from './api';
import TechnicalDetails from './TechnicalDetails.vue';
import { errorText, statusText } from './present';
const blocked=ref(''),scope=ref('owner'),candidates=ref<any[]>([]),busy=ref(false),error=ref(''),notice=ref('');
async function run(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await fn();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
async function load(){const [policy,records]=await Promise.all([api('memory-policy'),api('memory-candidates?scope='+encodeURIComponent(scope.value))]);blocked.value=(policy.categories??[]).join(', ');candidates.value=items(records);}
async function save(){await run(async()=>{await api('memory-policy','PATCH',{categories:blocked.value.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)});notice.value='禁记策略已保存。';await load();});}
async function decide(c:any,decision:string){if(!confirm('确认对显示的确切内容执行审核？冲突内容须先修订或删除旧记忆。'))return;await run(async()=>{const result=await api('memory-candidates/'+encodeURIComponent(c.id)+'/decision','POST',{scope:c.scope,exactHash:c.exactHash,decision});notice.value='审核结果：'+result.state;await load();});}
onMounted(()=>run(load));
</script>
<template><section aria-label="记忆策略与候选"><h3>记忆策略与内容审核</h3><p>密码与密钥不进入长期记忆。健康、财务和身份信息须逐条审核。分类规则不能识别所有敏感语义，请核对正文。</p><p v-if="error" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p><label>禁止记住的类别（逗号分隔）<input :disabled="busy" v-model="blocked" placeholder="health, finance, identity"></label><button :disabled="busy" @click="save">保存禁记策略</button><label>候选记忆作用域<input :disabled="busy" v-model="scope"></label><button :disabled="busy" @click="run(load)">刷新待审候选</button><p v-if="!candidates.length">暂无待审候选。</p><article v-for="c in candidates" :key="c.id"><p>{{statusText(c.state)}} · 来源 {{c.source}} · 作用域 {{c.scope}}</p><pre>{{c.content}}</pre><p>类别：{{c.categories.join(', ')}}</p><TechnicalDetails :value="{exactHash:c.exactHash}" label="内容校验码" /><button :disabled="busy" @click="decide(c,'approve')">批准此记忆内容</button><button :disabled="busy" @click="decide(c,'reject')">拒绝此记忆内容</button></article></section></template>
