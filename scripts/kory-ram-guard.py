#!/usr/bin/env python3
"""Overnight RAM guard for evaluation work.

Kills automation browsers (Chrome for Testing, Playwright Chromium, headless
shells) when they grow past a budget or the machine runs short of memory, and
publishes /tmp/kory-ram-pressure so workers can hold off heavy jobs. Never
touches Brave, the regular Google Chrome, or any non browser process.
"""
import os, re, signal, subprocess, time

LOG = os.environ.get('KORY_RAM_GUARD_LOG', '/tmp/kory-ram-guard.log')
FLAG = '/tmp/kory-ram-pressure'
BROWSER_BUDGET_MB = int(os.environ.get('KORY_RAM_GUARD_BROWSER_MB', '4096'))
MIN_FREE_PCT = int(os.environ.get('KORY_RAM_GUARD_MIN_FREE_PCT', '20'))
MIN_SWAP_FREE_MB = int(os.environ.get('KORY_RAM_GUARD_MIN_SWAP_FREE_MB', '1500'))
AUTOMATION = re.compile(r'Google Chrome for Testing|ms-playwright|chrome-headless-shell|Chromium\.app|puppeteer')
PROTECTED = re.compile(r'Brave Browser|/Applications/Google Chrome\.app/')

def log(msg):
    with open(LOG, 'a') as f:
        f.write(time.strftime('%H:%M:%S ') + msg + '\n')

def footprints():
    out = subprocess.run(['top', '-l', '1', '-o', 'mem', '-n', '300', '-stats', 'pid,mem'],
                         capture_output=True, text=True).stdout
    sizes = {}
    for line in out.splitlines():
        m = re.match(r'\s*(\d+)\s+([\d.]+)([KMGB])\+?\s*$', line)
        if m:
            n = float(m.group(2)) * {'B': 1 / 1048576, 'K': 1 / 1024, 'M': 1, 'G': 1024}[m.group(3)]
            sizes[int(m.group(1))] = n
    return sizes

def commands():
    out = subprocess.run(['ps', '-axo', 'pid=,etime=,command='], capture_output=True, text=True).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows[int(parts[0])] = parts[2]
    return rows

def free_pct():
    out = subprocess.run(['memory_pressure'], capture_output=True, text=True).stdout
    m = re.search(r'free percentage: (\d+)%', out)
    return int(m.group(1)) if m else 100

def swap_free_mb():
    out = subprocess.run(['sysctl', '-n', 'vm.swapusage'], capture_output=True, text=True).stdout
    m = re.search(r'free = ([\d.]+)M', out)
    return float(m.group(1)) if m else 1e9

def kill(pids, why):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(3)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    log(f'killed {len(pids)} automation browser processes: {why}')

log(f'start budget={BROWSER_BUDGET_MB}MB minFree={MIN_FREE_PCT}% minSwapFree={MIN_SWAP_FREE_MB}MB')
while True:
    try:
        cmds, sizes = commands(), footprints()
        browsers = {p: sizes.get(p, 0) for p, c in cmds.items() if AUTOMATION.search(c) and not PROTECTED.search(c)}
        total = sum(browsers.values())
        fp, sf = free_pct(), swap_free_mb()
        pressure = fp < MIN_FREE_PCT or (sf < MIN_SWAP_FREE_MB and fp < 2 * MIN_FREE_PCT)
        if pressure:
            open(FLAG, 'w').write(f'free={fp}% swapFree={sf:.0f}MB browsers={total:.0f}MB\n')
        elif os.path.exists(FLAG):
            os.remove(FLAG)
            log(f'pressure cleared free={fp}% swapFree={sf:.0f}MB')
        if browsers and (total > BROWSER_BUDGET_MB or pressure):
            kill(list(browsers), f'browsers={total:.0f}MB free={fp}% swapFree={sf:.0f}MB')
        elif pressure:
            log(f'pressure free={fp}% swapFree={sf:.0f}MB (no automation browsers to kill)')
    except Exception as e:
        log(f'error {e!r}')
    time.sleep(10)
