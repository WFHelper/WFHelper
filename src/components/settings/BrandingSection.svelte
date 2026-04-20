<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { LOGO_MAX_BYTES, APP_NAME_MAX_LENGTH } from "../../config/themeDefaults.js";

  $: branding = $themeSettings.branding;

  let logoError = "";
  let fileInput: HTMLInputElement;

  function onLogoSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    logoError = "";

    if (file.size > LOGO_MAX_BYTES) {
      logoError = $tr("appearance.logoTooLarge");
      input.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl.startsWith("data:image/")) {
        logoError = $tr("appearance.invalidLogoFormat");
        return;
      }
      themeSettings.setBranding({ logoDataUrl: dataUrl });
    };
    reader.readAsDataURL(file);
    input.value = "";
  }

  function removeLogo(): void {
    themeSettings.setBranding({ logoDataUrl: null });
    logoError = "";
  }

  function onNameChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.slice(0, APP_NAME_MAX_LENGTH).trim();
    themeSettings.setBranding({ appName: value || null });
  }
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.branding")}</h4>
    <button class="btn-secondary btn-sm" on:click={() => themeSettings.resetBranding()}>
      {$tr("appearance.resetBranding")}
    </button>
  </div>

  <div class="grid gap-[0.45rem]">
    <!-- Logo -->
    <div class="flex items-center justify-between gap-[0.6rem] flex-wrap border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.appLogo")}</span>
      <div class="flex items-center gap-[0.35rem]">
        {#if branding.logoDataUrl}
          <img class="w-6 h-6 object-contain rounded border border-border" src={branding.logoDataUrl} alt="Logo" />
          <button class="btn-secondary btn-sm" on:click={removeLogo}>
            {$tr("appearance.removeLogo")}
          </button>
        {/if}
        <button class="btn-secondary btn-sm" on:click={() => fileInput.click()}>
          {$tr("appearance.chooseLogo")}
        </button>
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          class="hidden"
          on:change={onLogoSelect}
        />
      </div>
      {#if logoError}
        <span class="text-[0.72rem] text-danger w-full">{logoError}</span>
      {/if}
    </div>

    <!-- App Name -->
    <div class="flex items-center justify-between gap-[0.6rem] flex-wrap border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.appName")}</span>
      <input
        type="text"
        class="w-56 border border-border rounded-[0.42rem] bg-bg-base text-text-primary text-[0.84rem] py-[0.3rem] px-2 outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        placeholder="WARFRAME COMPANION"
        maxlength={APP_NAME_MAX_LENGTH}
        value={branding.appName ?? ""}
        on:input={onNameChange}
      />
    </div>
  </div>
</div>

