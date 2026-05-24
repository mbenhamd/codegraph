<script setup lang="ts">
const users = ['alice', 'bob'];
</script>

<template>
  <ul>
    <li v-for="u in users" :key="u">{{ u }}</li>
  </ul>
</template>
