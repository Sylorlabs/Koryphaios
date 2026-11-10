import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  invite: vi.fn(),
  stopInvite: vi.fn(async () => {}),
  configureRelay: vi.fn(async () => {}),
  configureAccountWideDeviceAccess: vi.fn(async () => {}),
  pair: vi.fn(),
  copyText: vi.fn(async () => {}),
  toDataURL: vi.fn(async () => 'data:image/png;base64,cXI='),
  status: {
    local: { id: 'desktop', name: 'My Mac', os: 'macOS' },
    osName: 'My Mac',
    relayUrl: 'https://relay.example.com',
    accountWideDeviceAccess: true,
    connected: true,
    error: null,
    peers: [],
    requests: [],
  },
}));
vi.mock('$lib/stores/devices.svelte', () => ({ deviceStore: mocks }));
vi.mock('$lib/utils/clipboard', () => ({ copyText: mocks.copyText }));
vi.mock('qrcode', () => ({ toDataURL: mocks.toDataURL }));
import LinkDevicePanel from './LinkDevicePanel.svelte';
import { createDevicePairingLink } from '@koryphaios/shared/src/device-pairing-link';

const appPairingLink = createDevicePairingLink({
  relayUrl: 'https://relay.example.com',
  code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
  hostId: 'a'.repeat(64),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.relayUrl = 'https://relay.example.com';
  mocks.invite.mockResolvedValue({
    code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
    qrUrl: appPairingLink,
    expiresAt: Date.now() + 600_000,
  });
});
afterEach(cleanup);

test('phone QR is optional, encodes this invite and can be hidden or cancelled', async () => {
  render(LinkDevicePanel);
  await fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
  const show = await screen.findByRole('button', { name: 'Generate QR code' });
  expect(mocks.toDataURL).not.toHaveBeenCalled();
  await fireEvent.click(show);
  await screen.findByRole('img', { name: 'Scan to link this desktop to your phone or tablet' });
  expect(mocks.toDataURL).toHaveBeenCalledWith(appPairingLink, {
    width: 248,
    margin: 4,
    errorCorrectionLevel: 'H',
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Copy app pairing link' }));
  expect(mocks.copyText).toHaveBeenCalledWith(appPairingLink);
  await fireEvent.click(screen.getByRole('button', { name: 'Hide QR code' }));
  expect(screen.queryByRole('img')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel pairing' }));
  await waitFor(() => expect(mocks.stopInvite).toHaveBeenCalledOnce());
  await screen.findByRole('button', { name: 'Create pairing code' });
  expect(screen.queryByRole('button', { name: 'Show QR code' })).toBeNull();
});

test('copies invite and verification numbers with visible confirmation without approving a link', async () => {
  mocks.pair.mockResolvedValue({ identity: { id: 'vps', name: 'VPS' }, check: '042 846' });
  render(LinkDevicePanel);
  await fireEvent.click(screen.getByRole('tab', { name: 'Another desktop' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Copy pairing code' }));
  expect(mocks.copyText).toHaveBeenCalledWith('ABCDE-FGHJK-LMNPQ-RSTUV');
  await screen.findByRole('button', { name: 'Copied' });
  await fireEvent.input(screen.getByRole('textbox', { name: 'Device pairing code' }), {
    target: { value: 'ABCDE-FGHJK-LMNPQ-RSTUV' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Copy numbers' }));
  expect(mocks.copyText).toHaveBeenLastCalledWith('042 846');
  expect(screen.getByText(/Confirm that VPS shows these same numbers/)).toBeVisible();
});

test('mobile can generate its invitation and QR in one click', async () => {
  render(LinkDevicePanel);
  await fireEvent.click(screen.getByRole('button', { name: 'Generate QR code' }));
  await screen.findByRole('img', { name: 'Scan to link this desktop to your phone or tablet' });
  expect(mocks.invite).toHaveBeenCalledOnce();
  expect(mocks.toDataURL).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Save QR image' })).toBeVisible();
});

test('loopback relay permits QR generation and offers phone-reachable relay configuration', async () => {
  mocks.status.relayUrl = 'http://127.0.0.1:18080';
  mocks.invite.mockResolvedValue({
    code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
    qrUrl: createDevicePairingLink({
      relayUrl: 'http://127.0.0.1:18080',
      code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
      hostId: 'a'.repeat(64),
    }),
    expiresAt: Date.now() + 600_000,
  });
  render(LinkDevicePanel);
  await fireEvent.click(screen.getByRole('button', { name: 'Generate QR code' }));
  await screen.findByRole('img');
  expect(mocks.toDataURL).toHaveBeenCalledWith(
    expect.stringContaining('koryphaios://link-device?v=1&relay=http%3A%2F%2F127.0.0.1%3A18080'),
    expect.anything(),
  );
  expect(screen.getByText(/A localhost relay only connects on this computer/)).toBeVisible();
  await fireEvent.input(screen.getByRole('textbox', { name: 'Device relay URL' }), {
    target: { value: 'https://relay.example.com' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Connect relay' }));
  await waitFor(() =>
    expect(mocks.configureRelay).toHaveBeenCalledWith('https://relay.example.com'),
  );
  await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
});

test('activated-device access is visible and defaults on independently of agent grants', async () => {
  render(LinkDevicePanel);
  const access = screen.getByRole('switch', { name: 'Access all activated devices' });
  expect(access).toHaveAttribute('aria-checked', 'true');
  await fireEvent.click(access);
  await waitFor(() => expect(mocks.configureAccountWideDeviceAccess).toHaveBeenCalledWith(false));
});
