/**
 * UserInteractionService
 * Manages user interactions and notifications
 */

import { routingLog } from '../../logger';

export interface UserNotification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

export interface UserPreference {
  key: string;
  value: unknown;
}

export class UserInteractionService {
  private notifications = new Map<string, UserNotification[]>();
  private preferences = new Map<string, Map<string, unknown>>();

  /**
   * Send a notification to a user
   */
  async notify(
    userId: string,
    notification: Omit<UserNotification, 'id' | 'timestamp' | 'read'>,
  ): Promise<void> {
    const notif: UserNotification = {
      ...notification,
      id: this.generateId(),
      timestamp: Date.now(),
      read: false,
    };

    const userNotifications = this.notifications.get(userId) || [];
    userNotifications.push(notif);
    this.notifications.set(userId, userNotifications);

    routingLog.debug({ userId, type: notification.type }, `Notification: ${notification.title}`);
  }

  /**
   * Get unread notifications for a user
   */
  getUnreadNotifications(userId: string): UserNotification[] {
    const notifications = this.notifications.get(userId) || [];
    return notifications.filter((n) => !n.read);
  }

  /**
   * Mark a notification as read
   */
  markAsRead(userId: string, notificationId: string): void {
    const notifications = this.notifications.get(userId) || [];
    const notif = notifications.find((n) => n.id === notificationId);
    if (notif) {
      notif.read = true;
    }
  }

  /**
   * Set a user preference
   */
  setPreference(userId: string, key: string, value: unknown): void {
    let userPrefs = this.preferences.get(userId);
    if (!userPrefs) {
      userPrefs = new Map();
      this.preferences.set(userId, userPrefs);
    }
    userPrefs.set(key, value);
  }

  /**
   * Get a user preference
   */
  getPreference(userId: string, key: string): unknown | undefined {
    return this.preferences.get(userId)?.get(key);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export const userInteractionService = new UserInteractionService();
