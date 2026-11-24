import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { isContainedBy } from '../../runtime/platform';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  chromiumBlockers,
  finishChecks,
  fixedFilesUnmodified,
  installPinnedOffline,
  pinnedPackageBlockers,
  recordCheck,
  runBounded,
  tryCheck,
  withRealChromium,
  type RuntimeCheck,
} from './skill-eval-real-web-runtime';
import {
  createConceptFixtures,
  type ConceptFixture,
  type ConceptVector,
} from './skill-eval-concept-fixtures';

function editVectors(): ConceptVector[] {
  return [3, 17, 61].flatMap((seed) => {
    const a = `account-${seed}`,
      b = `account-${seed + 1}`,
      id = `save-${seed}`;
    const input = {
      initial: { account: a, draft: '' },
      events: [
        { type: 'edit', text: `first-${seed}` },
        { type: 'queue', id },
        { type: 'retry', online: false },
        { type: 'recreate', defaultAccount: b },
        { type: 'select', account: b },
        { type: 'edit', text: `second-${seed}` },
        { type: 'start' },
        { type: 'start' },
        { type: 'render' },
        { type: 'retry', online: true },
        { type: 'retry', online: true },
        { type: 'stop' },
      ],
    };
    const expected = {
      account: b,
      draft: `second-${seed}`,
      pending: null,
      saves: [{ id, account: a, text: `first-${seed}` }],
      collectors: 0,
    };
    return [
      { name: `durable operation owns account and payload ${seed}`, input, expected },
      {
        name: `recreation restores draft/account without launching a save ${seed}`,
        input: {
          initial: { account: a, draft: `draft-${seed}` },
          events: [{ type: 'start' }, { type: 'recreate', defaultAccount: b }, { type: 'render' }],
        },
        expected: { account: a, draft: `draft-${seed}`, pending: null, saves: [], collectors: 0 },
      },
      {
        name: `offline pending work survives repeated recreation ${seed}`,
        input: {
          initial: { account: a, draft: 'pending' },
          events: [
            { type: 'queue', id },
            { type: 'recreate', defaultAccount: b },
            { type: 'recreate', defaultAccount: b },
            { type: 'retry', online: false },
          ],
        },
        expected: {
          account: a,
          draft: 'pending',
          pending: { id, account: a, text: 'pending' },
          saves: [],
          collectors: 0,
        },
      },
    ];
  });
}

function listVectors(): ConceptVector[] {
  return [4, 19, 47].flatMap((seed) => {
    const a = `message-${seed}`,
      b = `message-${seed + 1}`,
      older = `message-${seed - 1}`;
    const rows = [{ id: a }, { id: b }];
    const events = [
      { type: 'render' },
      { type: 'render' },
      { type: 'prepend', rows: [{ id: older }] },
      { type: 'render' },
      { type: 'loaded', id: a, avatar: 'portrait-a' },
    ];
    return [
      {
        name: `prepend preserves identity, anchor and one effect per row ${seed}`,
        input: { rows, anchor: b, events },
        expected: {
          keys: [older, a, b],
          anchor: b,
          avatars: { [a]: 'portrait-a' },
          active: [older, b].sort(),
          starts: 3,
          cancellations: 0,
        },
      },
      {
        name: `navigation cancels outstanding work and ignores late completion ${seed}`,
        input: {
          rows,
          anchor: b,
          events: [
            ...events,
            { type: 'away' },
            { type: 'away' },
            { type: 'loaded', id: b, avatar: 'late' },
            { type: 'render' },
          ],
        },
        expected: {
          keys: [older, a, b],
          anchor: b,
          avatars: { [a]: 'portrait-a' },
          active: [],
          starts: 3,
          cancellations: 2,
        },
      },
      {
        name: `repeated page delivery cannot duplicate rows or loads ${seed}`,
        input: {
          rows,
          anchor: a,
          events: [{ type: 'render' }, { type: 'prepend', rows: [{ id: a }] }, { type: 'render' }],
        },
        expected: {
          keys: [a, b],
          anchor: a,
          avatars: {},
          active: [a, b].sort(),
          starts: 2,
          cancellations: 0,
        },
      },
    ];
  });
}

