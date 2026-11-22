<script lang="ts">
  import type { CustomProviderIconSelection } from '../custom-provider-icon';

  interface Props {
    frameShape?: 'circle' | 'rounded-square' | 'square';
    onchange?: (selection: CustomProviderIconSelection | null) => unknown;
  }
  let { frameShape, onchange }: Props = $props();
</script>

<div data-testid="stub-icon-editor" data-frame-shape={frameShape ?? ''}>
  <button
    type="button"
    data-testid="stub-crop-change"
    onclick={() =>
      onchange?.({
        blob: new Blob(['icon-bytes'], { type: 'image/png' }),
        shape: 'rounded-square',
      })}>Stage crop</button
  >
  <button type="button" data-testid="stub-crop-remove" onclick={() => onchange?.(null)}
    >Remove image</button
  >
</div>
