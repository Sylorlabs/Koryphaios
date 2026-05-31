import localtunnel from 'localtunnel';

export class TunnelManager {
  private tunnel: localtunnel.Tunnel | null = null;
  private currentPort: number;

  constructor(port: number) {
    this.currentPort = port;
  }

  async startTunnel(): Promise<string> {
    if (this.tunnel) {
      return this.tunnel.url;
    }

    this.tunnel = await localtunnel({ port: this.currentPort });

    this.tunnel.on('close', () => {
      this.tunnel = null;
      console.log('Localtunnel closed');
    });

    return this.tunnel.url;
  }

  stopTunnel() {
    if (this.tunnel) {
      this.tunnel.close();
      this.tunnel = null;
    }
  }

  getUrl(): string | null {
    return this.tunnel ? this.tunnel.url : null;
  }
}

export const tunnelManager = new TunnelManager(Number(process.env.PORT) || 29473);
