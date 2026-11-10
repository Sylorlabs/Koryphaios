import { expect, test } from 'bun:test';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import {
  IOS_SWIFTUI_NATIVE_MATERIALIZERS,
  IOS_SWIFTUI_NATIVE_SCENARIOS,
  IOS_SWIFTUI_NATIVE_SCORERS,
} from '../skill-eval-ios-swiftui-runtime';

test('calibrated SwiftUI scenarios use native evaluators ahead of external gates', () => {
  const { navigation, documents } = IOS_SWIFTUI_NATIVE_SCENARIOS;
  const materializersFor = (id: string) =>
    BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches({ id } as never));
  const scorersFor = (id: string) =>
    BUILTIN_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(id));

  expect(IOS_SWIFTUI_NATIVE_MATERIALIZERS.map((item) => item.id)).toEqual([
    'ios-swiftui/native-navigation-xcuitest-v5@3',
    'ios-swiftui/native-multiwindow-xcuitest-v5@3',
  ]);
  expect(IOS_SWIFTUI_NATIVE_SCORERS.map((item) => item.id)).toEqual([
    'ios-swiftui/native-navigation-scorer-v5@3',
    'ios-swiftui/native-multiwindow-scorer-v5@3',
  ]);
  expect(materializersFor(navigation)[0]?.id).toBe(IOS_SWIFTUI_NATIVE_MATERIALIZERS[0]?.id);
  expect(scorersFor(navigation)[0]?.id).toBe(IOS_SWIFTUI_NATIVE_SCORERS[0]?.id);
  expect(materializersFor(documents)[0]?.id).toBe(IOS_SWIFTUI_NATIVE_MATERIALIZERS[1]?.id);
  expect(scorersFor(documents)[0]?.id).toBe(IOS_SWIFTUI_NATIVE_SCORERS[1]?.id);
  expect(materializersFor(navigation).length).toBeGreaterThan(1);
  expect(scorersFor(navigation).length).toBeGreaterThan(1);
  expect(materializersFor(documents).length).toBeGreaterThan(1);
  expect(scorersFor(documents).length).toBeGreaterThan(1);
  for (const id of [navigation, documents]) {
    expect(materializersFor(id)[0]?.realRuntime).toBe(true);
    expect(materializersFor(id)[0]?.id).not.toContain('external-environment-gate');
    expect(scorersFor(id)[0]?.id).not.toContain('external-environment-gate-scorer');
  }
});
