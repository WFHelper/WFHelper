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

  <div class="branding-controls">
    <!-- Logo -->
    <div class="branding-row">
      <span class="branding-label">{$tr("appearance.appLogo")}</span>
      <div class="branding-logo-controls">
        {#if branding.logoDataUrl}
          <img class="branding-logo-preview" src={branding.logoDataUrl} alt="Logo" />
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
          class="hidden-file-input"
          on:change={onLogoSelect}
        />
      </div>
      {#if logoError}
        <span class="branding-error">{logoError}</span>
      {/if}
    </div>

    <!-- App Name -->
    <div class="branding-row">
      <span class="branding-label">{$tr("appearance.appName")}</span>
      <input
        type="text"
        class="branding-name-input"
        placeholder="WARFRAME COMPANION"
        maxlength={APP_NAME_MAX_LENGTH}
        value={branding.appName ?? ""}
        on:input={onNameChange}
      />
    </div>
  </div>
</div>

<style>
  .branding-controls {
    display: grid;
    gap: 0.45rem;
  }
  .branding-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-raised);
    padding: 0.45rem 0.55rem;
  }
  .branding-label {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 500;
  }
  .branding-logo-controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .branding-logo-preview {
    width: 1.5rem;
    height: 1.5rem;
    object-fit: contain;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
  }
  .hidden-file-input {
    display: none;
  }
  .branding-error {
    font-size: 0.72rem;
    color: var(--danger);
    width: 100%;
  }
  .branding-name-input {
    width: 14rem;
    border: 1px solid var(--border);
    border-radius: 0.42rem;
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 0.84rem;
    padding: 0.3rem 0.5rem;
    outline: none;
  }
  .branding-name-input:focus {
    border-color: var(--accent-dim);
    box-shadow: 0 0 0 2px rgba(212, 168, 67, 0.12);
  }
</style>
