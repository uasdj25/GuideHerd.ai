import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLeads } from '../store/useLeads.js';

const STATUS_LABELS = {
  pending: 'Pending',
  in_review: 'In Review',
  accepted: 'Accepted',
  declined: 'Declined',
  referred: 'Referred Out',
};

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------

function Toast({ msg, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className="toast success">{msg}</div>;
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <button className="btn btn-outline btn-sm" onClick={copy}>
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function ScopeAlert({ inScope, label, referralNote }) {
  if (inScope === true) {
    return (
      <div className="scope-alert in-scope">
        <div className="scope-alert-icon">✅</div>
        <div className="scope-alert-content">
          <h4>In-Scope Matter — {label}</h4>
          <p>This matter appears to fall within the firm's practice areas. Conflicts check and attorney assignment are the recommended next steps.</p>
        </div>
      </div>
    );
  }
  if (inScope === false) {
    return (
      <div className="scope-alert out-of-scope">
        <div className="scope-alert-icon">🚫</div>
        <div className="scope-alert-content">
          <h4>Out-of-Scope — {label}</h4>
          <p>{referralNote || "This matter does not fall within the firm's current practice areas."}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="scope-alert unknown">
      <div className="scope-alert-icon">⚠️</div>
      <div className="scope-alert-content">
        <h4>Needs Manual Review</h4>
        <p>Classification confidence is low. An attorney should review the full description before making a determination.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analysis tab
// ---------------------------------------------------------------------------

function AnalysisTab({ lead }) {
  const { analysis, intake } = lead;
  return (
    <div>
      <ScopeAlert inScope={analysis.inScope} label={analysis.label} referralNote={analysis.referralNote} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">Classification</div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 400, color: 'var(--ink)', marginBottom: 8 }}>
            {analysis.label}
          </div>
          <div className="confidence-bar" style={{ marginBottom: 16 }}>
            <div className="confidence-track" style={{ width: 120 }}>
              <div className="confidence-fill" style={{ width: `${analysis.confidence}%` }} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{analysis.confidence}% confidence</span>
          </div>
          <div className="detail-grid">
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <span className="detail-value">{STATUS_LABELS[lead.status] || lead.status}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Urgency</span>
              <span className="detail-value">{intake.urgency || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Est. Value</span>
              <span className="detail-value">{intake.estimatedDamages || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Prior Attorney</span>
              <span className="detail-value">{intake.priorAttorney || 'None'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Referral Source</span>
              <span className="detail-value">{intake.referralSource || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Submitted</span>
              <span className="detail-value">
                {new Date(lead.submittedAt).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-title">Contact</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="detail-row">
              <span className="detail-label">Full Name</span>
              <span className="detail-value" style={{ fontWeight: 700 }}>
                {intake.firstName} {intake.lastName}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Email</span>
              <span className="detail-value">{intake.email}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Phone</span>
              <span className="detail-value">{intake.phone || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Parties Involved</span>
              <span className="detail-value">{intake.partiesInvolved || '—'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Conflict-Check Names</div>
        <p style={{ fontSize: 13, color: 'var(--ink-80)', marginBottom: 10 }}>
          Extracted for conflict screening. <strong>This list may be incomplete.</strong>{' '}
          Attorney must run full conflict check before any substantive discussion.
        </p>
        <div>
          {(analysis.conflictNames || []).map((name, i) => (
            <span key={i} className="name-chip">{name}</span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">Missing Information</div>
          {(analysis.missingInfo || []).length > 0 ? (
            <ul className="checklist">
              {(analysis.missingInfo || []).map((item, i) => (
                <li key={i}><span className="check-icon">◌</span>{item}</li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 14, color: 'var(--ink-40)' }}>No obvious gaps identified.</p>
          )}
        </div>

        <div className="card">
          <div className="section-title">Risk Flags</div>
          {(analysis.riskFlags || []).length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(analysis.riskFlags || []).map((flag, i) => (
                <div key={i} className="flag-item"><span>⚑</span><span>{flag}</span></div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 14, color: 'var(--ink-40)' }}>No flags identified.</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-title">Client Description (Verbatim)</div>
        <blockquote style={{
          borderLeft: '3px solid var(--warm)', paddingLeft: 14,
          fontStyle: 'italic', color: 'var(--ink-80)',
          fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap',
        }}>
          {intake.matterDescription}
        </blockquote>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drafts tab
// ---------------------------------------------------------------------------

function MarkdownBody({ content }) {
  const lines = content.split('\n');
  const elements = [];
  let i = 0;

  function inl(t) {
    return t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i}>{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i}>{line.slice(3)}</h2>);
    } else if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
      elements.push(<blockquote key={`bq${i}`}>{bq.join(' ')}</blockquote>);
      continue;
    } else if (line.startsWith('|')) {
      const tb = [];
      while (i < lines.length && lines[i].startsWith('|')) { tb.push(lines[i]); i++; }
      const rows = tb.filter(r => !r.match(/^\|\s*[-:]+\s*\|/));
      if (rows.length) {
        const [head, ...body] = rows;
        const hs = head.split('|').filter(c => c.trim()).map(c => c.trim());
        const bs = body.map(r => r.split('|').filter(c => c.trim()).map(c => c.trim()));
        elements.push(
          <table key={`t${i}`}>
            <thead><tr>{hs.map((h, j) => <th key={j} dangerouslySetInnerHTML={{ __html: inl(h) }} />)}</tr></thead>
            <tbody>{bs.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k} dangerouslySetInnerHTML={{ __html: inl(cell) }} />)}</tr>)}</tbody>
          </table>
        );
      }
      continue;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(lines[i].slice(2)); i++;
      }
      elements.push(<ul key={`ul${i}`}>{items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inl(it) }} />)}</ul>);
      continue;
    } else if (/^\d+\./.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\./.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s*/, '')); i++;
      }
      elements.push(<ol key={`ol${i}`}>{items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inl(it) }} />)}</ol>);
      continue;
    } else if (line.startsWith('---')) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--ink-10)', margin: '12px 0' }} />);
    } else if (line.trim()) {
      elements.push(<p key={i} style={{ marginBottom: 6 }} dangerouslySetInnerHTML={{ __html: inl(line) }} />);
    }
    i++;
  }
  return <div className="markdown-body">{elements}</div>;
}

