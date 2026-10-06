import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/Settings';

describe('SettingsStore', () => {
  it('loads profiles saved before the thumb-throttle settings were removed', () => {
    const saved = {
      v: 1,
      control: { steerSensitivity: 1.4, throttleExpo: 0.3 },
      calibration: { maxLockAngle: 1, throttleMinAngle: 0.2, throttleMaxAngle: 1.2, calibratedAt: 5 },
    };
    const store = new SettingsStore({ getItem: () => JSON.stringify(saved), setItem: () => {} });
    expect(store.data.control.steerSensitivity).toBe(1.4);
    expect(store.data.control.deadZoneDeg).toBe(DEFAULT_SETTINGS.control.deadZoneDeg);
    expect(store.data.calibration.maxLockAngle).toBe(1);
    expect(store.data.calibration.calibratedAt).toBe(5);
  });

  it('falls back to defaults when the stored profile is unreadable', () => {
    const store = new SettingsStore({ getItem: () => '{not json', setItem: () => {} });
    expect(store.data).toEqual(DEFAULT_SETTINGS);
  });
});
