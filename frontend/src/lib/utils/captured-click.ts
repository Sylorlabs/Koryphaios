/** Bind the callback rendered on this element, rather than reading newer state at click time. */
export function capturedClick(node: HTMLButtonElement, callback: () => void) {
  let rendered = callback;
  const click = () => {
    if (!node.disabled) rendered();
  };
  node.addEventListener('click', click);
  return {
    update(callback: () => void) {
      rendered = callback;
    },
    destroy() {
      node.removeEventListener('click', click);
    },
  };
}

export function capturedSubmit(node: HTMLFormElement, callback: () => void) {
  let rendered = callback;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    rendered();
  };
  node.addEventListener('submit', submit);
  return {
    update(callback: () => void) {
      rendered = callback;
    },
    destroy() {
      node.removeEventListener('submit', submit);
    },
  };
}
