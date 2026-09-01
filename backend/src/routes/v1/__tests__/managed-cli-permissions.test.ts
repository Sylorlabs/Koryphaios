import { describe, expect, test } from 'bun:test';
import { managedNativeToolDecision } from '../mcp-bridge';

describe('managed CLI native tool boundary', () => {
  test('redirects native host capabilities to Kory MCP regardless of preset', () => {
    expect(managedNativeToolDecision('Bash')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__bash',
    });
    expect(managedNativeToolDecision('Write')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__write_file',
    });
  });

  test('fails closed for unknown native capabilities', () => {
    expect(managedNativeToolDecision('mystery_host_tool').decision).toBe('block');
  });

  test('allows only provider-local bookkeeping and internal generation without host authority', () => {
    expect(managedNativeToolDecision('manage_task').decision).toBe('approve');
    expect(managedNativeToolDecision('finish').decision).toBe('approve');
    expect(managedNativeToolDecision('generate_image').decision).toBe('approve');
    expect(managedNativeToolDecision('Generate_Image').decision).toBe('approve');
    expect(managedNativeToolDecision('image_gen').decision).toBe('approve');
  });

  test('keeps delegation inside Koryphaios', () => {
    expect(managedNativeToolDecision('Agent')).toMatchObject({
      decision: 'block',
    });
  });
});
