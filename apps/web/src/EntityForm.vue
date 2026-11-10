<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { Field } from './forms';
const props = defineProps<{ fields: Field[]; initial?: Record<string,any>; busy?: boolean; submitLabel?: string }>();
const emit = defineEmits<{ submit: [value: Record<string,any>] }>();
const value = reactive<Record<string,any>>({});
watch(() => [props.fields,props.initial], () => {
  Object.keys(value).forEach(key => delete value[key]);
  for (const field of props.fields) value[field.key] = field.type === 'password' ? '' : (field.key==='expiresAt'&&props.initial?.expires_at ? new Date(props.initial.expires_at-new Date(props.initial.expires_at).getTimezoneOffset()*60000).toISOString().slice(0,16) : props.initial?.[field.key]) ?? (field.type === 'checkbox' ? false : '');
}, { immediate:true });
function submit() {
 const result: Record<string,any> = {};
 for (const f of props.fields) {
  const v=value[f.key];
  if (f.type === 'password' && !v) continue;
  if (v === '' && !f.required) continue;
  result[f.key]=f.type === 'number' ? Number(v) : v;
 }
 emit('submit',result);
}
</script>
<template><form @submit.prevent="submit" class="fields">
 <label v-for="field in fields" :key="field.key" :class="{check:field.type==='checkbox'}">
  <span>{{field.label}}<span v-if="field.required"> *</span></span>
  <select v-if="field.options" v-model="value[field.key]" :required="field.required"><option value="" disabled>请选择</option><option v-for="option in field.options" :key="option">{{option}}</option></select>
  <textarea v-else-if="field.type==='textarea'" v-model="value[field.key]" :required="field.required" rows="4" />
  <input v-else-if="field.type==='checkbox'" v-model="value[field.key]" type="checkbox">
  <input v-else v-model="value[field.key]" :type="field.type ?? 'text'" :required="field.required" :step="field.type==='number'?'any':undefined" :autocomplete="field.type==='password'?'new-password':undefined">
  <small v-if="field.help">{{field.help}}</small>
 </label><button type="submit" :disabled="busy">{{busy?'正在提交…':submitLabel ?? '保存'}}</button>
</form></template>
