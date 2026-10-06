import { X } from 'lucide-react';
import type { Decision } from '../types/decision';

/** Short, human title: first user phrase, else the stored title. */
export function historyTitle(d: Decision): string {
  const conv: any = (d.modelSuggestions as any)?.conversation;
  const first = Array.isArray(conv) ? conv.find((m: any) => m?.role === 'user')?.content : '';
  const t = String(first || d.brief?.decision || d.title || '').trim();
  return t ? (t.length > 70 ? t.slice(0, 70) + '…' : t) : 'Untitled conversation';
}

/** A dialog is worth listing once the user has written something. */
export function isStarted(d: Decision): boolean {
  const conv: any = (d.modelSuggestions as any)?.conversation;
  return Boolean((Array.isArray(conv) && conv.length) || d.brief?.decision?.trim());
}

export function HistoryPanel(props: {
  items: Decision[];
  activeId: string;
  isOnDrive: (d: Decision) => boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const list = props.items.filter(isStarted).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div role="dialog" aria-label="History" onClick={props.onClose}
      style={{ position: 'fixed', inset: 0, background: '#000a', zIndex: 50, display: 'grid', placeItems: 'start center', padding: '56px 12px 12px', overflow: 'auto' }}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, maxHeight: '80vh', overflow: 'auto', margin: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>History</h2>
          <button className="ghost" aria-label="Close history" onClick={props.onClose} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><X size={16} /></button>
        </div>
        {list.length === 0 ? (
          <div className="empty-inline"><p>No saved conversations yet. Your conversations will appear here.</p></div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {list.map((d) => {
              const current = d.id === props.activeId;
              return (
                <button key={d.id} className="ghost" onClick={() => props.onSelect(d.id)} aria-current={current ? 'true' : undefined}
                  style={{ display: 'block', textAlign: 'left', minHeight: 44, width: '100%', borderColor: current ? '#52a0ff' : undefined, background: current ? '#12304f' : undefined }}>
                  <div style={{ fontSize: 14, color: '#e8edf5' }}>{historyTitle(d)}</div>
                  <div style={{ fontSize: 12, color: '#8ea2b8', marginTop: 4 }}>
                    {new Date(d.createdAt).toLocaleString()} · {props.isOnDrive(d) ? 'On Drive' : 'Only here'}{current ? ' · Open now' : ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
