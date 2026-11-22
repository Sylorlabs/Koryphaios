#!/usr/bin/env python3
"""Kory Export Console: a real Tk desktop application with two export targets.

The application owns its permission rule. An export is permitted only when the
target path resolves inside `/work/targets/authorized` and the parent directory is
actually writable by the running process. Every attempt is appended to
`/work/action-log.jsonl` with the outcome the application itself produced, so a
recording contains the application's decisions rather than a narration of them.

Nothing here simulates a permission prompt: the refusal is an `EACCES` or a path
rule enforced at the moment the button is pressed, and the permission race is a
real `chmod` performed by the session driver while the window is open.
"""

import json
import os
import time
import tkinter as tk
from pathlib import Path

WORK = Path('/work')
LOG = WORK / 'action-log.jsonl'
AUTHORIZED_ROOT = Path('/var/kory-targets/authorized')
DENIED_ROOT = Path('/var/kory-targets/denied')

state = {'last': 'idle'}


def record(entry):
    entry['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + '\n')


def attempt(target, path):
    """Perform one export and record exactly what the application observed."""
    resolved = Path(os.path.realpath(path))
    entry = {
        'target': target,
        'requestedPath': str(path),
        'resolvedPath': str(resolved),
        'permitted': False,
        'status': '',
        'bytesWritten': 0,
        'error': None,
    }
    if AUTHORIZED_ROOT not in resolved.parents:
        entry['status'] = 'PERMISSION DENIED: target is outside the authorized root'
        entry['error'] = 'EACCES (policy)'
        record(entry)
        return entry
    payload = 'quarterly export snapshot\n'
    try:
        with resolved.open('w', encoding='utf-8') as handle:
            handle.write(payload)
        entry['permitted'] = True
        entry['bytesWritten'] = len(payload.encode('utf-8'))
        entry['status'] = f'EXPORTED {entry["bytesWritten"]} bytes'
    except PermissionError as error:
        entry['status'] = 'PERMISSION DENIED: target is not writable'
        entry['error'] = f'EACCES ({error.strerror})'
    except OSError as error:
        entry['status'] = f'EXPORT FAILED: {error.strerror}'
        entry['error'] = f'{type(error).__name__} ({error.strerror})'
    record(entry)
    return entry


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    AUTHORIZED_ROOT.mkdir(parents=True, exist_ok=True)
    DENIED_ROOT.mkdir(parents=True, exist_ok=True)
    root = tk.Tk()
    root.title('Kory Export Console')
    root.geometry('560x360+80+80')
    root.configure(bg='#101418')

    title = tk.Label(
        root,
        text='Quarterly export',
        font=('DejaVu Sans', 18, 'bold'),
        fg='#e8eef4',
        bg='#101418',
    )
    title.place(x=24, y=18)

    subtitle = tk.Label(
        root,
        text='Choose a destination. The application enforces which targets may be written.',
        font=('DejaVu Sans', 10),
        fg='#9aa7b3',
        bg='#101418',
    )
    subtitle.place(x=24, y=56)

    status = tk.Label(
        root,
        text='Status: idle',
        font=('DejaVu Sans', 12),
        fg='#7fd1a0',
        bg='#101418',
        anchor='w',
        justify='left',
        wraplength=500,
    )
    status.place(x=24, y=250)

    def show(entry):
        state['last'] = entry['status']
        status.configure(
            text=f"Status: {entry['status']}\nPath: {entry['requestedPath']}",
            fg='#7fd1a0' if entry['permitted'] else '#e88a8a',
        )

    allowed = tk.Button(
        root,
        text='Export authorized',
        font=('DejaVu Sans', 12),
        command=lambda: show(attempt('authorized', AUTHORIZED_ROOT / 'report.txt')),
    )
    allowed.place(x=24, y=110, width=240, height=56)

    refused = tk.Button(
        root,
        text='Export denied',
        font=('DejaVu Sans', 12),
        command=lambda: show(attempt('denied', DENIED_ROOT / 'secret.txt')),
    )
    refused.place(x=296, y=110, width=240, height=56)

    retried = tk.Button(
        root,
        text='Retry authorized',
        font=('DejaVu Sans', 12),
        command=lambda: show(attempt('authorized', AUTHORIZED_ROOT / 'report.txt')),
    )
    retried.place(x=24, y=182, width=240, height=56)

    record({'target': 'session', 'permitted': True, 'status': 'surface ready', 'bytesWritten': 0, 'error': None})
    root.after(400, lambda: root.update())
    root.mainloop()


if __name__ == '__main__':
    main()
