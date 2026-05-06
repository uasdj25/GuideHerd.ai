import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const INITIAL = {
  firstName: '', lastName: '', email: '', phone: '',
  matterDescription: '', partiesInvolved: '', estimatedDamages: '',
  priorAttorney: '', urgency: '', referralSource: ''
};

export default function IntakeForm() {
  const [form, setForm] = useState(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Submission failed');
      }
      const lead = await res.json();
      navigate(`/leads/${lead.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: 780 }}>
      <div className="disclaimer-banner">
        ⚠️ <strong>Demo form only.</strong> Submitting this form does not create an attorney-client relationship and does not constitute legal advice. This is a demonstration system with fictional data.
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">New Client Intake</h1>
          <p className="page-subtitle">Hargrove &amp; Associates — Prospective Client Inquiry Form</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="form-section">
            <div className="form-section-title">Contact Information</div>
            <div className="form-row cols-2">
              <div className="form-group">
                <label className="form-label">First Name <span className="required">*</span></label>
                <input className="form-input" value={form.firstName} onChange={set('firstName')} required placeholder="First name" />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name <span className="required">*</span></label>
                <input className="form-input" value={form.lastName} onChange={set('lastName')} required placeholder="Last name" />
              </div>
            </div>
            <div className="form-row cols-2">
              <div className="form-group">
                <label className="form-label">Email Address <span className="required">*</span></label>
                <input className="form-input" type="email" value={form.email} onChange={set('email')} required placeholder="your@email.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Phone Number</label>
                <input className="form-input" type="tel" value={form.phone} onChange={set('phone')} placeholder="(555) 000-0000" />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Matter Description</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Describe Your Legal Matter <span className="required">*</span></label>
                <textarea
                  className="form-textarea"
                  style={{ minHeight: 160 }}
                  value={form.matterDescription}
                  onChange={set('matterDescription')}
                  required
                  placeholder="Please describe the situation in as much detail as possible. Include relevant dates, events, and what outcome you are seeking."
                />
                <span className="form-hint">The more detail you provide, the better we can evaluate your matter.</span>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Other Parties Involved</label>
                <input
                  className="form-input"
                  value={form.partiesInvolved}
                  onChange={set('partiesInvolved')}
                  placeholder="Names of individuals, companies, or entities involved (separate with commas)"
                />
                <span className="form-hint">Used for conflict-of-interest screening purposes.</span>
              </div>
            </div>
            <div className="form-row cols-2">
              <div className="form-group">
                <label className="form-label">Estimated Value / Damages</label>
                <input className="form-input" value={form.estimatedDamages} onChange={set('estimatedDamages')} placeholder="e.g. $50,000 or Unknown" />
              </div>
              <div className="form-group">
                <label className="form-label">Urgency Level</label>
                <select className="form-select" value={form.urgency} onChange={set('urgency')}>
                  <option value="">Select urgency…</option>
                  <option value="Low">Low — no immediate deadlines</option>
                  <option value="Medium">Medium — within the next few weeks</option>
                  <option value="High">High — within the next few days</option>
                  <option value="Emergency">Emergency — immediate action needed</option>
                </select>
              </div>
            </div>
          </div>

          <div className="form-section" style={{ marginBottom: 0 }}>
            <div className="form-section-title">Additional Information</div>
            <div className="form-row cols-2">
              <div className="form-group">
                <label className="form-label">Prior or Current Attorney</label>
                <input className="form-input" value={form.priorAttorney} onChange={set('priorAttorney')} placeholder="Name of attorney, or 'None'" />
                <span className="form-hint">If you have or had an attorney on this matter, please list them.</span>
              </div>
              <div className="form-group">
                <label className="form-label">How Did You Hear About Us?</label>
                <select className="form-select" value={form.referralSource} onChange={set('referralSource')}>
                  <option value="">Select…</option>
                  <option value="Google Search">Google Search</option>
                  <option value="Friend or Family">Friend or Family</option>
                  <option value="Bar Referral">State Bar Referral</option>
                  <option value="Former Client">Former Client</option>
                  <option value="Other Attorney">Other Attorney</option>
                  <option value="Chamber of Commerce referral">Chamber of Commerce</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--amber-bg)', border: '1px solid #f0c060', borderRadius: 'var(--radius)', padding: '12px 16px', margin: '16px 0', fontSize: 13, color: 'var(--amber)' }}>
          <strong>Notice:</strong> Submitting this form does not create an attorney-client relationship. No attorney will be assigned to your matter until a formal engagement agreement is signed. Communications through this form are not privileged until an attorney-client relationship is established. Do not include highly sensitive information in this form.
        </div>

        {error && (
          <div style={{ background: 'var(--red-bg)', border: '1px solid #f5c0c0', borderRadius: 'var(--radius)', padding: '10px 14px', color: 'var(--red)', fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Processing…' : 'Submit Intake →'}
          </button>
        </div>
      </form>
    </main>
  );
}
