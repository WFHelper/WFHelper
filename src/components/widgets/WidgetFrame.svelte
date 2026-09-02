<script lang="ts">
  import type { Snippet } from "svelte";

  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { VIEW_LABEL_KEYS } from "../../lib/viewRegistry.js";
  import {
    WIDGET_HOME_VIEWS,
    WIDGET_SETTING_LABEL_KEYS,
    WIDGET_SETTING_RANGES,
    widgetById,
  } from "../../lib/widgets/registry.js";
  import { currentView } from "../../stores/app.js";
  import { dashboardLayout, setWidgetSetting, widgetSettings } from "../../stores/dashboard.js";
  import { editMode } from "../../stores/layout.js";

  interface Props {
    widgetId: string;
    /** True when the widget has nothing to show; the body is replaced by emptyKey. */
    empty?: boolean;
    emptyKey?: MessageKey;
    /** Set when the widget's own data source failed; wins over the empty state. */
    errorKey?: MessageKey | null;
    /** Rendered under the header even while empty, for state the body would hide. */
    subtitle?: Snippet;
    children: Snippet;
  }

  const {
    widgetId,
    empty = false,
    emptyKey,
    errorKey = null,
    subtitle,
    children,
  }: Props = $props();

  // The dashboard.* keys land in en.json with this change; the cast keeps the
  // component compiling while the dictionary catches up.
  const k = (key: string): MessageKey => key as MessageKey;

  const descriptor = $derived(widgetById(widgetId));
  const labelKey = $derived(descriptor?.labelKey ?? k("common.unknown"));
  const homeView = $derived(WIDGET_HOME_VIEWS[widgetId] ?? "inventory");
  const settingNames = $derived(Object.keys(descriptor?.settings ?? {}));
  const settings = $derived(widgetSettings($dashboardLayout, widgetId));
  const editing = $derived($editMode === "dashboard");

  let showSettings = $state(false);

  function onNumberInput(name: string, event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value)) setWidgetSetting(widgetId, name, value);
  }
</script>

<section
  class="flex min-w-0 flex-col gap-2 rounded-[var(--radius-lg)] border border-[color:var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-3"
  data-widget={widgetId}
>
  <header class="flex items-center gap-2">
    <h3 class="m-0 truncate text-sm font-semibold text-text-primary">{$tr(labelKey)}</h3>
    <div class="ml-auto flex items-center gap-1">
      {#if editing && settingNames.length > 0}
        <button
          type="button"
          class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors hover:border-accent hover:text-accent"
          data-widget-gear={widgetId}
          aria-expanded={showSettings}
          title={$tr(k("dashboard.widgetSettings"), { label: $tr(labelKey) })}
          aria-label={$tr(k("dashboard.widgetSettings"), { label: $tr(labelKey) })}
          onclick={() => (showSettings = !showSettings)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path
              d="M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zm0 4.3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"
            />
            <path
              d="M14 8c0-.4 0-.7-.1-1l1.2-.9-1.4-2.4-1.4.5a5 5 0 0 0-1.7-1L10.4 1.6H7.6L7.4 3.2a5 5 0 0 0-1.7 1l-1.4-.5-1.4 2.4 1.2.9a5.6 5.6 0 0 0 0 2l-1.2.9 1.4 2.4 1.4-.5c.5.4 1 .8 1.7 1l.2 1.6h2.8l.2-1.6c.6-.2 1.2-.6 1.7-1l1.4.5 1.4-2.4-1.2-.9c.1-.3.1-.6.1-1z"
              opacity="0.55"
            />
          </svg>
        </button>
      {/if}
      <button
        type="button"
        class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors hover:border-accent hover:text-accent"
        data-widget-open={widgetId}
        title={$tr(k("dashboard.openTab"), { label: $tr(VIEW_LABEL_KEYS[homeView]) })}
        aria-label={$tr(k("dashboard.openTab"), { label: $tr(VIEW_LABEL_KEYS[homeView]) })}
        onclick={() => currentView.set(homeView)}
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M9.5 2.5h4v4" />
          <path d="M13.5 2.5 8 8" />
          <path d="M12.5 9.5V13H3V3.5h3.5" />
        </svg>
      </button>
    </div>
  </header>

  {#if subtitle}
    {@render subtitle()}
  {/if}

  {#if editing && showSettings && settingNames.length > 0}
    <div
      class="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-accent/40 bg-accent/5 px-2 py-1.5 text-xs"
      data-widget-settings={widgetId}
    >
      {#each settingNames as name (name)}
        {@const kind = descriptor?.settings?.[name]}
        {@const range = WIDGET_SETTING_RANGES[name]}
        {@const settingLabel = WIDGET_SETTING_LABEL_KEYS[name] ?? k("common.unknown")}
        <label class="flex items-center justify-between gap-2">
          <span class="text-text-secondary">{$tr(settingLabel)}</span>
          {#if kind === "boolean"}
            <input
              type="checkbox"
              data-widget-setting={name}
              checked={settings[name] === true}
              onchange={(event) => setWidgetSetting(widgetId, name, event.currentTarget.checked)}
            />
          {:else if kind === "number"}
            <input
              type="number"
              class="w-16 rounded border border-border bg-bg-raised px-1.5 py-0.5 text-text-primary outline-none focus:border-accent"
              data-widget-setting={name}
              min={range?.min}
              max={range?.max}
              value={String(settings[name] ?? "")}
              onchange={(event) => onNumberInput(name, event)}
            />
          {:else}
            <input
              type="text"
              class="w-32 rounded border border-border bg-bg-raised px-1.5 py-0.5 text-text-primary outline-none focus:border-accent"
              data-widget-setting={name}
              value={String(settings[name] ?? "")}
              onchange={(event) => setWidgetSetting(widgetId, name, event.currentTarget.value)}
            />
          {/if}
        </label>
      {/each}
    </div>
  {/if}

  {#if errorKey}
    <p class="m-0 py-3 text-center text-xs text-text-muted" data-widget-error={widgetId}>
      {$tr(errorKey)}
    </p>
  {:else if empty}
    <p class="m-0 py-3 text-center text-xs text-text-muted" data-widget-empty={widgetId}>
      {$tr(emptyKey ?? k("world.noData"))}
    </p>
  {:else}
    {@render children()}
  {/if}
</section>
