<script>
  import { statusText, debugMode } from '../stores/app.js';
</script>

<footer id="statusbar">
  <span id="status-text">{$statusText}</span>
  <button
    id="debug-toggle"
    class="debug-toggle"
    class:active={$debugMode}
    title="Toggle debug logging"
    on:click={() => debugMode.update(v => !v)}
  >
    Debug: {$debugMode ? 'ON' : 'OFF'}
  </button>
</footer>
