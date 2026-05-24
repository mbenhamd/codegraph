<script lang="ts">
  export let data: { posts: string[] };
</script>

<h1>Blog</h1>
<ul>
  {#each data.posts as post}
    <li>{post}</li>
  {/each}
</ul>
