import React, { useState } from 'react';
import { API_URL } from '../config';

interface Lead {
  id: string;
  website: string;
  manual_email?: string;
  fetched_emails: string[];
  status: string;
  poc_name?: string;
}

interface OutreachComposerProps {
  lead: Lead;
  userId: string;
  onClose: () => void;
  onSent: () => void;
  drafts?: Array<{ id: string; subject: string; body: string }>;
}

export const OutreachComposer: React.FC<OutreachComposerProps> = ({ lead, userId, onClose, onSent, drafts }) => {
  const safeDrafts = Array.isArray(drafts) ? drafts : [];
  const [tempEmails, setTempEmails] = useState<string[]>([]);
  const [customEmailInput, setCustomEmailInput] = useState('');
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>(() => {
    let emails: string[] = [];
    if (lead.manual_email) {
      emails.push(lead.manual_email);
    }
    if (lead.fetched_emails) {
      if (Array.isArray(lead.fetched_emails)) {
        emails = [...emails, ...lead.fetched_emails];
      } else if (typeof lead.fetched_emails === 'string') {
        try {
          const parsed = JSON.parse(lead.fetched_emails);
          if (Array.isArray(parsed)) {
            emails = [...emails, ...parsed];
          }
        } catch (e) {
          emails.push(lead.fetched_emails);
        }
      }
    }
    // Filter out garbage/sentry/hex-hash tracker emails
    const cleanEmails = emails.filter((email) => {
      const lower = email.toLowerCase().trim();
      if (lower.includes('sentry')) return false;
      const parts = lower.split('@');
      if (parts.length > 0) {
        const localPart = parts[0];
        if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;
      }
      return true;
    });
    return Array.from(new Set(cleanEmails));
  });

  const [subject, setSubject] = useState(`Outreach Partnership Proposal — ${lead.website}`);
  const [body, setBody] = useState(
    `<p>Hello,</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>${lead.website}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>`
  );

  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) {
      setSubject(`Outreach Partnership Proposal — ${lead.website}`);
      setBody(
        `<p>Hello,</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>${lead.website}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>`
      );
      return;
    }
    const selected = safeDrafts.find((d) => d.id === templateId);
    if (selected) {
      const pocName = lead.poc_name || 'Team';
      const replacedSubject = selected.subject
        .replace(/\{\{website\}\}/g, lead.website)
        .replace(/\{\{poc\}\}/g, pocName);
      const replacedBody = selected.body
        .replace(/\{\{website\}\}/g, lead.website)
        .replace(/\{\{poc\}\}/g, pocName);
      setSubject(replacedSubject);
      setBody(replacedBody);
    }
  };



  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [disableTracking, setDisableTracking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRecipients.length === 0) {
      setError('Please add at least one recipient email address.');
      return;
    }
    if (!subject || !body) {
      setError('Subject and body content cannot be empty.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/leads/${lead.id}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientEmails: selectedRecipients,
          subject,
          body,
          service: 'smtp', // Default to saved settings
          userId,
          disableTracking
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



  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
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
            <label className="form-label">Recipient Emails</label>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginBottom: '0.75rem',
              maxHeight: '150px',
              overflowY: 'auto',
              padding: '0.6rem 0.8rem',
              border: '1px solid var(--input-border)',
              borderRadius: '8px',
              background: 'var(--input-bg)'
            }}>
              {selectedRecipients.map((mail) => (
                <span 
                  key={mail} 
                  className="email-tag" 
                  style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    gap: '0.25rem',
                    background: 'rgba(99, 102, 241, 0.15)', 
                    borderColor: 'rgba(99, 102, 241, 0.3)',
                    padding: '0.35rem 0.6rem',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    color: 'var(--text-bright)'
                  }}
                >
                  {mail}
                  <button
                    type="button"
                    onClick={() => setSelectedRecipients(prev => prev.filter(x => x !== mail))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'rgba(239, 68, 68, 0.8)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '0.9rem',
                      marginLeft: '4px',
                      lineHeight: 1,
                      fontWeight: 'bold',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    title="Remove recipient"
                    disabled={loading}
                  >
                    &times;
                  </button>
                </span>
              ))}
              {selectedRecipients.length === 0 && (
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No recipients specified. Please add one below.
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="email"
                className="form-control"
                placeholder="Add manual email recipient..."
                value={customEmailInput}
                onChange={(e) => setCustomEmailInput(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.375rem 0.75rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}
                onClick={() => {
                  const email = customEmailInput.trim().toLowerCase();
                  if (email) {
                    if (!tempEmails.includes(email)) {
                      setTempEmails([...tempEmails, email]);
                    }
                    if (!selectedRecipients.includes(email)) {
                      setSelectedRecipients([...selectedRecipients, email]);
                    }
                    setCustomEmailInput('');
                  }
                }}
                disabled={loading}
              >
                Add
              </button>
            </div>
          </div>

          {/* Template Selector Dropdown */}
          {safeDrafts.length > 0 && (
            <div className="form-group">
              <label className="form-label">Select Saved Draft Template</label>
              <select
                className="form-control"
                value={selectedTemplateId}
                onChange={(e) => handleTemplateChange(e.target.value)}
                disabled={loading}
              >
                <option value="">-- No Template Selected (Use Default) --</option>
                {safeDrafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.subject}
                  </option>
                ))}
              </select>
            </div>
          )}

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

          <div className="form-group" style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={disableTracking}
                onChange={(e) => setDisableTracking(e.target.checked)}
                disabled={loading}
              />
              Disable email tracking (Highly recommended to land in Primary Inbox instead of Promotions)
            </label>
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
