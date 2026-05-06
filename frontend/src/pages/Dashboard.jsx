import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STATUS_LABELS = {
  pending: 'Pending',
  in_review: 'In Review',
  accepted: 'Accepted',
  declined: 'Declined',
  referred: 'Referred Out'
};

function getInitials(name) {
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

function ScopeBadge({ inScope }) {
  if (inScope === true) return <span className="badge badge-in-scope">✓ In Scope</span>;
  if (inScope === false) return <span className="badge badge-out-of-scope">✗ Out of Scope</span>;
  return <span className="badge badge-unknown">? Needs Review</span>;
}

function StatusBadge({ status }) {
  const cls = {
    pending: 'badge-pending',
    in_review: 'badge-in-review',
    accepted: 'badge-accepted',
    declined: 'badge-declined',
    referred: 'badge-referred'
  }[status] || 'badge-pending';
  return <span className={`badge ${cls}`}>{STATUS_LABELS[status] || status}</span>;
}

function UrgencyBadge({ urgency }) {
  if (!urgency) return null;
  const u = urgency.toLowerCase();
  const cls = { emergency: 'badge-emergency', high: 'badge-high', medium: 'badge-medium', low: 'badge-low' }[u] || 'badge-medium';
  return <span className={`badge ${cls}`}>{urgency}</span>;
}

export default function Dashboard() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/leads')
      .then(r => r.json())
      .then(data => { setLeads(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? leads : leads.filter(l => l.status === filter);

  const stats = {
    total: leads.length,
    pending: leads.filter(l => l.status === 'pending').length,
    inScope: leads.filter(l => l.inScope === true).length,
    flags: leads.reduce((sum, l) => sum + (l.riskFlagCount || 0), 0)
  };

  return (
    <main className="page">
      <div className="disclaimer-banner">
        ⚠️ <span><strong>Demo system.</strong> All data is fictional. This tool does not provide legal advice, conduct conflict checks, or create attorney-client relationships. All AI-generated content requires attorney review before any action.</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">Intake Dashboard</h1>
          <p className="page-subtitle">Review and manage prospective client inquiries</p>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">Total Leads</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--amber)' }}>{stats.pending}</div>
          <div className="stat-label">Pending Review</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--green)' }}>{stats.inScope}</div>
          <div className="stat-label">In-Scope Matters</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--red)' }}>{stats.flags}</div>
          <div className="stat-label">Risk Flags</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', 'pending', 'in_review', 'accepted', 'declined', 'referred'].map(f => (
          <button
            key={f}
            className={`status-btn ${filter === f ? 'active-status' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All Leads' : STATUS_LABELS[f]}
            {f !== 'all' && (
              <span style={{ marginLeft: 4, opacity: 0.7 }}>
                ({leads.filter(l => l.status === f).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading leads…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No leads found</h3>
          <p>Submit a new intake to get started.</p>
        </div>
      ) : (
        <div className="leads-grid">
          {filtered.map(lead => (
            <div key={lead.id} className="lead-card" onClick={() => navigate(`/leads/${lead.id}`)}>
              <div className="lead-card-avatar">{getInitials(lead.clientName)}</div>
              <div className="lead-card-main">
                <div className="lead-card-name">{lead.clientName}</div>
                <div className="lead-card-meta">
                  {lead.email} · {new Date(lead.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                <div className="lead-card-area">{lead.practiceArea}</div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <StatusBadge status={lead.status} />
                  <ScopeBadge inScope={lead.inScope} />
                  <UrgencyBadge urgency={lead.urgency} />
                  {lead.riskFlagCount > 0 && (
                    <span className="lead-card-flags">⚑ {lead.riskFlagCount} flag{lead.riskFlagCount !== 1 ? 's' : ''}</span>
                  )}
                  {lead.missingInfoCount > 0 && (
                    <span style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 600 }}>
                      ◌ {lead.missingInfoCount} missing
                    </span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="confidence-bar" style={{ justifyContent: 'flex-end', marginBottom: 4 }}>
                  <div className="confidence-track">
                    <div className="confidence-fill" style={{ width: `${lead.confidence}%` }} />
                  </div>
                  <span>{lead.confidence}%</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--gray-400)' }}>confidence</div>
              </div>
              <div className="lead-card-arrow">›</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