function formVectors(): ConceptVector[] {
  return [2, 11, 37].flatMap((seed) => {
    const a = `customer-${seed}`,
      b = `customer-${seed + 1}`;
    const initial = { id: a, customers: { [a]: 'Alpha', [b]: 'Beta' } };
    return [
      {
        name: `A to B to A rejects the old A completion ${seed}`,
        input: {
          ...initial,
          events: [
            { type: 'edit', name: 'Dirty' },
            { type: 'save', request: 'old' },
            { type: 'route', id: b, allowed: true },
            { type: 'route', id: a, allowed: true },
            { type: 'resolve', request: 'old', name: 'Wrong' },
          ],
        },
        expected: {
          id: a,
          name: 'Alpha',
          dirty: false,
          saved: false,
          focus: null,
          pending: [],
          destroyed: false,
        },
      },
      {
        name: `new customer save survives stale prior customer response ${seed}`,
        input: {
          ...initial,
          events: [
            { type: 'save', request: 'old' },
            { type: 'route', id: b, allowed: true },
            { type: 'edit', name: 'Beta changed' },
            { type: 'save', request: 'new' },
            { type: 'resolve', request: 'new', name: 'Beta changed' },
            { type: 'resolve', request: 'old', name: 'Wrong' },
          ],
        },
        expected: {
          id: b,
          name: 'Beta changed',
          dirty: false,
          saved: true,
          focus: null,
          pending: [],
          destroyed: false,
        },
      },
      {
        name: `validation and declined navigation preserve the draft ${seed}`,
        input: {
          ...initial,
          events: [
            { type: 'edit', name: '' },
            { type: 'save', request: 'invalid' },
            { type: 'route', id: b, allowed: false },
          ],
        },
        expected: {
          id: a,
          name: '',
          dirty: true,
          saved: false,
          focus: 'name',
          pending: [],
          destroyed: false,
        },
      },
      {
        name: `same-id reuse keeps dirty input, destroy ends requests ${seed}`,
        input: {
          ...initial,
          events: [
            { type: 'edit', name: 'Draft' },
            { type: 'route', id: a, allowed: true },
            { type: 'save', request: 'late' },
            { type: 'destroy' },
            { type: 'resolve', request: 'late', name: 'Wrong' },
          ],
        },
        expected: {
          id: a,
          name: 'Draft',
          dirty: true,
          saved: false,
          focus: null,
          pending: [],
          destroyed: true,
        },
      },
    ];
  });
}

function scopeVectors(): ConceptVector[] {
  return [8, 23, 71].flatMap((seed) => {
    const a = `feature-${seed}`,
      b = `feature-${seed + 1}`;
    const events = [
      { type: 'enter', owner: a },
      { type: 'open-overlay', owner: a, id: 'overlay-a' },
      { type: 'tick' },
      { type: 'close-overlay', id: 'overlay-a' },
      { type: 'open-overlay', owner: a, id: 'overlay-b' },
      { type: 'tick' },
      { type: 'enter', owner: b },
      { type: 'open-overlay', owner: b, id: 'overlay-c' },
      { type: 'tick' },
      { type: 'exit', owner: a },
      { type: 'tick' },
      { type: 'exit', owner: b },
      { type: 'exit', owner: b },
      { type: 'tick' },
    ];
    return [
      {
        name: `feature ownership survives overlay churn and cleans once ${seed}`,
        input: { events },
        expected: { active: [], started: 2, stopped: 2, notifications: { [a]: 3, [b]: 2 } },
      },
      {
        name: `two concurrent features do not share a global owner ${seed}`,
        input: {
          events: [
            { type: 'enter', owner: a },
            { type: 'enter', owner: b },
            { type: 'enter', owner: a },
            { type: 'tick' },
          ],
        },
        expected: {
          active: [a, b].sort(),
          started: 2,
          stopped: 0,
          notifications: { [a]: 1, [b]: 1 },
        },
      },
      {
        name: `returning feature starts a fresh lifetime ${seed}`,
        input: { events: [...events, { type: 'enter', owner: a }, { type: 'tick' }] },
        expected: { active: [a], started: 3, stopped: 2, notifications: { [a]: 4, [b]: 2 } },
      },
    ];
  });
}

const composeBlockers = [
  'Component simulation only: add the Compose app/device harness and native semantics, focus, font-scale, and recreation evidence before full-task execution.',
];
const angularBlockers = [
  'Component simulation only: add the Angular component/router/injector harness, build, and browser keyboard evidence before full-task execution.',
];

export const LIFECYCLE_CONCEPTS: readonly ConceptFixture[] = [
  {
    id: 'android-compose-full-task-1-individual',
    skill: 'android-compose',
    blockers: composeBlockers,
    contract: `Replay {initial:{account,draft},events}. edit changes draft; select changes account; queue captures {id,account,text} for the current draft. retry commits that captured operation once only when online, then clears pending. recreation restores selected account, draft and pending work, ignoring a different defaultAccount; it ends ephemeral collectors. render must not save or subscribe. start/stop own at most one collector. Return {account,draft,pending,saves,collectors}; saves preserves commit order. No Activity, ViewModel, UI toolkit, storage library, or production architecture is prescribed by this component contract. Native behavior still needs the full-task harness.`,
    vectors: editVectors,
  },
  {
    id: 'android-compose-full-task-2-individual',
    skill: 'android-compose',
    blockers: composeBlockers,
    contract: `Replay {rows:[{id}],anchor,events}. render starts one avatar load for each row lacking an active/completed load. prepend adds previously unseen ids before existing rows, preserving the anchor by identity; it does not itself launch work. loaded accepts a result only for an active load, removes that load, and assigns its avatar to that id. away cancels outstanding loads exactly once and ignores later render/completion events. Return {keys,anchor,avatars,active,starts,cancellations}; keys is display order, active is sorted. Verify logical ownership without claiming Compose, TalkBack, or a device ran.`,
    vectors: listVectors,
  },
  {
    id: 'angular-engineering-full-task-1-individual',
    skill: 'angular-engineering',
    blockers: angularBlockers,
    contract: `Replay {id,customers:{id:name},events}. Initially load that customer's name. edit changes name, makes dirty and clears saved. An allowed route to a DIFFERENT id resets name/dirty/saved/focus and invalidates pending requests, even if a later route returns to the same id; declined or same-id navigation leaves the draft intact. save with empty/whitespace name sets focus to name and starts no request. Other saves capture request identity plus route lifetime. resolve may update name and set saved/clear dirty only for a still-pending request in the active lifetime. destroy invalidates pending requests and ignores later events. Return {id,name,dirty,saved,focus,pending,destroyed}, with pending sorted request ids. The component contract accepts any implementation; Angular/browser integration is a separate required gate.`,
    vectors: formVectors,
  },
  {
    id: 'angular-engineering-full-task-2-individual',
    skill: 'angular-engineering',
    blockers: angularBlockers,
    contract: `Replay {events}. enter(owner) starts one poller for that feature lifetime, idempotently while active. Overlay open/close uses the supplied owner and never creates/stops a feature poller. tick emits one notification per active feature regardless of overlay count. exit ends that owner's poller exactly once; later re-entry starts a new lifetime. Return {active,started,stopped,notifications}, active sorted and notifications cumulative by owner. Independent simultaneous feature owners must remain separate; a global singleton is not an equivalent solution. This tests resource lifetime, not a real Angular injector.`,
    vectors: scopeVectors,
  },
];
// Angular and Android Compose full tasks use their native runtimes. Their
// state-machine definitions remain as component-only regression controls.
const fixtures = createConceptFixtures(
  LIFECYCLE_CONCEPTS.filter(
    (item) => item.skill !== 'angular-engineering' && item.skill !== 'android-compose',
  ),
);

