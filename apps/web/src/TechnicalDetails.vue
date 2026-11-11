<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ value: unknown; label?: string }>();
const text = computed(() => JSON.stringify(props.value, (key, value) => /^(apiKey|token|secret|password|authorization|cookie)$/i.test(key) ? '已隐藏' : value, 2) ?? '无');
</script>
<template><details class="technical"><summary>{{label ?? '技术详情'}}</summary><pre>{{text}}</pre></details></template>
