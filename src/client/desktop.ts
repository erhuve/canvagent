type DesktopCommand = 'choose_workspace' | 'quit_application' | 'remember_workspace' | 'browser_open' | 'browser_bounds' | 'browser_hide' | 'browser_close' | 'browser_action' | 'browser_state' | 'browser_annotate' | 'notification_permission' | 'request_notification_permission' | 'send_notification' | 'focus_application';

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

export function hasDesktopBridge() { return !!window.__TAURI__?.core; }
export async function desktopInvoke<T = unknown>(command: DesktopCommand, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI__) throw new Error('This control is available in the desktop app.');
  return window.__TAURI__.core.invoke<T>(command, args);
}
