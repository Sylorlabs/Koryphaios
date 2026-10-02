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
const fixtures = createConceptFixtures(LIFECYCLE_CONCEPTS);
export const LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS = fixtures.materializers;
export const LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS = fixtures.scorers;
