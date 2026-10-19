type DesktopCommand = 'choose_workspace' | 'quit_application';

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T = unknown>(command: string): Promise<T> } };
  }
}

export function hasDesktopBridge() { return !!window.__TAURI__?.core; }
export async function desktopInvoke(command: DesktopCommand) {
  if (!window.__TAURI__) throw new Error('This control is available in the desktop app.');
  return window.__TAURI__.core.invoke(command);
}
