import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, hostApi, projectBasePath } from './api';
import { desktopInvoke, hasDesktopBridge } from './desktop';
import type { AppNotification, NotificationSettings } from '../shared/notifications';

type Permission = NotificationPermission | 'unsupported';
type NotificationTarget = Pick<AppNotification, 'projectId' | 'sessionId'> & { notificationId?: string };
// A standalone application has no workspace host; keep its notification API usable.
const notificationApi = <T,>(path: string, body?: unknown) => projectBasePath ? hostApi<T>(path, body) : api<T>(path, body);

async function systemPermission(request = false): Promise<Permission> {
  if (hasDesktopBridge()) return desktopInvoke<NotificationPermission>(request ? 'request_notification_permission' : 'notification_permission');
  if (typeof Notification === 'undefined') return 'unsupported';
  return request ? Notification.requestPermission() : Notification.permission;
}

export function useNotifications(onOpen: (notification: Pick<AppNotification, 'projectId' | 'sessionId'>) => Promise<void>) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [settings, setSettings] = useState<NotificationSettings>({ systemEnabled: false });
  const [permission, setPermission] = useState<Permission>('default');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [systemError, setSystemError] = useState('');
  const [saving, setSaving] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const enabledRef = useRef(false);
  const enabledAfter = useRef(0);
  const settingsUpdating = useRef(false);
  const settingsVersion = useRef(0);
  const openSystemRef = useRef<(target: NotificationTarget) => Promise<void>>(async () => {});
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const readOverrides = useRef(new Set<string>());
  const seen = useRef<Set<string>>();
  const delivered = useRef(new Set<Notification>());

  const deliver = useCallback(async (item: AppNotification) => {
    // Keep the feed useful without interrupting the conversation in focus.
    if (!enabledRef.current || Date.parse(item.createdAt) < enabledAfter.current || (document.visibilityState === 'visible' && document.hasFocus())) return;
    const claim = async () => {
      let previous: string[] = [];
      try {
        const stored = JSON.parse(localStorage.getItem('canvagent:system-notifications') ?? '[]');
        if (Array.isArray(stored)) previous = stored.filter(value => typeof value === 'string').slice(0, 200);
      } catch { /* Optional cross-tab deduplication. */ }
      if (previous.includes(item.id)) return;
      if (await systemPermission() !== 'granted' || !enabledRef.current) return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      try { localStorage.setItem('canvagent:system-notifications', JSON.stringify([item.id, ...previous].slice(0, 200))); } catch { /* The in-memory seen set also prevents repeat delivery. */ }
      const body = `${item.projectName} · ${item.sessionTitle}\n${item.body}`;
      if (hasDesktopBridge()) {
        await desktopInvoke('send_notification', { title: item.title, body, projectId: item.projectId, sessionId: item.sessionId, notificationId: item.id });
      } else {
        const notification = new Notification(item.title, { body, tag: item.id });
        delivered.current.add(notification);
        notification.onclick = () => {
          window.focus();
          notification.close();
          delivered.current.delete(notification);
          void openSystemRef.current({ ...item, notificationId: item.id });
        };
        notification.onclose = () => delivered.current.delete(notification);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request('canvagent:system-notifications', claim);
      else await claim();
    } catch { setSystemError('A system alert could not be delivered. Your notifications are still saved here.'); }
  }, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      const version = settingsVersion.current;
      try {
        const [feed, preferences] = await Promise.all([
          notificationApi<{ notifications: AppNotification[] }>('/api/notifications'),
          notificationApi<NotificationSettings>('/api/notification-settings'),
        ]);
        if (disposed) return;
        if (!settingsUpdating.current && version === settingsVersion.current) {
          enabledRef.current = preferences.systemEnabled;
          setSettings(preferences);
        }
        setItems(feed.notifications.map(item => readOverrides.current.has(item.id) && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item));
        setError('');
        setLoaded(true);
        const previous = seen.current;
        seen.current = new Set(feed.notifications.map(item => item.id));
        // The first snapshot is history. Never replay old alerts on launch.
        if (previous) for (const item of [...feed.notifications].reverse()) {
          if (!previous.has(item.id) && !item.readAt && !readOverrides.current.has(item.id)) void deliver(item);
        }
      } catch (failure) { if (!disposed) setError(errorMessage(failure)); }
      finally { inFlight = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const focus = () => {
      void refresh();
      void systemPermission().then(value => { if (!disposed) setPermission(value); }).catch(() => {});
    };
    window.addEventListener('focus', focus);
    void systemPermission().then(value => { if (!disposed) setPermission(value); }).catch(() => {});
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [deliver]);

  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (target && typeof target.projectId === 'string' && typeof target.sessionId === 'string') void openSystemRef.current(target);
    };
    window.addEventListener('canvagent:open-notification', open);
    return () => {
      window.removeEventListener('canvagent:open-notification', open);
      for (const notification of delivered.current) notification.close();
      delivered.current.clear();
    };
  }, []);

  const markRead = useCallback(async (ids: string[]) => {
    if (!ids.length) return true;
    setMarkingRead(true);
    try {
      await notificationApi('/api/notifications/read', { ids });
      for (const id of ids) readOverrides.current.add(id);
      setItems(previous => previous.map(item => ids.includes(item.id) ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item));
      setError('');
      return true;
    } catch (failure) { setError(errorMessage(failure)); return false; }
    finally { setMarkingRead(false); }
  }, []);

  openSystemRef.current = async target => {
    if (typeof target.notificationId === 'string') await markRead([target.notificationId]);
    await openRef.current(target);
  };

  const toggleSystem = async () => {
    if (settingsUpdating.current) return;
    settingsUpdating.current = true;
    settingsVersion.current++;
    setSaving(true);
    setSystemError('');
    try {
      const enable = !settings.systemEnabled;
      if (enable) {
        const result = await systemPermission(true);
        setPermission(result);
        if (result !== 'granted') return;
      }
      const updated = await notificationApi<NotificationSettings>('/api/notification-settings', { systemEnabled: enable });
      settingsVersion.current++;
      if (updated.systemEnabled) enabledAfter.current = Date.now();
      enabledRef.current = updated.systemEnabled;
      setSettings(updated);
    } catch (failure) { setSystemError(errorMessage(failure)); }
    finally { settingsUpdating.current = false; setSaving(false); }
  };

  return {
    items, loaded, error, systemError, permission, settings, saving, markingRead,
    unreadCount: items.filter(item => !item.readAt).length,
    refresh: () => refreshRef.current(),
    markAllRead: () => markRead(items.filter(item => !item.readAt).map(item => item.id)),
    toggleSystem,
    open: async (item: AppNotification) => { if (!item.readAt) await markRead([item.id]); await openRef.current(item); },
  };
}

export type NotificationsController = ReturnType<typeof useNotifications>;
