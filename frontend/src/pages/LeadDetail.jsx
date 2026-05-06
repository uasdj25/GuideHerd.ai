import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

const STATUS_LABELS = {
  pending: 'Pending',
  in_review: 'In Review',
  accepted: 'Accepted',
  declined: 'Declined',
  referred: 'Referred Out'
};

function Toast({ msg, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className={`toast ${type}`}>{msg}</div>;
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
  if (inScope === true) return (
    <div className="scope-alert in-scope">
      <div className="scope-alert-icon">✅</div>
      <div className="scope-alert-content">
        <h4>In-Scope Matter — {label}</h4>
        <p>This matter appears to fall within the firm's practice areas. Conflicts check and attorney assignment are the recommended next steps.</p>
      </div>
    </div>
  );
  if (inScope === false) return (
    <div className="scope-alert out-of-scope">
      <div className="scope-alert-icon">🚫</div>
      <div className="scope-alert-content">
        <h4>Out-of-Scope — {label}</h4>
        <p>{referralNote || 'This matter does not fall within the firm\'s current practice areas.'}</p>
      </div>
    </div>
  );
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

function AnalysisTab({ lead }) {
  const { analysis, intake } = lead;
  return (
    <div>
      <ScopeAlert inScope={analysis.inScope} label={analysis.label} referralNote={analysis.referralNote} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">Classification</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)', marginBottom: 6 }}>{analysis.label}</div>
            <div className="confidence-bar">
              <div className="confidence-track" style={{ width: 120 }}>
                <div className="confidence-fill" style={{ width: `${analysis.confidence}%` }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{analysis.confidence}% confidence</span>
            </div>
          </div>
          <div className="detail-grid" style={{ marginTop: 16 }}>
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
              <span className="detail-value">{new Date(lead.submittedAt).toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-title">Contact</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="detail-row">
              <span className="detail-label">Full Name</span>
              <span className="detail-value" style={{ fontWeight: 700 }}>{intake.firstName} {intake.lastName}</span>
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
        <p style={{ fontSize: 13, color: 'var(--gray-600)', marginBottom: 10 }}>
          Extracted for conflict screening. <strong>This list may be incomplete.</strong> Attorney must run full conflicts check before any substantive discussion.
        </p>
        <div>
          {analysis.conflictNames?.map((name, i) => (
            <span key={i} className="name-chip">{name}</span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">Missing Information</div>
          {analysis.missingInfo?.length > 0 ? (
            <ul className="checklist">
              {analysis.missingInfo.map((item, i) => (
                <li key={i}>
                  <span className="check-icon">◌</span>
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 14, color: 'var(--gray-400)' }}>No obvious gaps identified.</p>
          )}
        </div>

        <div className="card">
          <div className="section-title">Risk Flags</div>
          {analysis.riskFlags?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {analysis.riskFlags.map((flag, i) => (
                <div key={i} className="flag-item">
                  <span>⚑</span>
                  <span>{flag}</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 14, color: 'var(--gray-400)' }}>No flags identified.</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-title">Client Description (Verbatim)</div>
        <blockquote style={{
          borderLeft: '3px solid var(--gold)',
          paddingLeft: 14,
          fontStyle: 'italic',
          color: 'var(--gray-600)',
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap'
        }}>
          {intake.matterDescription}
        </blockquote>
      </div>
    </div>
  );
}

function DraftsTab({ lead }) {
  const [tab, setTab] = useState('email');
  const email = lead.drafts?.acknowledgmentEmail || '';
  const summary = lead.drafts?.attorneySummary || '';

  return (
    <div>
      <div className="draft-warning">
        ⚠️ <strong>These are AI-generated drafts.</strong> All content requires attorney review and approval before any communication is sent or action is taken. No email has been or will be sent automatically.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`status-btn ${tab === 'email' ? 'active-status' : ''}`} onClick={() => setTab('email')}>
          Draft Client Email
        </button>
        <button className={`status-btn ${tab === 'summary' ? 'active-status' : ''}`} onClick={() => setTab('summary')}>
          Attorney Summary
        </button>
      </div>

      {tab === 'email' && (
        <div className="card">
          <div className="draft-toolbar">
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Draft Acknowledgment Email</div>
              <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>To: {lead.intake.email} — NOT SENT</div>
            </div>
            <CopyButton text={email} label="Copy Email" />
          </div>
          <div className="draft-box">{email}</div>
        </div>
      )}

      {tab === 'summary' && (
        <div className="card">
          <div className="draft-toolbar">
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Attorney Summary</div>
              <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>Confidential Work Product — Attorney Eyes Only</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <CopyButton text={summary} label="Copy Markdown" />
            </div>
          </div>
          <MarkdownSummary content={summary} />
        </div>
      )}
    </div>
  );
}

function MarkdownSummary({ content }) {
  const lines = content.split('\n');
  const elements = [];
  let i = 0;
  let tableBuffer = [];

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('# ')) {
      elements.push(<h1 key={i}>{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i}>{line.slice(3)}</h2>);
    } else if (line.startsWith('> ')) {
      const bqLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bqLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(<blockquote key={`bq-${i}`}>{bqLines.join(' ')}</blockquote>);
      continue;
    } else if (line.startsWith('|')) {
      tableBuffer.push(line);
      i++;
      while (i < lines.length && lines[i].startsWith('|')) {
        tableBuffer.push(lines[i]);
        i++;
      }
      elements.push(<TableFromMd key={`t-${i}`} rows={tableBuffer} />);
      tableBuffer = [];
      continue;
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(<li key={i} dangerouslySetInnerHTML={{ __html: mdInline(lines[i].slice(2)) }} />);
        i++;
      }
      elements.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    } else if (line.match(/^\d+\./)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\./)) {
        items.push(<li key={i} dangerouslySetInnerHTML={{ __html: mdInline(lines[i].replace(/^\d+\.\s*/, '')) }} />);
        i++;
      }
      elements.push(<ol key={`ol-${i}`}>{items}</ol>);
      continue;
    } else if (line.startsWith('---')) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--gray-200)', margin: '12px 0' }} />);
    } else if (line.trim()) {
      elements.push(<p key={i} style={{ marginBottom: 6 }} dangerouslySetInnerHTML={{ __html: mdInline(line) }} />);
    }
    i++;
  }

  return <div className="markdown-body">{elements}</div>;
}

function mdInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function TableFromMd({ rows }) {
  const cleaned = rows.filter(r => !r.match(/^\|\s*[-:]+\s*\|/));
  if (cleaned.length === 0) return null;
  const [header, ...body] = cleaned;
  const headers = header.split('|').filter(c => c.trim()).map(c => c.trim());
  const bodyRows = body.map(row => row.split('|').filter(c => c.trim()).map(c => c.trim()));
  return (
    <table>
      <thead>
        <tr>{headers.map((h, i) => <th key={i} dangerouslySetInnerHTML={{ __html: mdInline(h) }} />)}</tr>
      </thead>
      <tbody>
        {bodyRows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j} dangerouslySetInnerHTML={{ __html: mdInline(cell) }} />)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function JsonTab({ lead }) {
  const json = JSON.stringify(lead, null, 2);

  function colorize(json) {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+\.?\d*([eE][+-]?\d+)?)/g,
      match => {
        if (/^".*":$/.test(match)) return `<span class="json-key">${match}</span>`;
        if (/^"/.test(match)) return `<span class="json-string">${match}</span>`;
        if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
        if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
        return `<span class="json-number">${match}</span>`;
      }
    );
  }

  return (
    <div className="card">
      <div className="draft-toolbar">
        <div>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Lead JSON Output</div>
          <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>{lead.id}.json</div>
        </div>
        <CopyButton text={json} label="Copy JSON" />
      </div>
      <div className="json-box" dangerouslySetInnerHTML={{ __html: colorize(json) }} />
    </div>
  );
}

function NotesTab({ lead, onUpdate }) {
  const [note, setNote] = useState('');
  const [attorney, setAttorney] = useState('');
  const [saving, setSaving] = useState(false);

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    await fetch(`/api/leads/${lead.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, attorney: attorney || 'Attorney' })
    });
    setNote('');
    setSaving(false);
    onUpdate();
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Attorney Notes</div>
        {(lead.notes || []).length === 0 ? (
          <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>No notes yet.</p>
        ) : (
          (lead.notes || []).map(n => (
            <div key={n.id} className="note-item">
              <div className="note-meta">{n.attorney} · {new Date(n.createdAt).toLocaleString()}</div>
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
            <button className="btn btn-primary" onClick={addNote} disabled={saving || !note.trim()}>
              {saving ? 'Saving…' : 'Add Note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('analysis');
  const [toast, setToast] = useState(null);

  const fetchLead = useCallback(() => {
    fetch(`/api/leads/${id}`)
      .then(r => r.json())
      .then(data => { setLead(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchLead(); }, [fetchLead]);

  async function updateStatus(status) {
    await fetch(`/api/leads/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    setLead(l => ({ ...l, status }));
    setToast({ msg: `Status updated to "${STATUS_LABELS[status]}"`, type: 'success' });
  }

  if (loading) return <main className="page"><p>Loading…</p></main>;
  if (!lead) return <main className="page"><p>Lead not found.</p></main>;

  const { intake, analysis } = lead;

  return (
    <main className="page">
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}

      <button className="back-link btn-ghost btn" onClick={() => navigate('/')}>
        ← Back to Dashboard
      </button>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--navy)' }}>
                {intake.firstName} {intake.lastName}
              </h1>
              {analysis.inScope === false && <span className="badge badge-out-of-scope">Out of Scope</span>}
              {analysis.inScope === true && <span className="badge badge-in-scope">In Scope</span>}
            </div>
            <div style={{ fontSize: 14, color: 'var(--gray-600)' }}>
              {intake.email} · {intake.phone || 'No phone'} · Submitted {new Date(lead.submittedAt).toLocaleDateString()}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--navy)', marginTop: 4 }}>
              {analysis.label}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--gray-400)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Set Status
            </div>
            <div className="status-selector">
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  className={`status-btn ${lead.status === key ? 'active-status' : ''}`}
                  onClick={() => updateStatus(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="tabs">
        {[
          { key: 'analysis', label: 'Analysis' },
          { key: 'drafts', label: 'Drafts' },
          { key: 'json', label: 'JSON Output' },
          { key: 'notes', label: `Notes${lead.notes?.length ? ` (${lead.notes.length})` : ''}` }
        ].map(tab => (
          <button
            key={tab.key}
            className={`tab-btn ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'analysis' && <AnalysisTab lead={lead} />}
      {activeTab === 'drafts' && <DraftsTab lead={lead} />}
      {activeTab === 'json' && <JsonTab lead={lead} />}
      {activeTab === 'notes' && <NotesTab lead={lead} onUpdate={fetchLead} />}
    </main>
  );
}
