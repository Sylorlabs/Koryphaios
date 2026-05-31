import { nanoid } from 'nanoid';
import { serverLog } from '../logger';

export class HostJoinManager {
  private joinCode: string;
  private hostSecret: string;

  constructor() {
    this.joinCode = nanoid(8).toUpperCase();
    this.hostSecret = nanoid(32);
    serverLog.info({ joinCode: this.joinCode }, 'Host/Join manager initialized');
  }

  getJoinCode() {
    return this.joinCode;
  }

  getHostSecret() {
    return this.hostSecret;
  }

  rotateJoinCode() {
    this.joinCode = nanoid(8).toUpperCase();
    serverLog.info({ joinCode: this.joinCode }, 'Join code rotated');
    return this.joinCode;
  }

  verifyJoinCode(code: string) {
    return code === this.joinCode;
  }

  verifyHostSecret(secret: string) {
    return secret === this.hostSecret;
  }
}

export const hostJoinManager = new HostJoinManager();