function DraftsTab({ lead }) {
  const [sub, setSub] = useState('email');
  const email = lead.drafts?.acknowledgmentEmail || '';
  const summary = lead.drafts?.attorneySummary || '';

  return (
    <div>
      <div className="draft-warning">
        ⚠️ <strong>These are AI-generated drafts.</strong> All content requires attorney review and
        approval before any communication is sent or action is taken. No email has been or will be
        sent automatically.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`status-btn${sub === 'email' ? ' active-status' : ''}`} onClick={() => setSub('email')}>
          Draft Client Email
        </button>
        <button className={`status-btn${sub === 'summary' ? ' active-status' : ''}`} onClick={() => setSub('summary')}>
          Attorney Summary
        </button>
      </div>

      {sub === 'email' && (
        <div className="card">
          <div className="draft-toolbar">
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Draft Acknowledgment Email</div>
              <div style={{ fontSize: 12, color: 'var(--ink-40)' }}>
                To: {lead.intake.email} — NOT SENT
              </div>
            </div>
            <CopyButton text={email} label="Copy Email" />
          </div>
          <div className="draft-box">{email}</div>
        </div>
      )}

      {sub === 'summary' && (
        <div className="card">
          <div className="draft-toolbar">
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Attorney Summary</div>
              <div style={{ fontSize: 12, color: 'var(--ink-40)' }}>
                Confidential Work Product — Attorney Eyes Only
              </div>
            </div>
            <CopyButton text={summary} label="Copy Markdown" />
          </div>
          <MarkdownBody content={summary} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON tab
// ---------------------------------------------------------------------------

function JsonTab({ lead }) {
  const json = JSON.stringify(lead, null, 2);
  function colorize(text) {
    return text.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*)/g,
      m => {
        if (/^".*":$/.test(m)) return `<span class="json-key">${m}</span>`;
        if (/^"/.test(m)) return `<span class="json-string">${m}</span>`;
        if (/true|false/.test(m)) return `<span class="json-bool">${m}</span>`;
        if (/null/.test(m)) return `<span class="json-null">${m}</span>`;
        return `<span class="json-number">${m}</span>`;
      }
    );
  }
  return (
    <div className="card">
      <div className="draft-toolbar">
        <div>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Lead JSON Output</div>
          <div style={{ fontSize: 12, color: 'var(--ink-40)' }}>{lead.id}.json</div>
        </div>
        <CopyButton text={json} label="Copy JSON" />
      </div>
      <div className="json-box" dangerouslySetInnerHTML={{ __html: colorize(json) }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes tab
// ---------------------------------------------------------------------------

function NotesTab({ lead, onAddNote }) {
  const [note, setNote] = useState('');
  const [attorney, setAttorney] = useState('');
  const [saving, setSaving] = useState(false);

  function add() {
    if (!note.trim()) return;
    setSaving(true);
    onAddNote(note, attorney || 'Attorney');
    setNote('');
    setSaving(false);
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Attorney Notes</div>
        {(lead.notes || []).length === 0 ? (
          <p style={{ color: 'var(--ink-40)', fontSize: 14 }}>No notes yet.</p>
        ) : (
          (lead.notes || []).map(n => (
            <div key={n.id} className="note-item">
              <div className="note-meta">
                {n.attorney} &middot; {new Date(n.createdAt).toLocaleString()}
              </div>
              <div className="note-text">{n.text}</div>
            </div>
          ))
        )}
      </div>
      <div className="card">
        <div className="section-title">Add Note</div>
        <div className="note-form">
          <input
            className="form-input"
            placeholder="Attorney name or initials"
            value={attorney}
            onChange={e => setAttorney(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <textarea
            className="form-textarea"
            placeholder="Enter note…"
            value={note}
            onChange={e => setNote(e.target.value)}
            style={{ minHeight: 80 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={add} disabled={saving || !note.trim()}>
              {saving ? 'Saving…' : 'Add Note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getLead, updateStatus, addNote } = useLeads();
  const [lead, setLead] = useState(() => getLead(id));
  const [activeTab, setActiveTab] = useState('analysis');
  const [toast, setToast] = useState(null);

  // Re-read from store whenever the id changes
  useEffect(() => {
    setLead(getLead(id));
  }, [id, getLead]);

  if (!lead) {
    return (
      <main className="page">
        <button className="back-link btn btn-ghost" onClick={() => navigate('/')}>← Back</button>
        <p>Lead not found.</p>
      </main>
    );
  }

  function handleStatusChange(status) {
    updateStatus(id, status);
    setLead(prev => ({ ...prev, status }));
    setToast(`Status updated to "${STATUS_LABELS[status]}"`);
  }

  function handleAddNote(text, attorney) {
    addNote(id, text, attorney);
    setLead(getLead(id));
  }

  const { intake, analysis } = lead;

  return (
    <main className="page">
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

      <button className="back-link btn btn-ghost" onClick={() => navigate('/')}>
        ← Back to Dashboard
      </button>

      {/* Header card */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 400, letterSpacing: '-0.02em', color: 'var(--ink)' }}>
                {intake.firstName} {intake.lastName}
              </h1>
              {analysis.inScope === false && <span className="badge badge-out-of-scope">Out of Scope</span>}
              {analysis.inScope === true && <span className="badge badge-in-scope">In Scope</span>}
            </div>
            <div style={{ fontSize: 14, color: 'var(--ink-80)' }}>
              {intake.email} &middot; {intake.phone || 'No phone'} &middot; Submitted{' '}
              {new Date(lead.submittedAt).toLocaleDateString()}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 4 }}>
              {analysis.label}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Set Status
            </div>
            <div className="status-selector">
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  className={`status-btn${lead.status === key ? ' active-status' : ''}`}
                  onClick={() => handleStatusChange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {[
          { key: 'analysis', label: 'Analysis' },
          { key: 'drafts', label: 'Drafts' },
          { key: 'json', label: 'JSON Output' },
          {
            key: 'notes',
            label: `Notes${lead.notes?.length ? ` (${lead.notes.length})` : ''}`,
          },
        ].map(tab => (
          <button
            key={tab.key}
            className={`tab-btn${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'analysis' && <AnalysisTab lead={lead} />}
      {activeTab === 'drafts' && <DraftsTab lead={lead} />}
      {activeTab === 'json' && <JsonTab lead={lead} />}
      {activeTab === 'notes' && <NotesTab lead={lead} onAddNote={handleAddNote} />}
    </main>
  );
}
