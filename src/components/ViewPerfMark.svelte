<script lang="ts">
  /**
   * Drop-in helper: `<ViewPerfMark name="inventory" />` at the top of a view
   * records the mount → first-paint duration through `measureViewMount`.
   * Tree-shakes to nothing in production via `import.meta.env.DEV`.
   */
  import { onMount } from "svelte";
  import { measureViewMount } from "../lib/perf.js";

  export let name: string;

  onMount(() => {
    const done = measureViewMount(name);
    // Wait two rAF frames to approximate "first paint".
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(done);
    });
    return () => cancelAnimationFrame(raf1);
  });
</script>
