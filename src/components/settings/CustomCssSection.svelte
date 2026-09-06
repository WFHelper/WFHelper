<script lang="ts">
  import { tick } from "svelte";

  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { tr } from "../../lib/i18n.js";
  import { customCss, safeMode } from "../../stores/customCss.js";
  import {
    CUSTOM_CSS_MAX_BYTES,
    sanitizeCustomCss,
    verifyCustomCss,
    type CustomCssWarning,
    type CustomCssWarningReason,
  } from "../../lib/customCss/sanitize.js";
  import { exportCustomCss, importCustomCss } from "../../lib/customCss/portable.js";

  const TAB_SPACES = "  ";

  let draft = $state($customCss.css);
  let importError: CustomCssWarningReason | null = $state(null);
  let fileInput: HTMLInputElement | null = $state(null);

  const dirty = $derived(draft !== $customCss.css);
  const sanitized = $derived(sanitizeCustomCss(draft));
  const warnings: CustomCssWarning[] = $derived([
    ...sanitized.warnings,
    ...verifyCustomCss(sanitized.css),
  ]);

  function handleTab(event: KeyboardEvent): void {
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const field = event.currentTarget as HTMLTextAreaElement;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    draft = draft.slice(0, start) + TAB_SPACES + draft.slice(end);
    // The caret survives only after Svelte has written the new value back.
    void tick().then(() => {
      field.selectionStart = start + TAB_SPACES.length;
      field.selectionEnd = start + TAB_SPACES.length;
    });
  }

  function handleApply(): void {
    customCss.save(draft);
  }

  function handleRevert(): void {
    draft = $customCss.css;
    importError = null;
  }

  async function handleFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > CUSTOM_CSS_MAX_BYTES) {
      importError = "tooLarge";
      return;
    }
    const result = importCustomCss(await file.text());
    if (!result.ok) {
      importError = result.reason;
      return;
    }
    // An imported file never flips the opt-in toggle; enabling stays a user action.
    importError = null;
    draft = result.css;
  }

  function handleExport(): void {
    const payload = exportCustomCss({
      css: draft,
      enabled: $customCss.enabled,
      updatedAt: $customCss.updatedAt,
    });
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wfhelper-custom-css-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
</script>

<SettingsSection title={$tr("customCss.title")} description={$tr("customCss.description")}>
  {#if $safeMode}
    <p
      class="mb-3 rounded-[var(--radius-md)] border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-primary"
      data-custom-css-safe-mode
    >
      {$tr("customCss.safeModeBanner")}
    </p>
  {/if}

  <SettingsRow
    label={$tr("customCss.enable")}
    hint={$tr("customCss.enableWarning")}
    dataSetting="custom-css-enabled"
  >
    <input
      type="checkbox"
      checked={$customCss.enabled}
      onchange={(event) => customCss.setEnabled(event.currentTarget.checked)}
    />
  </SettingsRow>

  <textarea
    class="mt-2 h-56 w-full resize-y rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] p-2 font-mono text-xs leading-relaxed text-text-primary"
    spellcheck="false"
    data-custom-css-editor
    aria-label={$tr("customCss.editorLabel")}
    placeholder={$tr("customCss.placeholder")}
    bind:value={draft}
    onkeydown={handleTab}></textarea>

  <div class="mt-2 flex flex-wrap gap-2">
    <button class="btn-primary btn-sm" disabled={!dirty} onclick={handleApply}>
      {$tr("customCss.apply")}
    </button>
    <button class="btn-secondary btn-sm" disabled={!dirty} onclick={handleRevert}>
      {$tr("customCss.revert")}
    </button>
    <button class="btn-secondary btn-sm" onclick={() => fileInput?.click()}>
      {$tr("customCss.import")}
    </button>
    <button class="btn-secondary btn-sm" onclick={handleExport}>
      {$tr("customCss.export")}
    </button>
    <input
      class="hidden"
      type="file"
      accept=".css,text/css,application/json"
      bind:this={fileInput}
      onchange={handleFile}
    />
  </div>

  {#if importError}
    <p class="mt-2 text-xs text-danger" data-custom-css-import-error>
      {$tr(`customCss.reason.${importError}`)}
    </p>
  {/if}

  {#if warnings.length > 0}
    <div class="mt-3" data-custom-css-warnings>
      <p class="text-xs font-semibold text-text-secondary">{$tr("customCss.warningsTitle")}</p>
      <ul class="mt-1 space-y-0.5">
        {#each warnings as warning, index (`${warning.line}-${warning.reason}-${index}`)}
          <li class="text-xs text-text-muted">
            {$tr("customCss.warningLine", { line: warning.line })}
            {$tr(`customCss.reason.${warning.reason}`)}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</SettingsSection>
