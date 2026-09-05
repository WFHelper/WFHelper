<script lang="ts">
  import ItemDetailModal from "../modals/ItemDetailModal.svelte";
  import ComponentDetailModal from "../modals/ComponentDetailModal.svelte";
  import RelicDetailModal from "../modals/RelicDetailModal.svelte";
  import EnemyDetailModal from "../modals/EnemyDetailModal.svelte";
  import OrderModal from "../modals/OrderModal.svelte";
</script>

<!-- The modal stores are per-window, so every window whose views can set one
     hosts them. BulkSellModal is deliberately absent: it reads the inventory
     selection and workbench state that only the main window builds. -->
<ItemDetailModal />
<ComponentDetailModal />
<RelicDetailModal />
<EnemyDetailModal />
<OrderModal />
