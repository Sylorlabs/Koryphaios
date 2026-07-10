import { describe, expect, it } from 'bun:test';
import {
  createPluginRegistry,
  highlightPlugin,
  commentPlugin,
  calloutPlugin,
  externalLinkPlugin,
  BUILTIN_NOTE_PLUGINS,
} from './note-plugins';

describe('plugin registry', () => {
  it('runs markdown transforms in registration order', () => {
    const reg = createPluginRegistry();
    reg.register({ id: 'a', name: 'a', markdownTransform: (s) => s + '-a' });
    reg.register({ id: 'b', name: 'b', markdownTransform: (s) => s + '-b' });
    expect(reg.transformMarkdown('x')).toBe('x-a-b');
  });

  it('runs html post-processors', () => {
    const reg = createPluginRegistry();
    reg.register({ id: 'c', name: 'c', htmlPostProcess: (h) => h.toUpperCase() });
    expect(reg.postProcessHtml('<p>hi</p>')).toBe('<P>HI</P>');
  });

  it('isolates a throwing plugin (does not break the pipeline)', () => {
    const reg = createPluginRegistry();
    reg.register({ id: 'boom', name: 'boom', markdownTransform: () => { throw new Error('nope'); } });
    reg.register({ id: 'ok', name: 'ok', markdownTransform: (s) => s + '!' });
    expect(reg.transformMarkdown('x')).toBe('x!');
  });

  it('collects commands from all plugins', () => {
    const reg = createPluginRegistry();
    reg.register({ id: 'd', name: 'd', commands: [{ id: 'd.hi', name: 'Say hi', run: () => 'hi' }] });
    expect(reg.commands.map((c) => c.id)).toContain('d.hi');
  });

  it('unregisters plugins', () => {
    const reg = createPluginRegistry([highlightPlugin]);
    expect(reg.list()).toHaveLength(1);
    reg.unregister(highlightPlugin.id);
    expect(reg.list()).toHaveLength(0);
  });

  it('loads a user plugin from source', () => {
    const reg = createPluginRegistry();
    const id = reg.loadUserPlugin(`function(){ return { id: 'user.up', name: 'Upper', markdownTransform: s => s.toUpperCase() }; }`);
    expect(id).toBe('user.up');
    expect(reg.transformMarkdown('hi')).toBe('HI');
  });
});

describe('built-in plugins', () => {
  it('highlight: ==x== becomes <mark>', () => {
    expect(highlightPlugin.markdownTransform!('a ==bold== b')).toContain('<mark>bold</mark>');
    // Does not touch === horizontal rules / setext
    expect(highlightPlugin.markdownTransform!('===')).toBe('===');
  });

  it('comments: %%...%% is stripped', () => {
    expect(commentPlugin.markdownTransform!('keep %%drop this%% end')).toBe('keep  end');
    expect(commentPlugin.markdownTransform!('a %%multi\nline%% b')).toBe('a  b');
  });

  it('callouts: > [!note] Title becomes a styled block', () => {
    const out = calloutPlugin.markdownTransform!('> [!warning] Heads up\n> be careful');
    expect(out).toContain('callout callout-warning');
    expect(out).toContain('Heads up');
    expect(out).toContain('be careful');
  });

  it('external links: adds target/rel to http links', () => {
    const out = externalLinkPlugin.htmlPostProcess!('<a href="https://x.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer"');
    // internal wikilinks untouched
    expect(externalLinkPlugin.htmlPostProcess!('<a class="wikilink" data-note-title="A">A</a>')).not.toContain('target=');
  });

  it('ships the expected built-ins', () => {
    expect(BUILTIN_NOTE_PLUGINS.map((p) => p.id)).toEqual([
      'builtin.highlight',
      'builtin.comments',
      'builtin.callouts',
      'builtin.external-links',
    ]);
  });
});
