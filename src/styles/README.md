# Where CSS goes

Use Tailwind utilities in Svelte markup for simple layout, spacing, typography, borders, and one-off boxes.

Put CSS in `src/styles/components.css` only when the whole app shares it: the app layout, shared filters and search, buttons, empty states, reusable cards, the modal and detail frame, and shared badges and icons.

Use a scoped `<style>` block in the component that owns the markup for:

- selectors that need `:global()` to reach inside child components
- `color-mix()`, gradients, `backdrop-filter`, keyframes, or vendor selectors
- parent-child selectors and responsive rules that refer to scoped classes
- visual variants with several states, where utilities would be harder to read

Keep feature-only selectors out of `components.css`. If a selector belongs to one view or component, write it as utilities or put it in that component's scoped style.
