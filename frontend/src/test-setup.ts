import '@testing-library/jest-dom/vitest';
import { Storage } from 'happy-dom';
import { vi } from 'vitest';

// Recent Node runtimes expose storage globals even without a backing file.
// Vitest's DOM environment can leave those host getters in place. Give every
// test file browser Storage instances, independent of the host's persistence.
vi.stubGlobal('localStorage', new Storage());
vi.stubGlobal('sessionStorage', new Storage());

// Svelte transitions drive the Web Animations API. happy-dom does not implement
// `Element.animate`, so any component rendered while one of its transitions is
// running throws `element.animate is not a function`. A stub that immediately
// completes keeps the transition's end state and lets intros/outros finish
// without moving anything.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    let onfinish: (() => void) | null = null;
    const animation = {
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
      get currentTime() {
        return 0;
      },
      get playState() {
        return 'finished' as const;
      },
      finished: Promise.resolve(),
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      persist: () => {},
      commitStyles: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      updatePlaybackRate: () => {},
    };
    let fired = false;
    Object.defineProperty(animation, 'onfinish', {
      get: () => onfinish,
      set: (handler: (() => void) | null) => {
        onfinish = handler;
        if (handler && !fired) {
          fired = true;
          queueMicrotask(() => handler());
        }
      },
    });
    return animation as unknown as Animation;
  } as Element['animate'];
}
