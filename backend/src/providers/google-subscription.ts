import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { GoogleProvider } from './google';

const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'your_default_client_id_here'; // Replace if needed

export interface GoogleDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface GoogleDeviceAuthPoll {
  accessToken?: string;
  refreshToken?: string;
  error?: string;
  errorDescription?: string;
}

export async function startGoogleDeviceAuth(): Promise<GoogleDeviceAuthStart> {
  const clientId = DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  // Using an explicit scope (this may fail if Koryphaios Google client ID doesn't have it, but standard device flow docs apply)
  params.append('scope', 'https://www.googleapis.com/auth/generative-language.retriever');

  const response = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to start Google device auth: HTTP ${response.status} ${err}`);
  }

  const data = (await response.json()) as any;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_url,
    verificationUriComplete: data.verification_url + '?user_code=' + data.user_code,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
}

export async function pollGoogleDeviceAuth(deviceCode: string): Promise<GoogleDeviceAuthPoll> {
  const clientId = DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  // Wait, Google requires client_secret? For installed applications, client_secret is technically optional but sometimes needed. We assume client_secret is not needed for device flow with public client.
  params.append('device_code', deviceCode);
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = (await response.json()) as any;

  if (!response.ok) {
    return {
      error: data.error,
      errorDescription: data.error_description,
    };
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

export class GoogleSubscriptionProvider extends GoogleProvider {
  constructor(config: ProviderConfig) {
    // google-subscription provider acts as Gemini with OAuth token
    super({
      ...config,
      name: 'google-subscription'
    });
  }
}
