import React, { useState } from 'react';
import { API_URL } from '../config';

interface Lead {
  id: string;
  website: string;
  manual_email?: string;
  fetched_emails: string[];
  domain_active: boolean;
  status: string;
}

interface OutreachComposerProps {
  lead: Lead;
  userId: string;
  onClose: () => void;
  onSent: () => void;
}

export const OutreachComposer: React.FC<OutreachComposerProps> = ({ lead, userId, onClose, onSent }) => {
  const [recipient, setRecipient] = useState(() => {
    // Prefer manual email first, then first fetched email
    if (lead.manual_email) return lead.manual_email;
    if (lead.fetched_emails && lead.fetched_emails.length > 0) return lead.fetched_emails[0];
    return '';
  });

  const [service, setService] = useState<'smtp' | 'gmail'>('smtp');
  const [subject, setSubject] = useState(`Outreach Partnership Proposal — ${lead.website}`);
  const [body, setBody] = useState(
    `<p>Hello,</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>${lead.website}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>`
  );

  // Custom Gmail config fields (if service is 'gmail')
  const [gmailUser, setGmailUser] = useState('');
  const [gmailPass, setGmailPass] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipient) {
      setError('Please provide a recipient email address.');
      return;
    }
    if (!subject || !body) {
      setError('Subject and body content cannot be empty.');
      return;
    }

    if (service === 'gmail') {
      if (!gmailUser || !gmailPass) {
        setError('Please enter your Gmail address and App Password.');
        return;
      }
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/leads/${lead.id}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientEmail: recipient,
          subject,
          body,
          service,
          gmailConfig: service === 'gmail' ? { user: gmailUser, pass: gmailPass } : undefined,
          userId
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to dispatch email.');
      }

      setSuccess(true);
      setTimeout(() => {
        onSent();
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Connection error. Could not reach server.');
    } finally {
      setLoading(false);
    }
  };

  const emailOptions = [
    ...(lead.manual_email ? [lead.manual_email] : []),
    ...(lead.fetched_emails || [])
  ];
  // Remove duplicates
  const uniqueEmailOptions = Array.from(new Set(emailOptions));

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel animate-fade">
        <div className="modal-header">
          <h2 className="card-title" style={{ margin: 0 }}>Outreach Composer: {lead.website}</h2>
          <button className="close-btn" onClick={onClose} disabled={loading}>&times;</button>
        </div>

        {error && (
          <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}

        {success && (
          <div style={{ background: 'var(--success-glow)', color: '#34d399', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem', textAlign: 'center' }}>
            🚀 Email Dispatched Successfully!
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Delivery Service</label>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="email-service"
                  checked={service === 'smtp'}
                  onChange={() => setService('smtp')}
                  disabled={loading}
                />
                Autopilot (SMTP/Mailgun Settings)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="email-service"
                  checked={service === 'gmail'}
                  onChange={() => setService('gmail')}
                  disabled={loading}
                />
                Gmail (Direct SMTP Relay)
              </label>
            </div>
          </div>

          {service === 'gmail' && (
            <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.25rem', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>Gmail Account</label>
                  <input
                    type="email"
                    className="form-control"
                    placeholder="user@gmail.com"
                    value={gmailUser}
                    onChange={(e) => setGmailUser(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" style={{ fontSize: '0.75rem' }}>App Password</label>
                  <input
                    type="password"
                    className="form-control"
                    placeholder="xxxx xxxx xxxx xxxx"
                    value={gmailPass}
                    onChange={(e) => setGmailPass(e.target.value)}
                    disabled={loading}
                  />
                </div>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.5rem', display: 'block' }}>
                *Requires a Gmail Google App Password generated in security settings.
              </span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Recipient Email</label>
            {uniqueEmailOptions.length > 0 ? (
              <select
                className="form-control"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                disabled={loading}
              >
                {uniqueEmailOptions.map((mail) => (
                  <option key={mail} value={mail}>{mail}</option>
                ))}
                <option value="">-- Manual Entry --</option>
              </select>
            ) : null}

            {(uniqueEmailOptions.length === 0 || recipient === '') && (
              <input
                type="email"
                className="form-control"
                style={{ marginTop: uniqueEmailOptions.length > 0 ? '0.5rem' : '0' }}
                placeholder="Enter email address manually"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                disabled={loading}
              />
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Subject</label>
            <input
              type="text"
              className="form-control"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Body (HTML allowed)</label>
            <textarea
              className="form-control"
              style={{ minHeight: '160px', resize: 'vertical' }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={loading}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Sending outreach...' : 'Send Outreach'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
