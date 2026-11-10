/** Keep viewport overlays outside scroll/paint containment and local stacking contexts. */
export function portalToBody(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
