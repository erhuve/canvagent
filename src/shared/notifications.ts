export const APP_NOTIFICATION_LIMIT = 100;

export interface AppNotification {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  kind: 'completed' | 'approval' | 'failed';
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
}

export interface NotificationSettings {
  systemEnabled: boolean;
}
