<script lang="ts">
  // The update ENTRY POINT now lives in the MenuBar (next to Git). This
  // component only mounts the dialog so it can open from anywhere via the
  // updater store's dialogOpen flag.
  import UpdateDialog from "./UpdateDialog.svelte";
</script>

<UpdateDialog />