const ANGULAR_FORM = 'angular-engineering-full-task-1-individual';
const ANGULAR_SCOPE = 'angular-engineering-full-task-2-individual';
const ANGULAR_VERSION = '20.3.16';
const ANGULAR_PACKAGES = [
  '@angular/common',
  '@angular/compiler',
  '@angular/compiler-cli',
  '@angular/core',
  '@angular/forms',
  '@angular/platform-browser',
  '@angular/router',
] as const;
const ANGULAR_READINESS = [
  ...pinnedPackageBlockers(ANGULAR_PACKAGES.map((name) => [name, ANGULAR_VERSION] as const)),
  ...pinnedPackageBlockers([
    ['rxjs', '7.8.2'],
    ['zone.js', '0.15.1'],
    ['typescript', '5.9.3'],
  ]),
  ...chromiumBlockers(),
];

export const ANGULAR_RUNTIME_V5 = {
  version: ANGULAR_VERSION,
  readinessBlockers: ANGULAR_READINESS,
} as const;

const ANGULAR_PACKAGE = `${JSON.stringify(
  {
    name: 'kory-angular-v5-runtime',
    private: true,
    type: 'module',
    dependencies: {
      '@angular/common': ANGULAR_VERSION,
      '@angular/compiler': ANGULAR_VERSION,
      '@angular/core': ANGULAR_VERSION,
      '@angular/forms': ANGULAR_VERSION,
      '@angular/platform-browser': ANGULAR_VERSION,
      '@angular/router': ANGULAR_VERSION,
      rxjs: '7.8.2',
      'zone.js': '0.15.1',
      tslib: '2.8.1',
    },
    devDependencies: { '@angular/compiler-cli': ANGULAR_VERSION, typescript: '5.9.3' },
  },
  null,
  2,
)}\n`;
const ANGULAR_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      strict: true,
      experimentalDecorators: true,
      skipLibCheck: true,
      lib: ['ES2022', 'dom'],
      types: [],
      outDir: 'out',
    },
    angularCompilerOptions: { strictTemplates: true, strictInjectionParameters: true },
    files: ['src/main.ts'],
  },
  null,
  2,
)}\n`;
const ANGULAR_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><app-root></app-root><script type="module" src="/main.js"></script></body></html>\n';
const ANGULAR_CSS =
  'body{font:16px/1.5 system-ui;margin:20px;color:#182536}nav{display:flex;flex-wrap:wrap;gap:8px}button,input{font:inherit;padding:6px}button:focus-visible,input:focus-visible{outline:3px solid #335ed4}main{max-width:680px;margin:auto}form{display:grid;gap:8px;max-width:360px}aside{border:1px solid #8896ab;padding:6px;margin:8px}';
const ANGULAR_AWAY = `import { Component } from '@angular/core';
@Component({ standalone: true, selector: 'app-away', template: '<p id="away">Away from feature</p>' })
export class AwayComponent {}
`;

// The save service deliberately permits a late response after navigation. The candidate
// must reject the result by route lifetime, including an A -> B -> A return to the same ID.
const FORM_SOURCE = `export const customers: Record<string, string> = { alpha: 'Alice', beta: 'Bob' };
type Pending = { resolve: (name: string) => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
const requests: { id: string; customer: string; name: string }[] = [];
let sequence = 0;
const oracle = {
  requests,
  resolve(id: string, name: string) { const item = pending.get(id); if (!item) throw Error('No request ' + id); pending.delete(id); item.resolve(name); },
  reject(id: string) { const item = pending.get(id); if (!item) throw Error('No request ' + id); pending.delete(id); item.reject(Error('Save failed')); },
};
(window as typeof window & { __angularSave: typeof oracle }).__angularSave = oracle;
export function saveCustomer(customer: string, name: string): Promise<string> {
  const id = 'request-' + ++sequence;
  requests.push({ id, customer, name });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
`;

const FORM_SHELL = `import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
@Component({ standalone: true, selector: 'app-root', imports: [RouterOutlet], template:
  \`<main><nav><button id="go-alpha" (click)="go('alpha')">Alpha</button><button id="go-beta" (click)="go('beta')">Beta</button><button id="go-away" (click)="go('away')">Away</button></nav><router-outlet /></main>\` })
export class ShellComponent {
  private router = inject(Router);
  go(id: string) { void this.router.navigateByUrl(id === 'away' ? '/away' : '/customer/' + id); }
}
`;
// Angular's published framework packages are partially compiled. The candidate is
// compiled by ngc in AOT mode; the compiler import supplies the required fallback
// for framework declarations when Bun bundles the output without Angular Linker.
const FORM_MAIN = `import '@angular/compiler';
import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { ShellComponent } from './shell.component';
import { EditorComponent } from './candidate.component';
import { AwayComponent } from './away.component';
bootstrapApplication(ShellComponent, { providers: [provideRouter([
  { path: 'customer/:id', component: EditorComponent },
  { path: 'away', component: AwayComponent },
  { path: '', pathMatch: 'full', redirectTo: 'customer/alpha' },
])] }).catch(error => console.error(error));
`;

// A plausible broken implementation: subscriptions and promises escape their route lifetime.
const FORM_STARTER = `import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { customers, saveCustomer } from './source';
@Component({ standalone: true, selector: 'app-editor', imports: [ReactiveFormsModule], template:
  '<section id="editor" [attr.data-customer-id]="id()"><h1>Customer {{id()}}</h1><form [formGroup]="form" (ngSubmit)="save()"><label for="name">Name</label><input id="name" formControlName="name"/><button id="save" type="submit">Save</button></form><p id="save-status">{{status()}}</p></section>' })
export class EditorComponent {
  private route = inject(ActivatedRoute);
  id = signal(this.route.snapshot.paramMap.get('id') ?? 'alpha');
  form = new FormGroup({ name: new FormControl(customers[this.id()] ?? '', { nonNullable: true, validators: [Validators.required] }) });
  status = signal('');
  constructor() { this.route.paramMap.subscribe(params => this.id.set(params.get('id') ?? 'alpha')); }
  async save() {
    if (this.form.invalid) return;
    const name = await saveCustomer(this.id(), this.form.controls.name.value);
    this.form.controls.name.setValue(name);
    this.status.set('saved');
  }
}
`;

// A real Angular injectable owns a live timer. An overlay creates a second injection
// boundary; accidentally resolving from the application injector leaks a root poller.
const SCOPE_SOURCE = `import { Injectable } from '@angular/core';
const metrics: { started: number; stopped: number; active: number; notifications: Record<string, number> } =
  { started: 0, stopped: 0, active: 0, notifications: {} };
(window as typeof window & { __angularPoll: typeof metrics }).__angularPoll = metrics;
@Injectable()
export class FeaturePollerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  start(owner: string) {
    if (this.timer !== null) return;
    metrics.started++; metrics.active++; metrics.notifications[owner] ??= 0;
    this.timer = setInterval(() => metrics.notifications[owner]++, 40);
  }
  ngOnDestroy() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    metrics.stopped++; metrics.active--;
  }
}
`;
const SCOPE_OVERLAY = `import { Component, Input, OnInit, inject } from '@angular/core';
import { FeaturePollerService } from './source';
@Component({ standalone: true, selector: 'app-overlay', template: '<div class="dialog" [attr.data-overlay-owner]="owner">Overlay {{owner}}</div>' })
export class OverlayComponent implements OnInit {
  @Input({ required: true }) owner!: string;
  private poller = inject(FeaturePollerService);
  ngOnInit() { this.poller.start(this.owner); }
}
`;
const SCOPE_SHELL = `import { Component, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { FeatureComponent } from './candidate.component';
@Component({ standalone: true, selector: 'app-root', imports: [RouterOutlet, NgIf, FeatureComponent], template:
  \`<main><nav><button id="go-alpha" (click)="go('alpha')">Alpha</button><button id="go-beta" (click)="go('beta')">Beta</button><button id="go-away" (click)="go('away')">Away</button><button id="toggle-side" (click)="side = !side">Second feature</button></nav><router-outlet /><app-feature *ngIf="side" owner="side"/><div id="overlay-root"></div></main>\` })
export class ShellComponent {
  side = false;
  private router = inject(Router);
  go(id: string) { void this.router.navigateByUrl(id === 'away' ? '/away' : '/feature/' + id); }
}
`;
const SCOPE_MAIN = `import '@angular/compiler';
import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { ShellComponent } from './shell.component';
import { FeatureComponent } from './candidate.component';
import { FeaturePollerService } from './source';
import { AwayComponent } from './away.component';
bootstrapApplication(ShellComponent, { providers: [FeaturePollerService, provideRouter([
  { path: 'feature/alpha', component: FeatureComponent, data: { owner: 'alpha' } },
  { path: 'feature/beta', component: FeatureComponent, data: { owner: 'beta' } },
  { path: 'away', component: AwayComponent },
  { path: '', pathMatch: 'full', redirectTo: 'feature/alpha' },
], withComponentInputBinding())] }).catch(error => console.error(error));
`;
const SCOPE_STARTER = `import { ApplicationRef, Component, ComponentRef, EnvironmentInjector, Input, OnDestroy, OnInit, createComponent, inject } from '@angular/core';
import { FeaturePollerService } from './source';
import { OverlayComponent } from './overlay.component';
@Component({ standalone: true, selector: 'app-feature', providers: [FeaturePollerService], template:
  '<section class="feature" [attr.data-owner]="owner"><h2>Feature {{owner}}</h2><button class="open" (click)="open()">Open overlay</button><button class="close" (click)="close()">Close overlay</button></section>' })
export class FeatureComponent implements OnInit, OnDestroy {
  @Input({ required: true }) owner!: string;
  private service = inject(FeaturePollerService);
  private environment = inject(EnvironmentInjector);
  private app = inject(ApplicationRef);
  private overlay: ComponentRef<OverlayComponent> | null = null;
  private host: HTMLElement | null = null;
  ngOnInit() { this.service.start(this.owner); }
  open() {
    if (this.overlay) return;
    this.host = document.createElement('aside');
    document.getElementById('overlay-root')!.appendChild(this.host);
    // Incorrectly resolves the overlay poller from the application injector.
    this.overlay = createComponent(OverlayComponent, { environmentInjector: this.environment, hostElement: this.host });
    this.app.attachView(this.overlay.hostView);
    this.overlay.setInput('owner', this.owner);
    this.overlay.changeDetectorRef.detectChanges();
  }
  close() {
    if (!this.overlay) return;
    this.app.detachView(this.overlay.hostView);
    this.overlay.destroy();
    this.host?.remove(); this.overlay = null; this.host = null;
  }
  ngOnDestroy() { this.close(); }
}
`;

function angularFixed(number: 1 | 2): Record<string, string> {
  return {
    'package.json': ANGULAR_PACKAGE,
    'tsconfig.json': ANGULAR_TSCONFIG,
    'index.html': ANGULAR_HTML,
    'style.css': ANGULAR_CSS,
    'src/main.ts': number === 1 ? FORM_MAIN : SCOPE_MAIN,
    'src/shell.component.ts': number === 1 ? FORM_SHELL : SCOPE_SHELL,
    'src/away.component.ts': ANGULAR_AWAY,
    'src/source.ts': number === 1 ? FORM_SOURCE : SCOPE_SOURCE,
    ...(number === 2 ? { 'src/overlay.component.ts': SCOPE_OVERLAY } : {}),
  };
}

function materializeAngular(root: string, number: 1 | 2): void {
  if (ANGULAR_READINESS.length) throw new Error(ANGULAR_READINESS.join('; '));
  for (const [path, content] of Object.entries(angularFixed(number)))
    writeFixtureFile(root, path, content);
  writeFixtureFile(root, 'src/candidate.component.ts', number === 1 ? FORM_STARTER : SCOPE_STARTER);
  writeFixtureFile(root, 'verification/result.json', '{"status":"TODO"}\n');
  writeFixtureFile(
    root,
    'README.md',
    `# Angular ${ANGULAR_VERSION} full-task browser fixture\n\n` +
      (number === 1
        ? 'Repair src/candidate.component.ts: use Angular signals, reactive forms and real Router reuse. Reinitialize only on entity lifetime changes, reject stale saves including A -> B -> A, handle rejected saves, focus the invalid name input, and tear down route subscriptions. The UI contract uses #editor, #name, #save and #save-status (saved/error).\n'
        : 'Repair src/candidate.component.ts: use Angular DI to share one feature-scoped FeaturePollerService with the dynamically created overlay, ensure service teardown on feature navigation and overlay cleanup, and support concurrent feature owners. Preserve .feature, [data-owner], .open, and .close for browser testing. Never rely on an application singleton.\n') +
      'All fixed shell, service, compiler, and application entrypoint inputs are evaluator-owned and immutable. In particular, preserve src/main.ts byte-for-byte, including its application providers; make the feature-scoped repair only in src/candidate.component.ts. The scorer runs Angular AOT with strict template and injection checks, bundles the emitted app, and exercises real Chromium. Add verification/result.json with exactly status=verified, angularVersion=\`' +
      ANGULAR_VERSION +
      '\`, broaderSkill=frontend-engineering, nearNeighbor=\`' +
      (number === 1 ? 'react-engineering' : 'svelte-engineering') +
      '\`, and recovery (a specific string longer than 20 characters). Candidate claims do not substitute for scorer checks or independent blind semantic review.\n',
  );
}

const ANGULAR_RUNTIME_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'angular-engineering/route-signal-form-aot-chromium@5',
    realRuntime: true,
    readinessBlockers: ANGULAR_READINESS.length ? ANGULAR_READINESS : undefined,
    matches: (scenario) => scenario.id === ANGULAR_FORM,
    materialize: (root) => materializeAngular(root, 1),
  },
  {
    id: 'angular-engineering/feature-injector-aot-chromium@5',
    realRuntime: true,
    readinessBlockers: ANGULAR_READINESS.length ? ANGULAR_READINESS : undefined,
    matches: (scenario) => scenario.id === ANGULAR_SCOPE,
    materialize: (root) => materializeAngular(root, 2),
  },
];

function angularCandidateEvidence(root: string, number: 1 | 2): boolean {
  const result = readJsonArtifact<Record<string, unknown>>(root, 'verification/result.json');
  return (
    result?.status === 'verified' &&
    result?.angularVersion === ANGULAR_VERSION &&
    result?.broaderSkill === 'frontend-engineering' &&
    result?.nearNeighbor === (number === 1 ? 'react-engineering' : 'svelte-engineering') &&
    typeof result?.recovery === 'string' &&
    result.recovery.length > 20
  );
}

async function checkAngularForm(page: Page, checks: RuntimeCheck[]): Promise<void> {
  await page.locator('[data-customer-id="alpha"]').waitFor();
  await tryCheck(checks, 'Angular initial route and reactive form', async () => [
    (await page.locator('#name').inputValue()) === 'Alice' &&
      (await page.locator('label[for="name"]').count()) === 1,
    'Angular Router initialized customer alpha and attached a labeled FormControl',
  ]);

  await page.evaluate(() => {
    (window as unknown as { __editorRef: Element | null }).__editorRef =
      document.querySelector('#editor');
  });
  await page.locator('#name').fill('unsaved draft');
  await page.locator('#go-beta').click();
  await page.locator('[data-customer-id="beta"]').waitFor();
  await tryCheck(checks, 'route reuse changes entity without leaking draft', async () => [
    (await page.locator('#name').inputValue()) === 'Bob' &&
      (await page.evaluate(
        () =>
          (window as unknown as { __editorRef: Element }).__editorRef ===
          document.querySelector('#editor'),
      )),
    'Angular reused the same component while the route ID changed and the draft reset',
  ]);

  await page.locator('#go-alpha').click();
  await page.locator('[data-customer-id="alpha"]').waitFor();
  await page.locator('#name').fill('stale request');
  await page.locator('#save').click();
  const oldRequest = await page.evaluate(() => {
    const reqs = (window as unknown as { __angularSave: { requests: { id: string }[] } })
      .__angularSave.requests;
    return reqs.at(-1)?.id;
  });
  await page.locator('#go-beta').click();
  await page.locator('[data-customer-id="beta"]').waitFor();
  await page.locator('#go-alpha').click();
  await page.locator('[data-customer-id="alpha"]').waitFor();
  await page.evaluate((id) => {
    (
      window as unknown as { __angularSave: { resolve: (id: string, name: string) => void } }
    ).__angularSave.resolve(id!, 'STALE');
  }, oldRequest);
  await page.waitForTimeout(50);
  await tryCheck(checks, 'A to B to A rejects stale completion', async () => [
    (await page.locator('#name').inputValue()) === 'Alice' &&
      (await page.locator('#save-status').innerText()).trim() !== 'saved',
    'An earlier alpha save cannot commit after alpha was left and revisited',
  ]);

  await page.locator('#name').fill('   ');
  await page.locator('#save').click();
  await tryCheck(checks, 'whitespace validation and keyboard focus', async () => [
    (await page.locator('#name').evaluate((element) => document.activeElement === element)) &&
      (await page.evaluate(
        () =>
          (window as unknown as { __angularSave: { requests: unknown[] } }).__angularSave.requests
            .length,
      )) === 1,
    'Blank name is rejected before issuing a request and focus returns to the invalid field',
  ]);

  await page.locator('#name').fill('Edited by keyboard');
  await page.locator('#name').press('Enter');
  const failedRequest = await page.evaluate(() => {
    const reqs = (window as unknown as { __angularSave: { requests: { id: string }[] } })
      .__angularSave.requests;
    return reqs.at(-1)?.id;
  });
  await page.evaluate((id) => {
    (window as unknown as { __angularSave: { reject: (id: string) => void } }).__angularSave.reject(
      id!,
    );
  }, failedRequest);
  await page.waitForTimeout(50);
  await tryCheck(checks, 'async error preserves draft', async () => [
    (await page.locator('#name').inputValue()) === 'Edited by keyboard' &&
      (await page.locator('#save-status').innerText()).trim() === 'error',
    'Rejected async save reports an error and preserves the draft',
  ]);

  await page.locator('#save').click();
  const goodRequest = await page.evaluate(() => {
    const reqs = (window as unknown as { __angularSave: { requests: { id: string }[] } })
      .__angularSave.requests;
    return reqs.at(-1)?.id;
  });
  await page.evaluate((id) => {
    (
      window as unknown as { __angularSave: { resolve: (id: string, name: string) => void } }
    ).__angularSave.resolve(id!, 'Saved customer');
  }, goodRequest);
  await page.waitForTimeout(50);
  await tryCheck(checks, 'keyboard submit and successful save', async () => [
    (await page.locator('#name').inputValue()) === 'Saved customer' &&
      (await page.locator('#save-status').innerText()).trim() === 'saved',
    'Enter submitted through Angular forms; successful completion updated active state',
  ]);

  await page.locator('#save').click();
  const afterDestroyRequest = await page.evaluate(() => {
    const reqs = (window as unknown as { __angularSave: { requests: { id: string }[] } })
      .__angularSave.requests;
    return reqs.at(-1)?.id;
  });
  await page.locator('#go-away').click();
  await page.locator('#away').waitFor();
  await page.evaluate((id) => {
    (
      window as unknown as { __angularSave: { resolve: (id: string, name: string) => void } }
    ).__angularSave.resolve(id!, 'AFTER DESTROY');
  }, afterDestroyRequest);
  await page.locator('#go-beta').click();
  await page.locator('[data-customer-id="beta"]').waitFor();
  await tryCheck(checks, 'route teardown and late response', async () => [
    (await page.locator('#name').inputValue()) === 'Bob' &&
      (await page.locator('#save-status').innerText()).trim() !== 'saved',
    'A response after the Angular component was destroyed cannot corrupt a fresh route',
  ]);
}

async function checkAngularScope(page: Page, checks: RuntimeCheck[]): Promise<void> {
  const snapshot = () =>
    page.evaluate(() => ({
      ...(
        window as unknown as {
          __angularPoll: {
            started: number;
            stopped: number;
            active: number;
            notifications: Record<string, number>;
          };
        }
      ).__angularPoll,
    }));
  await page.locator('[data-owner="alpha"]').waitFor();
  await page.waitForFunction(
    () => (window as unknown as { __angularPoll: { active: number } }).__angularPoll.active === 1,
  );
  await tryCheck(checks, 'feature starts one real poller', async () => {
    const state = await snapshot();
    return [
      state.active === 1 && state.started === 1 && state.stopped === 0,
      `initial active=${state.active} started=${state.started} stopped=${state.stopped}`,
    ];
  });
  const initial = (await snapshot()).notifications.alpha ?? 0;
  await page.locator('[data-owner="alpha"] .open').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-overlay-owner="alpha"]').waitFor();
  await page.waitForTimeout(140);
  await tryCheck(checks, 'keyboard overlay shares feature injector and timer', async () => {
    const state = await snapshot();
    return [
      state.active === 1 && state.started === 1 && (state.notifications.alpha ?? 0) > initial,
      `overlay active=${state.active}, started=${state.started}, alpha ticks=${state.notifications.alpha}`,
    ];
  });
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-owner="alpha"] .close').click();
    await page.locator('[data-owner="alpha"] .open').click();
  }
  await page.locator('[data-owner="alpha"] .close').click();
  await tryCheck(checks, 'repeated overlay churn does not spawn pollers', async () => {
    const state = await snapshot();
    return [
      state.started === 1 && state.active === 1 && state.stopped === 0,
      `after overlay churn: ${JSON.stringify(state)}`,
    ];
  });

  await page.locator('#go-beta').click();
  await page.locator('[data-owner="beta"]').waitFor();
  const oldTicks = (await snapshot()).notifications.alpha ?? 0;
  await page.waitForTimeout(125);
  await tryCheck(checks, 'router navigation destroys prior scoped poller', async () => {
    const state = await snapshot();
    return [
      state.active === 1 &&
        state.started === 2 &&
        state.stopped === 1 &&
        state.notifications.alpha === oldTicks &&
        (state.notifications.beta ?? 0) > 0,
      `after beta navigation: ${JSON.stringify(state)}`,
    ];
  });

  await page.locator('#toggle-side').click();
  await page.locator('[data-owner="side"]').waitFor();
  await page.waitForTimeout(120);
  await tryCheck(checks, 'simultaneous features own separate injectors', async () => {
    const state = await snapshot();
    return [
      state.active === 2 &&
        state.started === 3 &&
        state.stopped === 1 &&
        (state.notifications.side ?? 0) > 0,
      `beta and side active: ${JSON.stringify(state)}`,
    ];
  });
  await page.locator('[data-owner="beta"] .open').click();
  await page.locator('[data-overlay-owner="beta"]').waitFor();
  await page.locator('[data-owner="beta"] .close').click();
  await page.locator('#go-away').click();
  await page.locator('#away').waitFor();
  await page.locator('#toggle-side').click();
  await page.locator('[data-owner="side"]').waitFor({ state: 'detached' });
  const ended = await snapshot();
  await page.waitForTimeout(125);
  await tryCheck(checks, 'teardown stops all real interval notifications', async () => {
    const state = await snapshot();
    return [
      state.active === 0 &&
        state.stopped === 3 &&
        state.started === 3 &&
        JSON.stringify(state.notifications) === JSON.stringify(ended.notifications),
      `after teardown: ${JSON.stringify(state)}`,
    ];
  });
  await page.locator('#go-alpha').click();
  await page.locator('[data-owner="alpha"]').waitFor();
  await page.locator('#go-away').click();
  await page.locator('#away').waitFor();
  await tryCheck(checks, 'reentry creates a fresh feature lifetime', async () => {
    const state = await snapshot();
    return [
      state.active === 0 && state.started === 4 && state.stopped === 4,
      `after reentry: ${JSON.stringify(state)}`,
    ];
  });
}

