import { apiPath } from './api';
import { Icon } from './icons';
import type { Artifact } from '../shared/types';
import './ConversationFiles.css';

export function ConversationFiles({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return null;
  return <details className="conversation-files">
    <summary aria-label={`Files from this conversation (${artifacts.length})`}>
      <Icon name="chevron" size={14} className="conversation-files-chevron" />
      <span>Files from this conversation</span>
      <span className="conversation-files-count">{artifacts.length}</span>
      <small className="conversation-files-show">Show files</small>
      <small className="conversation-files-hide">Hide files</small>
    </summary>
    <div className="conversation-files-list">{artifacts.map(artifact => <a key={artifact.id} href={apiPath(`/api/artifacts/${encodeURIComponent(artifact.id)}`)} download={artifact.fileName}>
      <Icon name={artifact.mimeType?.startsWith('image/') ? 'image' : 'file'} size={16} />
      <span>{artifact.title || artifact.fileName}<small>{artifact.fileName}</small></span>
      <Icon name="download" size={14} />
    </a>)}</div>
  </details>;
}
