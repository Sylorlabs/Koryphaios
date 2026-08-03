let now = $state(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function start() {
  if (timer !== undefined) return;
  timer = setInterval(() => (now = Date.now()), 250);
}

function stop() {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

export function subscribeNow(): () => void {
  subscribers++;
  start();
  return () => {
    subscribers--;
    if (subscribers <= 0) {
      subscribers = 0;
      stop();
    }
  };
}

export function getNow(): number {
  return now;
}
