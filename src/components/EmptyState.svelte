<script lang="ts">
  interface Props {
    message: string;
  }

  let { message }: Props = $props();
</script>

<div class="empty-state flex flex-col items-center justify-center min-h-[40vh] text-text-muted text-[0.9rem]">
  <p>{message}</p>
</div>