async function runAngularBrowser(
  root: string,
  number: 1 | 2,
  checks: RuntimeCheck[],
): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'kory-angular-v5-browser-'));
  try {
    for (const [path, content] of Object.entries(angularFixed(number)))
      writeFixtureFile(temporary, path, content);
    writeFixtureFile(
      temporary,
      'src/candidate.component.ts',
      readFixtureText(root, 'src/candidate.component.ts'),
    );
    await installPinnedOffline(temporary);
    await runBounded(
      join(temporary, 'node_modules/.bin/ngc'),
      ['-p', 'tsconfig.json'],
      temporary,
      60_000,
    );
    recordCheck(
      checks,
      'Angular AOT and strict template typecheck',
      true,
      `@angular/compiler-cli ${ANGULAR_VERSION} compiled candidate component and all templates`,
      false,
    );
    const build = await Bun.build({
      entrypoints: [join(temporary, 'out/main.js')],
      target: 'browser',
      outdir: join(temporary, 'dist'),
    });
    if (!build.success)
      throw new Error(
        'Angular browser bundle failed: ' + build.logs.map((x) => x.message).join('; '),
      );
    const entry = build.outputs.find((item) => item.kind === 'entry-point');
    if (!entry) throw new Error('Angular browser bundle missing an entry point');
    writeFileSync(
      join(temporary, 'index.html'),
      ANGULAR_HTML.replace('/main.js', '/dist/' + basename(entry.path)),
    );
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const path = resolve(temporary, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!isContainedBy(temporary, path) || !existsSync(path) || !lstatSync(path).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type':
          extname(path) === '.js'
            ? 'text/javascript'
            : extname(path) === '.css'
              ? 'text/css'
              : 'text/html',
        'Cache-Control': 'no-store',
      });
      response.end(readFileSync(path));
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', done);
    });
    try {
      await withRealChromium(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 840 } });
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          const consoleErrors: string[] = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('Angular HTTP fixture did not bind');
          await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
          try {
            if (number === 1) await checkAngularForm(page, checks);
            else await checkAngularScope(page, checks);
          } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            const body = await page
              .locator('body')
              .innerText()
              .catch(() => 'unavailable');
            throw new Error(
              `${cause}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}; body=${JSON.stringify(body.slice(0, 350))}`,
            );
          }
          recordCheck(
            checks,
            'Angular browser uncaught errors',
            pageErrors.length === 0,
            pageErrors.length ? pageErrors.join('; ').slice(0, 600) : 'No page errors in Chromium',
          );
        } finally {
          await context.close();
        }
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function scoreAngularRuntimeFixture(root: string, number: 1 | 2) {
  const checks: RuntimeCheck[] = [];
  const fixed = angularFixed(number);
  const unchanged = fixedFilesUnmodified(root, fixed);
  let regularCandidate = false;
  try {
    const stat = lstatSync(join(root, 'src/candidate.component.ts'));
    regularCandidate = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 200_000;
  } catch {
    /* Missing component fails closed. */
  }
  if (!unchanged || !regularCandidate)
    return finishChecks(
      [
        {
          name: 'fixed fixture and candidate integrity',
          passed: false,
          detail: 'Missing/altered immutable Angular inputs or unsafe candidate',
          browser: false,
        },
      ],
      true,
    );
  recordCheck(
    checks,
    'candidate hierarchy and recovery evidence',
    angularCandidateEvidence(root, number),
    'Candidate states pinned Angular version, selected specialist, broader skill, neighbor and recovery',
    false,
  );
  if (ANGULAR_READINESS.length) {
    for (const blocker of ANGULAR_READINESS)
      recordCheck(checks, 'real Angular readiness', false, blocker, false);
  } else {
    try {
      await runAngularBrowser(root, number, checks);
    } catch (error) {
      recordCheck(
        checks,
        'Angular compiler/browser execution',
        false,
        error instanceof Error ? error.message.slice(0, 900) : String(error),
      );
    }
  }
  const retained = fixedFilesUnmodified(root, fixed);
  if (!retained)
    recordCheck(
      checks,
      'immutable Angular fixture after execution',
      false,
      'Fixed inputs changed during evaluation',
      false,
    );
  return finishChecks(checks, !retained);
}

const ANGULAR_RUNTIME_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'angular-engineering/route-signal-form-aot-chromium-scorer@5',
    scenarioIds: [ANGULAR_FORM],
    score: ({ workingDirectory }) => scoreAngularRuntimeFixture(workingDirectory, 1),
  },
  {
    id: 'angular-engineering/feature-injector-aot-chromium-scorer@5',
    scenarioIds: [ANGULAR_SCOPE],
    score: ({ workingDirectory }) => scoreAngularRuntimeFixture(workingDirectory, 2),
  },
];

export const LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  ...fixtures.materializers,
  ...ANGULAR_RUNTIME_MATERIALIZERS,
];
export const LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  ...fixtures.scorers,
  ...ANGULAR_RUNTIME_SCORERS,
];
