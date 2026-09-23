<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import { currentView } from "../../stores/app.js";
  import { settingsCategory } from "../../stores/preferences.js";

  function openSettings(): void {
    settingsCategory.set("advanced");
    currentView.set("settings");
  }
</script>

<button
  type="button"
  class="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-accent underline-offset-2 hover:underline"
  data-mission-tracking-settings
  onclick={openSettings}
>
  {$tr("missions.openTrackingSettings")}
</button>
