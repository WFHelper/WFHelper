# CSS Boundary

Use Tailwind utilities in Svelte markup for simple layout, spacing, typography, borders, and one-off boxes.

Keep CSS in `src/styles/components.css` only for shared infrastructure: app layout, shared filters/search, buttons, empty states, reusable card surfaces, modal/detail shell, and shared badges/icons.

Use scoped `<style>` in the owning component for:

- selectors that need `:global()` to target child component internals
- `color-mix()`, gradients, `backdrop-filter`, keyframes, or vendor selectors
- parent-child selectors and responsive rules that reference scoped classes
- multi-state visual variants where utilities would become harder to scan

Do not add feature-only selectors to `components.css`. If a selector only belongs to one view or component, keep it inline as utilities or in that component's scoped style.
