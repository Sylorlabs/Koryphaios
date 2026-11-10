import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  ANGULAR_RUNTIME_V5,
  LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS,
  LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS,
} from '../skill-eval-lifecycle-concept-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FORM_CONTROL = `import { Component, DestroyRef, inject, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { customers, saveCustomer } from './source';
@Component({ standalone: true, selector: 'app-editor', imports: [ReactiveFormsModule], template:
  '<section id="editor" [attr.data-customer-id]="id()"><h1>Customer {{id()}}</h1><form [formGroup]="form" (ngSubmit)="save()"><label for="name">Name</label><input id="name" formControlName="name"/><button id="save" type="submit">Save</button></form><p id="save-status">{{status()}}</p></section>' })
export class EditorComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly id = signal(this.route.snapshot.paramMap.get('id') ?? 'alpha');
  readonly form = new FormGroup({ name: new FormControl(customers[this.id()] ?? '', { nonNullable: true }) });
  readonly status = signal('');
  private lifetime = 0;
  private destroyed = false;
  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const next = params.get('id') ?? 'alpha';
      if (this.lifetime && next === this.id()) return;
      this.lifetime++;
      this.id.set(next);
      this.form.controls.name.setValue(customers[next] ?? '');
      this.status.set('');
    });
  }
  async save() {
    const draft = this.form.controls.name.value;
    if (!draft.trim()) {
      document.querySelector<HTMLInputElement>('#name')?.focus();
      return;
    }
    const epoch = this.lifetime;
    const customer = this.id();
    this.status.set('');
    try {
      const name = await saveCustomer(customer, draft);
      if (this.destroyed || epoch !== this.lifetime) return;
      this.form.controls.name.setValue(name);
      this.status.set('saved');
    } catch {
      if (this.destroyed || epoch !== this.lifetime) return;
      this.status.set('error');
    }
  }
  ngOnDestroy() { this.destroyed = true; this.lifetime++; }
}
`;

const SCOPE_CONTROL = `import { ApplicationRef, Component, ComponentRef, EnvironmentInjector, Injector, Input, OnDestroy, OnInit, createComponent, inject } from '@angular/core';
import { FeaturePollerService } from './source';
import { OverlayComponent } from './overlay.component';
@Component({ standalone: true, selector: 'app-feature', providers: [FeaturePollerService], template:
  '<section class="feature" [attr.data-owner]="owner"><h2>Feature {{owner}}</h2><button class="open" (click)="open()">Open overlay</button><button class="close" (click)="close()">Close overlay</button></section>' })
export class FeatureComponent implements OnInit, OnDestroy {
  @Input({ required: true }) owner!: string;
  private readonly service = inject(FeaturePollerService);
  private readonly environment = inject(EnvironmentInjector);
  private readonly elementInjector = inject(Injector);
  private readonly app = inject(ApplicationRef);
  private overlay: ComponentRef<OverlayComponent> | null = null;
  private host: HTMLElement | null = null;
  ngOnInit() { this.service.start(this.owner); }
  open() {
    if (this.overlay) return;
    this.host = document.createElement('aside');
    document.getElementById('overlay-root')!.appendChild(this.host);
    this.overlay = createComponent(OverlayComponent, {
      environmentInjector: this.environment,
      elementInjector: this.elementInjector,
      hostElement: this.host,
    });
    this.app.attachView(this.overlay.hostView);
    this.overlay.setInput('owner', this.owner);
    this.overlay.changeDetectorRef.detectChanges();
  }
  close() {
    if (!this.overlay) return;
    this.app.detachView(this.overlay.hostView);
    this.overlay.destroy();
    this.host?.remove();
    this.overlay = null;
    this.host = null;
  }
  ngOnDestroy() { this.close(); }
}
`;

test.skipIf(ANGULAR_RUNTIME_V5.readinessBlockers.length > 0)(
  'both Angular full-task starters reach real AOT/Chromium checks but fail the behavior gate',
  async () => {
    const pkg = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'angular-engineering',
    )!;
    for (const scenarioId of [
      'angular-engineering-full-task-1-individual',
      'angular-engineering-full-task-2-individual',
    ]) {
      const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((item) => item.id === scenarioId)!;
      const materializer = LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenarioId),
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-angular-starter-'));
      roots.push(root);
      await materializer.materialize(root, scenario);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ scenario: scenarioId, ...score }).toMatchObject({
        scenario: scenarioId,
        passed: false,
        integrityFailure: false,
      });
      expect(score.evidence).toContainEqual(
        expect.stringContaining('Angular AOT and strict template typecheck: pass'),
      );
      const actualDefect =
        scenarioId === 'angular-engineering-full-task-1-individual'
          ? 'route reuse changes entity without leaking draft: fail'
          : 'keyboard overlay shares feature injector and timer: fail';
      expect(score.evidence).toContainEqual(expect.stringContaining(actualDefect));
    }
  },
  160_000,
);

test.skipIf(ANGULAR_RUNTIME_V5.readinessBlockers.length > 0)(
  'Angular AOT/Chromium scorer accepts correct form and injector lifetime repairs',
  async () => {
    const pkg = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'angular-engineering',
    )!;
    for (const [index, candidate] of [FORM_CONTROL, SCOPE_CONTROL].entries()) {
      const scenarioId = 'angular-engineering-full-task-' + (index + 1) + '-individual';
      const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((item) => item.id === scenarioId)!;
      const materializer = LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenarioId),
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-angular-positive-'));
      roots.push(root);
      await materializer.materialize(root, scenario);
      writeFixtureFile(root, 'src/candidate.component.ts', candidate);
      writeFixtureFile(
        root,
        'verification/result.json',
        JSON.stringify({
          status: 'verified',
          angularVersion: ANGULAR_RUNTIME_V5.version,
          broaderSkill: 'frontend-engineering',
          nearNeighbor: index === 0 ? 'react-engineering' : 'svelte-engineering',
          recovery: 'Replaying the real lifecycle in Chromium confirms cleanup and recovery.',
        }),
      );
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ scenario: scenarioId, ...score }).toMatchObject({
        scenario: scenarioId,
        passed: true,
        quality: 1,
        verification: 1,
        integrityFailure: false,
      });
    }
  },
  160_000,
);
