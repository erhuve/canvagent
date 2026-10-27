import { createContext, useContext, useState, type ComponentPropsWithoutRef } from 'react';
import { FileContextMenu, type FileMenuState } from './FileActions';
import { errorMessage } from './api';
import { resolveFileLink, type FileLocation } from './fileLinks';
import { Icon } from './icons';

export const MessageLinkContext = createContext<{
  workspace?: string;
  openFile(location: FileLocation): void;
  onError(message: string): void;
}>({ openFile: () => {}, onError: () => {} });

export function MessageLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  const context = useContext(MessageLinkContext);
  const [menu, setMenu] = useState<FileMenuState>();
  const file = resolveFileLink(href ?? '', context.workspace);
  if (!file) return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
  const close = (restoreFocus = false) => { setMenu(undefined); if (restoreFocus) menu?.origin.focus(); };
  return <>
    <a {...props} href={href} title={`Open ${file.path}${file.line ? `:${file.line}` : ''} in Files`} aria-haspopup="menu"
      onClick={event => { event.preventDefault(); context.openFile(file); }}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); context.openFile(file); } }}
      onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, origin: event.currentTarget }); }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom, origin: event.currentTarget });
        }
      }}>{children}</a>
    {menu && <FileContextMenu menu={menu} label={`File link actions: ${file.path}`} onClose={close}>
      <button type="button" role="menuitem" onClick={() => { close(); context.openFile(file); }}><Icon name="file" size={14} /><span>Open file</span></button>
      <button type="button" role="menuitem" onClick={() => {
        close(true);
        void navigator.clipboard.writeText(file.path).catch(error => context.onError(errorMessage(error)));
      }}><Icon name="copy" size={14} /><span>Copy relative path</span></button>
    </FileContextMenu>}
  </>;
}
