<script setup lang="ts">
import MigrationCenter from './v11/MigrationCenter.vue';
import AppsCenter from './v11/AppsCenter.vue';
defineProps<{ kind: 'migrations' | 'apps' }>();
</script>
<template><div class="v11-center"><MigrationCenter v-if="kind === 'migrations'"/><AppsCenter v-else/></div></template>
<style>
.v11-center { min-width: 0; overflow-wrap: anywhere; }
.v11-center section, .v11-center article { min-width: 0; margin: 1rem 0; }
.v11-center label { display: block; margin: .6rem 0; }
.v11-center input, .v11-center select, .v11-center textarea { display: block; max-width: 100%; box-sizing: border-box; }
.v11-center input[type=checkbox] { display: inline-block; }
.v11-center button { margin: .25rem; }
.v11-center pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.v11-center [role=alert] { color: #a22; }
</style>
