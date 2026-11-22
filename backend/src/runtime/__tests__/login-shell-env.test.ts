import { describe, expect, it } from 'bun:test';
import { parseMarkedEnv } from '../login-shell-env';

const BEGIN = '__KORY_ENV_BEGIN_7C1E__';
const END = '__KORY_ENV_END_7C1E__';

function envBlob(entries: Array<[string, string]>): string {
  return `${entries.map(([name, value]) => `${name}=${value}`).join('\0')}\0`;
}

describe('parseMarkedEnv', () => {
  it('extracts allowlisted pairs despite rc noise around the markers', () => {
    const stdout = `rc banner\r\n${BEGIN}${envBlob([
      ['OPENAI_API_KEY', 'sk-test'],
      ['UNRELATED_VAR', 'noise'],
      ['ANTHROPIC_API_KEY', 'sk-ant'],
    ])}${END}\ntrailing noise\n`;
    const parsed = parseMarkedEnv(stdout, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']));
    expect(parsed).toEqual({
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });

  it('returns an empty object when either marker is missing', () => {
    const allowlist = new Set(['OPENAI_API_KEY']);
    expect(parseMarkedEnv('no markers at all', allowlist)).toEqual({});
    expect(parseMarkedEnv(`${BEGIN}OPENAI_API_KEY=sk\0`, allowlist)).toEqual({});
    expect(parseMarkedEnv(`${END}OPENAI_API_KEY=sk\0`, allowlist)).toEqual({});
    expect(parseMarkedEnv(`${BEGIN}${END}`, allowlist)).toEqual({});
  });

  it('rejects values containing line breaks', () => {
    const stdout = `${BEGIN}${envBlob([
      ['OPENAI_API_KEY', 'sk-good'],
      ['ANTHROPIC_API_KEY', 'sk-bad\ninjected=1'],
      ['XAI_API_KEY', 'sk-bad\rmore'],
    ])}${END}`;
    const parsed = parseMarkedEnv(
      stdout,
      new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY']),
    );
    expect(parsed).toEqual({ OPENAI_API_KEY: 'sk-good' });
  });

  it('drops empty values and entries outside the allowlist', () => {
    const stdout = `${BEGIN}${envBlob([
      ['OPENAI_API_KEY', ''],
      ['ANTHROPIC_API_KEY', 'sk-ant'],
    ])}${END}`;
    expect(parseMarkedEnv(stdout, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']))).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant',
    });
    expect(parseMarkedEnv(stdout, new Set(['OPENAI_API_KEY']))).toEqual({});
  });
});
