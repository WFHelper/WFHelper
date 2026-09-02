<script lang="ts">
  import { onMount } from "svelte";

  import { restartInSafeMode } from "../lib/customCss/safeMode.js";
  import { activeCustomCss, safeMode } from "../stores/customCss.js";

  let sheet: CSSStyleSheet | null = $state(null);

  onMount(() => {
    if ($safeMode) return;
    // A constructed sheet sits outside the CSP style-src rule that blocks an
    // inline <style> element, and it still cascades after the token layer.
    const created = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, created];
    sheet = created;
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== created);
      sheet = null;
    };
  });

  $effect(() => {
    const css = $activeCustomCss;
    if (!sheet) return;
    try {
      sheet.replaceSync(css);
    } catch {
      sheet.replaceSync("");
    }
  });

  // A sheet that hides the UI never throws, so the crash panel cannot offer
  // recovery; this chord is the always-available way back.
  function onKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      restartInSafeMode();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />
