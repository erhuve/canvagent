import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { AppNotification } from '../shared/notifications';
import type { NotificationsController } from './useNotifications';
import './Notifications.css';

const timestamp = (createdAt: string) => new Date(createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Notifications({ controller, onOpen, disabled }: { controller: NotificationsController; onOpen: (item: AppNotification) => Promise<void>; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [opening, setOpening] = useState(false);
  const { items, unreadCount } = controller;
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  useEffect(() => {
    const close = () => dialog.current?.close();
    window.addEventListener('canvagent:show-conversation', close);
    return () => window.removeEventListener('canvagent:show-conversation', close);
  }, []);
  const open = async (item: AppNotification) => {
    if (opening || disabled) return;
    setOpening(true);
    dialog.current?.close();
    try { await onOpen(item); }
    finally { setOpening(false); }
  };
  return <>
    <button className={`icon-button notification-trigger ${unreadCount ? 'has-unread' : ''}`} aria-label="Notifications" aria-haspopup="dialog" title={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'} onClick={() => { setExpanded(true); void controller.refresh(); }}>
      <Icon name="bell" size={18} />
      {unreadCount > 0 && <span className="notification-count" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
    </button>
    <dialog ref={dialog} className="notifications-dialog" aria-labelledby="notifications-title" onClose={() => setExpanded(false)} onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      {expanded && <>
      <div className="notifications-heading"><span className="notifications-heading-icon"><Icon name="bell" size={18} /></span><h2 id="notifications-title">Notifications</h2><button className="icon-button" aria-label="Close notifications" onClick={() => dialog.current?.close()}><Icon name="close" size={18} /></button></div>
      <div className="notifications-summary"><span>{unreadCount ? `${unreadCount} unread` : 'All up to date'}</span><button disabled={!unreadCount || controller.markingRead} onClick={() => void controller.markAllRead()}><Icon name="check" size={13} />Mark all as read</button></div>
      {controller.error && <div className="notifications-error" role="alert"><span>{controller.error}</span><button onClick={() => void controller.refresh()}>Retry</button></div>}
      <div className="notifications-list">
        {!controller.loaded && !controller.error && <div className="notifications-empty" role="status"><span className="working-spinner" /><p>Loading notifications…</p></div>}
        {controller.loaded && !items.length && <div className="notifications-empty"><span><Icon name="check" size={23} /></span><h3>You’re all caught up</h3><p>Completed turns, requests for your input,<br />and failures will appear here for every project.</p></div>}
        {!!items.length && <ul>{items.map(item => <li key={item.id} className={`notification-item ${item.readAt ? '' : 'unread'}`}>
          <button aria-label={`Open notification: ${item.title} — ${item.sessionTitle}`} disabled={disabled || opening} onClick={() => void open(item)}>
            <span className={`notification-kind ${item.kind}`}><Icon name={item.kind === 'completed' ? 'check' : item.kind === 'approval' ? 'chat' : 'warning'} size={17} /></span>
            <span className="notification-content"><span className="notification-item-heading"><strong>{item.title}</strong>{!item.readAt && <span className="notification-unread-dot" aria-label="Unread" />}</span><span className="notification-context">{item.projectName} <span>·</span> {item.sessionTitle}</span><span className="notification-body">{item.body}</span><time dateTime={item.createdAt}>{timestamp(item.createdAt)}</time></span>
            <Icon className="notification-open-arrow" name="arrow-right" size={15} />
          </button>
        </li>)}</ul>}
      </div>
      <div className="notification-preferences"><div><strong>System notifications</strong><p>Get an alert when you’re away from Canvagent.</p></div><button className="notification-switch" role="switch" aria-label="System notifications" title={controller.settings.systemEnabled ? 'Disable system notifications' : 'Enable system notifications'} aria-checked={controller.settings.systemEnabled} disabled={controller.saving || !controller.loaded || controller.permission === 'unsupported'} onClick={() => void controller.toggleSystem()}><span /></button>
        {controller.permission === 'denied' && <p className="notification-permission-note" role="status">Notifications are blocked. Allow Canvagent in your browser or system notification settings.</p>}
        {controller.permission === 'unsupported' && <p className="notification-permission-note">This browser does not support system notifications. Your notifications will appear here.</p>}
        {controller.systemError && <p className="notification-permission-note" role="alert">{controller.systemError}</p>}
      </div>
      </>}
    </dialog>
  </>;
}
