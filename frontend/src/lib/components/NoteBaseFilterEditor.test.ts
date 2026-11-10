import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import NoteBaseFilterEditor from './NoteBaseFilterEditor.svelte';
import type { NoteBaseFilter } from '@koryphaios/shared';
afterEach(cleanup);
const fields = [
  { value: 'system:title', label: 'Title' },
  { value: 'property:priority:number', label: 'Priority' },
];
it('preserves the original predicate when adding a second condition', async () => {
  const filter: NoteBaseFilter = {
    kind: 'predicate',
    field: { source: 'system', field: 'title' },
    operator: 'contains',
    value: 'evidence',
  };
  const onChange = vi.fn();
  render(NoteBaseFilterEditor, { filter, fields, onChange });
  await fireEvent.click(screen.getByRole('button', { name: 'Add another condition' }));
  expect(onChange).toHaveBeenCalledWith({
    kind: 'group',
    operator: 'and',
    filters: [filter, expect.objectContaining({ kind: 'predicate' })],
  });
});
it('edits a compound group without replacing its other branches', async () => {
  const first: NoteBaseFilter = {
    kind: 'predicate',
    field: { source: 'system', field: 'title' },
    operator: 'contains',
    value: 'keep',
  };
  const second: NoteBaseFilter = {
    kind: 'predicate',
    field: { source: 'property', key: 'priority', type: 'number' },
    operator: 'gte',
    value: 3,
  };
  const onChange = vi.fn();
  render(NoteBaseFilterEditor, {
    filter: { kind: 'group', operator: 'or', filters: [first, second] },
    fields,
    onChange,
  });
  await fireEvent.input(screen.getAllByRole('textbox', { name: 'Filter value' })[1]!, {
    target: { value: '9' },
  });
  expect(onChange).toHaveBeenCalledWith({
    kind: 'group',
    operator: 'or',
    filters: [first, { ...second, value: 9 }],
  });
  expect(document.querySelector('select,input[type=checkbox],input[type=number]')).toBeNull();
});
