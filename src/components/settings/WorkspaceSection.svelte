<script lang="ts">
  import { onMount } from "svelte";

  import SettingsSection from "./SettingsSection.svelte";
  import {
    popoutTargetKey,
    type PopoutTarget,
    type PopoutView,
  } from "../../../config/shared/popoutTypes.js";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { confirmWithDialog } from "../../lib/ipc.js";
  import { sectionById } from "../../lib/layout/registry.js";
  import { VIEW_LABEL_KEYS } from "../../lib/viewRegistry.js";
  import {
    applyWorkspace,
    closeAllPopouts,
    deleteWorkspace,
    openPopouts,
    renameWorkspace,
    saveWorkspace,
    setRestoreOnLaunch,
    subscribeOpenPopouts,
    workspaces,
  } from "../../stores/workspaces.js";

  // The arbitrations popout view is the "arbi" tab; the two id spaces differ.
  const POPOUT_VIEW_LABELS: Record<PopoutView, MessageKey> = {
    world: VIEW_LABEL_KEYS.world,
    arbitrations: VIEW_LABEL_KEYS.arbi,
  };

  let draftName = $state("");
  let renamingId: string | null = $state(null);
  let renameDraft = $state("");

  onMount(() => subscribeOpenPopouts());

  // A section label needs the owning view's module to have registered; in the
  // main window that is only true for views already visited, so the id is the
  // fallback rather than a guess.
  function targetLabelKey(target: PopoutTarget): MessageKey | null {
    if (target.kind === "view") return POPOUT_VIEW_LABELS[target.view];
    return sectionById(target.sectionId)?.labelKey ?? null;
  }

  function targetFallback(target: PopoutTarget): string {
    return target.kind === "view" ? target.view : target.sectionId;
  }

  async function save(): Promise<void> {
    const id = await saveWorkspace(draftName);
    if (id) draftName = "";
  }

  function startRename(id: string, name: string): void {
    renamingId = id;
    renameDraft = name;
  }

  function commitRename(): void {
    if (renamingId) renameWorkspace(renamingId, renameDraft);
    renamingId = null;
  }

  async function remove(id: string, name: string): Promise<void> {
    const confirmed = await confirmWithDialog($tr("workspaces.deleteConfirm", { name }), $tr);
    if (confirmed) deleteWorkspace(id);
  }
</script>

<SettingsSection title={$tr("workspaces.title")} description={$tr("workspaces.description")}>
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <input
      class="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-2 py-1 text-sm text-text-primary"
      type="text"
      maxlength="60"
      data-workspace-name
      placeholder={$tr("workspaces.namePlaceholder")}
      aria-label={$tr("workspaces.namePlaceholder")}
      bind:value={draftName}
    />
    <button
      class="btn-primary btn-sm"
      data-workspace-save
      disabled={!draftName.trim()}
      onclick={save}
    >
      {$tr("workspaces.saveCurrent")}
    </button>
  </div>

  {#if $workspaces.workspaces.length === 0}
    <p class="mt-3 text-xs text-text-muted" data-workspace-empty>{$tr("workspaces.empty")}</p>
  {:else}
    <ul class="mt-3 space-y-1.5">
      {#each $workspaces.workspaces as workspace (workspace.id)}
        <li
          class="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-border px-2 py-1.5"
          data-workspace-row={workspace.id}
        >
          {#if renamingId === workspace.id}
            <div class="flex items-center gap-2">
              <input
                class="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-2 py-0.5 text-sm text-text-primary"
                type="text"
                maxlength="60"
                data-workspace-rename-input={workspace.id}
                aria-label={$tr("workspaces.rename")}
                bind:value={renameDraft}
              />
              <button
                class="btn-secondary btn-sm"
                data-workspace-rename-save
                onclick={commitRename}
              >
                {$tr("common.save")}
              </button>
              <button
                class="btn-secondary btn-sm"
                data-workspace-rename-cancel
                onclick={() => (renamingId = null)}
              >
                {$tr("common.cancel")}
              </button>
            </div>
          {:else}
            <!-- Name and actions on separate lines: the settings card is too narrow
                 for a name, the launch radio and three buttons in one row. -->
            <div class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm text-text-primary" title={workspace.name}
                >{workspace.name}</span
              >
              <label class="flex items-center gap-1 text-xs text-text-secondary">
                <input
                  class="accent-accent"
                  type="radio"
                  name="workspace-restore"
                  data-workspace-restore={workspace.id}
                  checked={$workspaces.restoreOnLaunch === workspace.id}
                  onchange={() => setRestoreOnLaunch(workspace.id)}
                />
                {$tr("workspaces.restoreOnLaunch")}
              </label>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button
                class="btn-secondary btn-sm"
                data-workspace-apply={workspace.id}
                onclick={() => applyWorkspace(workspace.id)}
              >
                {$tr("workspaces.apply")}
              </button>
              <button
                class="btn-secondary btn-sm"
                data-workspace-rename={workspace.id}
                onclick={() => startRename(workspace.id, workspace.name)}
              >
                {$tr("workspaces.rename")}
              </button>
              <button
                class="btn-secondary btn-sm"
                data-workspace-delete={workspace.id}
                onclick={() => remove(workspace.id, workspace.name)}
              >
                {$tr("common.delete")}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <label class="mt-2 flex items-center gap-1 text-xs text-text-secondary">
      <input
        class="accent-accent"
        type="radio"
        name="workspace-restore"
        data-workspace-restore-none
        checked={$workspaces.restoreOnLaunch === null}
        onchange={() => setRestoreOnLaunch(null)}
      />
      {$tr("workspaces.restoreNone")}
    </label>
  {/if}

  <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
    <span class="text-xs text-text-secondary" data-workspace-open-windows>
      {$tr("workspaces.openWindows")}
      {#if $openPopouts.length === 0}
        {$tr("common.none")}
      {:else}
        {#each $openPopouts as info (popoutTargetKey(info.target))}
          {@const labelKey = targetLabelKey(info.target)}
          <span class="ml-1 rounded border border-border px-1 py-0.5 text-text-primary"
            >{labelKey ? $tr(labelKey) : targetFallback(info.target)}</span
          >
        {/each}
      {/if}
    </span>
    <button
      class="btn-secondary btn-sm ml-auto"
      data-workspace-close-all
      disabled={$openPopouts.length === 0}
      onclick={closeAllPopouts}
    >
      {$tr("workspaces.closeAll")}
    </button>
  </div>
</SettingsSection>
