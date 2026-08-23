import React, { useState, useEffect, useRef } from 'react';
import { API_URL } from '../config';

interface MailMergeProps {
  userId: string;
  drafts: Draft[];
}

interface Draft {
  id: string;
  subject: string;
  body: string;
}

interface Contact {
  email: string;
  [key: string]: string;
}

interface MmCampaign {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  body: string;
  status: 'draft' | 'sending' | 'completed' | 'paused';
  total_contacts: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  send_delay_ms: number;
  disable_tracking: number;
  created_at: string;
  updated_at: string;
}

interface MmRecipient {
  id: string;
  campaign_id: string;
  email: string;
  variables: string;
  status: string;
  error?: string;
  sent_at?: string;
  opened_at?: string;
  clicked_at?: string;
  replied_at?: string;
  bounced_at?: string;
}

function parseCSV(text: string): { headers: string[]; rows: Contact[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const rawHeaders = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const rows: Contact[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const tokens: string[] = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { tokens.push(cur.trim().replace(/^["']|["']$/g, '')); cur = ''; }
      else { cur += ch; }
    }
    tokens.push(cur.trim().replace(/^["']|["']$/g, ''));
    const contact: Contact = { email: '' };
    rawHeaders.forEach((h, idx) => { contact[h] = tokens[idx] || ''; });
    if (contact.email) rows.push(contact);
  }
  return { headers: rawHeaders, rows };
}

function getStatusColor(status: string) {
  switch (status) {
    case 'sent': return '#6366f1';
    case 'delivered': return '#22c55e';
    case 'opened': return '#3b82f6';
    case 'clicked': return '#f59e0b';
    case 'replied': return '#10b981';
    case 'bounced': return '#ef4444';
    case 'failed': return '#dc2626';
    default: return '#6b7280';
  }
}

function StatusBadge({ status }: { status: string }) {
  const color = getStatusColor(status);
  return (
    <span style={{
      fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
      padding: '0.15rem 0.5rem', borderRadius: '4px',
      background: color + '22', color, border: `1px solid ${color}55`
    }}>
      {status}
    </span>
  );
}

async function parseJsonResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Server error (${res.status})`);
    }
    return data;
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 502) {
      throw new Error('Server is restarting or deploying (502 Bad Gateway). Please try again in a few seconds.');
    }
    if (res.status === 413) {
      throw new Error('Payload too large (413). Please reduce the number of contacts.');
    }
    throw new Error(`Server error (${res.status}): ${res.statusText || 'Unexpected non-JSON response'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const MailMerge: React.FC<MailMergeProps> = ({ userId, drafts }) => {
  const [view, setView] = useState<'campaigns' | 'create'>('campaigns');
  const [campaigns, setCampaigns] = useState<MmCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [campaignDetails, setCampaignDetails] = useState<{ campaign: MmCampaign; recipients: MmRecipient[] } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [pollingCampaignId, setPollingCampaignId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Create campaign form
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [campaignName, setCampaignName] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvError, setCsvError] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [sendDelay, setSendDelay] = useState(500);
  const [disableTracking, setDisableTracking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    try {
      const res = await fetch(`${API_URL}/api/mailmerge/campaigns?userId=${userId}`);
      if (res.ok) setCampaigns(await parseJsonResponse(res));
    } catch (e) { console.error(e); }
    finally { setLoadingCampaigns(false); }
  };

  const fetchCampaignDetails = async (id: string) => {
    setLoadingDetails(true);
    try {
      const res = await fetch(`${API_URL}/api/mailmerge/campaigns/${id}`);
      if (res.ok) setCampaignDetails(await parseJsonResponse(res));
    } catch (e) { console.error(e); }
    finally { setLoadingDetails(false); }
  };

  useEffect(() => { fetchCampaigns(); }, []);

  // Polling for active campaigns
  useEffect(() => {
    const activeCampaign = campaigns.find(c => c.status === 'sending');
    if (activeCampaign && !pollingRef.current) {
      setPollingCampaignId(activeCampaign.id);
      pollingRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/api/mailmerge/campaigns/${activeCampaign.id}/status`);
          if (res.ok) {
            const data = await parseJsonResponse(res);
            setCampaigns(prev => prev.map(c => c.id === activeCampaign.id
              ? { ...c, ...data, status: data.status }
              : c
            ));
            if (data.status !== 'sending') {
              clearInterval(pollingRef.current!);
              pollingRef.current = null;
              setPollingCampaignId(null);
              if (expandedCampaign === activeCampaign.id) fetchCampaignDetails(activeCampaign.id);
            }
          }
        } catch (e) { /* silent */ }
      }, 2000);
    } else if (!activeCampaign && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      setPollingCampaignId(null);
    }
    return () => { /* don't clear on unmount poll if sending */ };
  }, [campaigns.map(c => c.status).join(',')]);

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError('');
    const reader = new FileReader();
    reader.onload = (evt) => {
      const { headers, rows } = parseCSV(evt.target?.result as string);
      if (rows.length === 0) { setCsvError('No valid contacts found. Make sure CSV has an "email" column.'); return; }
      if (!headers.includes('email')) { setCsvError('CSV must have an "email" column.'); return; }
      setCsvHeaders(headers);
      setContacts(rows);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleAddManual = () => {
    const trimmed = manualEmail.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    setContacts(prev => [...prev, { email: trimmed }]);
    setManualEmail('');
  };

  const handleDraftSelect = (draftId: string) => {
    setSelectedDraftId(draftId);
    const d = drafts.find(d => d.id === draftId);
    if (d) { setSubject(d.subject); setBody(d.body); }
  };

  const getPreviewContact = () => contacts[0] || null;
  const getPreview = () => {
    const c = getPreviewContact();
    if (!c || !subject) return null;
    const vars: Record<string, string> = { ...c };
    const resolvedSubject = subject.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
    const resolvedBody = body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
    return { subject: resolvedSubject, body: resolvedBody, email: c.email };
  };

  const handleCreateCampaign = async () => {
    if (!campaignName || !subject || !body || contacts.length === 0) {
      setCreateError('Please fill in all fields and add at least one contact.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch(`${API_URL}/api/mailmerge/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name: campaignName, subject, body, contacts, sendDelayMs: sendDelay, disableTracking })
      });
      const data = await parseJsonResponse(res);
      // Reset form
      setCampaignName(''); setSubject(''); setBody(''); setContacts([]); setCsvHeaders([]);
      setSelectedDraftId(''); setStep(1);
      await fetchCampaigns();
      setView('campaigns');
      // Auto-expand the new campaign
      setExpandedCampaign(data.id);
      fetchCampaignDetails(data.id);
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create campaign.');
    } finally {
      setCreating(false);
    }
  };

  const handleSendCampaign = async (campaignId: string) => {
    setSendingId(campaignId);
    try {
      const res = await fetch(`${API_URL}/api/mailmerge/campaigns/${campaignId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      await parseJsonResponse(res);
      await fetchCampaigns();
    } catch (err: any) {
      alert(err.message || 'Failed to start campaign.');
    } finally {
      setSendingId(null);
    }
  };

  const handlePauseCampaign = async (campaignId: string) => {
    try {
      await fetch(`${API_URL}/api/mailmerge/campaigns/${campaignId}/pause`, { method: 'POST' });
      await fetchCampaigns();
    } catch (e) { console.error(e); }
  };

  const handleDeleteCampaign = async (campaignId: string) => {
    if (!confirm('Delete this campaign and all its data?')) return;
    try {
      await fetch(`${API_URL}/api/mailmerge/campaigns/${campaignId}`, { method: 'DELETE' });
      if (expandedCampaign === campaignId) setExpandedCampaign(null);
      await fetchCampaigns();
    } catch (e) { console.error(e); }
  };

  const toggleCampaignExpand = async (id: string) => {
    if (expandedCampaign === id) { setExpandedCampaign(null); setCampaignDetails(null); return; }
    setExpandedCampaign(id);
    await fetchCampaignDetails(id);
  };

  const totalSent = campaigns.reduce((a, c) => a + (c.sent || 0), 0);
  const totalOpened = campaigns.reduce((a, c) => a + (c.opened || 0), 0);
  const totalClicked = campaigns.reduce((a, c) => a + (c.clicked || 0), 0);

  // ───── RENDER ─────
  return (
    <div className="animate-fade" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>

      {/* Header Row */}
      <div className="glass-panel" style={{ padding: '1.25rem 1.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-bright)' }}>
            ✉️ Mail Merge — YAMM-Style Campaigns
          </h2>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Upload contacts, compose with variables, send & track opens/clicks in real-time.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className={`btn ${view === 'campaigns' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView('campaigns')}
            style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
          >
            📊 Campaigns
          </button>
          <button
            className={`btn ${view === 'create' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setView('create'); setStep(1); }}
            style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
          >
            + New Campaign
          </button>
        </div>
      </div>

      {/* ─── Summary Stats ─── */}
      {view === 'campaigns' && (
        <div className="stat-card-container">
          <div className="glass-panel stat-card">
            <div className="stat-value">{campaigns.length}</div>
            <div className="stat-label">Total Campaigns</div>
          </div>
          <div className="glass-panel stat-card">
            <div className="stat-value" style={{ color: 'var(--primary)' }}>{totalSent}</div>
            <div className="stat-label">Emails Sent</div>
          </div>
          <div className="glass-panel stat-card">
            <div className="stat-value" style={{ color: '#3b82f6' }}>{totalOpened}</div>
            <div className="stat-label">Opens</div>
          </div>
          <div className="glass-panel stat-card">
            <div className="stat-value" style={{ color: '#f59e0b' }}>{totalClicked}</div>
            <div className="stat-label">Clicks</div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────── CAMPAIGNS VIEW ─────────────────────────────────── */}
      {view === 'campaigns' && (
        <div className="glass-panel" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <h3 className="card-title" style={{ margin: 0 }}>All Campaigns</h3>
            <button className="btn btn-secondary" onClick={fetchCampaigns} disabled={loadingCampaigns} style={{ padding: '0.4rem 0.9rem', fontSize: '0.82rem' }}>
              Refresh
            </button>
          </div>

          {loadingCampaigns && campaigns.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', color: 'var(--text-muted)' }}>Loading campaigns…</div>
          ) : campaigns.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '220px', color: 'var(--text-muted)', gap: '0.75rem' }}>
              <span style={{ fontSize: '3rem' }}>📭</span>
              <p style={{ margin: 0, fontWeight: 600 }}>No campaigns yet</p>
              <p style={{ margin: 0, fontSize: '0.82rem' }}>Click "+ New Campaign" to create your first mail merge.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {campaigns.map(campaign => {
                const openRate = campaign.sent > 0 ? ((campaign.opened / campaign.sent) * 100).toFixed(1) : '0';
                const clickRate = campaign.sent > 0 ? ((campaign.clicked / campaign.sent) * 100).toFixed(1) : '0';
                const bounceRate = campaign.sent > 0 ? ((campaign.bounced / campaign.sent) * 100).toFixed(1) : '0';
                const isSending = campaign.status === 'sending' || pollingCampaignId === campaign.id;

                return (
                  <div key={campaign.id} style={{
                    border: '1px solid var(--card-border)',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    background: expandedCampaign === campaign.id ? 'rgba(255,255,255,0.03)' : 'transparent',
                    transition: 'background 0.2s'
                  }}>
                    {/* Campaign Row */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', padding: '1rem 1.25rem', gap: '1rem', cursor: 'pointer', flexWrap: 'wrap' }}
                      onClick={() => toggleCampaignExpand(campaign.id)}
                    >
                      {/* Status + Pulse */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <StatusBadge status={isSending ? 'sending' : campaign.status} />
                        {isSending && (
                          <span style={{
                            position: 'absolute', top: '-3px', right: '-3px', width: '7px', height: '7px',
                            borderRadius: '50%', background: '#22c55e', animation: 'pulse 1.5s infinite'
                          }} />
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {campaign.name}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          Subject: {campaign.subject}
                        </div>
                      </div>

                      {/* Mini KPIs */}
                      <div style={{ display: 'flex', gap: '1.25rem', flexShrink: 0 }}>
                        {[
                          { label: 'Total', value: campaign.total_contacts, color: 'var(--text-bright)' },
                          { label: 'Sent', value: campaign.sent, color: '#6366f1' },
                          { label: 'Opened', value: campaign.opened, color: '#3b82f6' },
                          { label: 'Clicked', value: campaign.clicked, color: '#f59e0b' },
                          { label: 'Bounced', value: campaign.bounced, color: '#ef4444' },
                        ].map(({ label, value, color }) => (
                          <div key={label} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{value}</div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
                          </div>
                        ))}
                      </div>

                      {/* KPI Rates */}
                      <div style={{ display: 'flex', gap: '0.75rem', flexShrink: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <span>📬 {openRate}%</span>
                        <span>🖱️ {clickRate}%</span>
                        <span>↩️ {bounceRate}%</span>
                      </div>

                      {/* Progress Bar */}
                      {campaign.total_contacts > 0 && (
                        <div style={{ width: '100px', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden', flexShrink: 0 }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.min(100, (campaign.sent / campaign.total_contacts) * 100)}%`,
                            background: 'linear-gradient(90deg, var(--primary), #22c55e)',
                            transition: 'width 0.4s ease'
                          }} />
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                        {(campaign.status === 'draft' || campaign.status === 'paused') && (
                          <button
                            className="btn btn-primary"
                            onClick={() => handleSendCampaign(campaign.id)}
                            disabled={!!sendingId}
                            style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem' }}
                          >
                            {sendingId === campaign.id ? '…' : campaign.status === 'paused' ? '▶ Resume' : '🚀 Send'}
                          </button>
                        )}
                        {isSending && (
                          <button
                            className="btn btn-secondary"
                            onClick={() => handlePauseCampaign(campaign.id)}
                            style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem', borderColor: 'var(--warning)', color: 'var(--warning)' }}
                          >
                            ⏸ Pause
                          </button>
                        )}
                        <button
                          className="btn btn-secondary"
                          onClick={() => handleDeleteCampaign(campaign.id)}
                          style={{ padding: '0.35rem 0.6rem', fontSize: '0.78rem', color: '#ef4444' }}
                        >
                          🗑
                        </button>
                      </div>

                      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', flexShrink: 0 }}>
                        {expandedCampaign === campaign.id ? '▲' : '▼'}
                      </span>
                    </div>

                    {/* Expanded Recipients Table */}
                    {expandedCampaign === campaign.id && (
                      <div style={{ borderTop: '1px solid var(--card-border)', padding: '1.25rem' }}>
                        {loadingDetails ? (
                          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>Loading contacts…</div>
                        ) : campaignDetails?.recipients && campaignDetails.recipients.length > 0 ? (
                          <>
                            {/* Rate Cards */}
                            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
                              {[
                                { label: 'Open Rate', value: openRate + '%', color: '#3b82f6', icon: '📬' },
                                { label: 'Click Rate', value: clickRate + '%', color: '#f59e0b', icon: '🖱️' },
                                { label: 'Bounce Rate', value: bounceRate + '%', color: '#ef4444', icon: '↩️' },
                                { label: 'Sent', value: `${campaign.sent}/${campaign.total_contacts}`, color: '#6366f1', icon: '✉️' },
                              ].map(({ label, value, color, icon }) => (
                                <div key={label} style={{
                                  background: color + '11', border: `1px solid ${color}33`, borderRadius: '8px',
                                  padding: '0.6rem 1rem', minWidth: '100px', textAlign: 'center'
                                }}>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{icon} {label}</div>
                                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{value}</div>
                                </div>
                              ))}
                            </div>

                            <div className="table-wrapper" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                              <table>
                                <thead>
                                  <tr>
                                    <th>Email</th>
                                    <th>Status</th>
                                    <th>Sent At</th>
                                    <th>Opened At</th>
                                    <th>Clicked At</th>
                                    <th>Error</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {campaignDetails.recipients.map(r => (
                                    <tr key={r.id}>
                                      <td style={{ fontWeight: 500, color: 'var(--text-bright)' }}>{r.email}</td>
                                      <td><StatusBadge status={r.status} /></td>
                                      <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {r.sent_at ? new Date(r.sent_at).toLocaleString() : '—'}
                                      </td>
                                      <td style={{ fontSize: '0.78rem', color: '#3b82f6' }}>
                                        {r.opened_at ? new Date(r.opened_at).toLocaleString() : '—'}
                                      </td>
                                      <td style={{ fontSize: '0.78rem', color: '#f59e0b' }}>
                                        {r.clicked_at ? new Date(r.clicked_at).toLocaleString() : '—'}
                                      </td>
                                      <td style={{ fontSize: '0.75rem', color: '#ef4444', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {r.error || ''}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        ) : (
                          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem' }}>No contact data available.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────────── CREATE VIEW ─────────────────────────────────── */}
      {view === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* Step Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
            {[
              { n: 1, label: '1. Contacts' },
              { n: 2, label: '2. Compose' },
              { n: 3, label: '3. Review & Send' },
            ].map(({ n, label }, idx) => (
              <React.Fragment key={n}>
                <button
                  onClick={() => step >= n && setStep(n as 1 | 2 | 3)}
                  style={{
                    padding: '0.5rem 1.25rem', borderRadius: '20px', fontSize: '0.82rem', fontWeight: 700,
                    border: 'none', cursor: step >= n ? 'pointer' : 'default',
                    background: step === n ? 'var(--primary)' : step > n ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)',
                    color: step === n ? '#fff' : step > n ? 'var(--primary)' : 'var(--text-muted)',
                    transition: 'all 0.2s'
                  }}
                >
                  {label}
                </button>
                {idx < 2 && (
                  <div style={{ flex: 1, height: '2px', background: step > n ? 'var(--primary)' : 'rgba(255,255,255,0.08)', margin: '0 0.5rem', transition: 'background 0.3s' }} />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* ─── Step 1: Contacts ─── */}
          {step === 1 && (
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div className="glass-panel" style={{ padding: '1.5rem', flex: '1 1 380px' }}>
                <h3 className="card-title">Campaign Name</h3>
                <div className="form-group">
                  <input
                    id="mm-campaign-name"
                    type="text"
                    className="form-control"
                    placeholder="e.g. August Publisher Outreach"
                    value={campaignName}
                    onChange={e => setCampaignName(e.target.value)}
                  />
                </div>

                <h3 className="card-title" style={{ marginTop: '1.5rem' }}>Upload Contacts CSV</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  CSV must have an <strong>email</strong> column. Any other columns become <code style={{ fontSize: '0.8rem' }}>{'{{variable}}'}</code> placeholders.
                </p>
                {csvError && (
                  <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
                    {csvError}
                  </div>
                )}
                <label className="btn btn-secondary" style={{ display: 'block', width: '100%', textAlign: 'center', cursor: 'pointer', boxSizing: 'border-box', marginBottom: '1rem' }}>
                  📁 Upload CSV File
                  <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleCsvUpload} />
                </label>

                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <input
                    type="email"
                    className="form-control"
                    placeholder="Or add email manually…"
                    value={manualEmail}
                    onChange={e => setManualEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddManual())}
                  />
                  <button className="btn btn-secondary" onClick={handleAddManual} style={{ whiteSpace: 'nowrap', padding: '0 1rem' }}>
                    + Add
                  </button>
                </div>
              </div>

              {/* Contact Preview */}
              <div className="glass-panel" style={{ padding: '1.5rem', flex: '1 1 340px' }}>
                <h3 className="card-title">
                  Contact Preview{contacts.length > 0 ? ` (${contacts.length} total)` : ''}
                </h3>
                {csvHeaders.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.75rem' }}>
                    {csvHeaders.map(h => (
                      <span key={h} style={{
                        fontSize: '0.72rem', background: 'rgba(99,102,241,0.15)', color: '#a5b4fc',
                        border: '1px solid rgba(99,102,241,0.3)', borderRadius: '4px', padding: '0.15rem 0.5rem'
                      }}>
                        <code>{`{{${h}}}`}</code>
                      </span>
                    ))}
                  </div>
                )}
                {contacts.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '180px', color: 'var(--text-muted)', gap: '0.5rem' }}>
                    <span style={{ fontSize: '2rem' }}>📋</span>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>Upload a CSV or add emails manually</p>
                  </div>
                ) : (
                  <div className="table-wrapper" style={{ maxHeight: '260px', overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          {(csvHeaders.length > 0 ? csvHeaders : ['email']).map(h => <th key={h}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {contacts.slice(0, 10).map((c, i) => (
                          <tr key={i}>
                            {(csvHeaders.length > 0 ? csvHeaders : ['email']).map(h => (
                              <td key={h} style={{ fontSize: '0.8rem', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {c[h] || ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {contacts.length > 10 && (
                          <tr>
                            <td colSpan={Math.max(csvHeaders.length, 1)} style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>
                              + {contacts.length - 10} more…
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {contacts.length > 0 && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => { setContacts([]); setCsvHeaders([]); }}
                    style={{ marginTop: '0.75rem', fontSize: '0.78rem', padding: '0.3rem 0.75rem', color: '#ef4444' }}
                  >
                    Clear Contacts
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ─── Step 2: Compose ─── */}
          {step === 2 && (
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div className="glass-panel" style={{ padding: '1.5rem', flex: '1 1 420px' }}>
                <h3 className="card-title">Email Composer</h3>

                <div className="form-group">
                  <label className="form-label">Load from Draft Template</label>
                  <select
                    className="form-control"
                    value={selectedDraftId}
                    onChange={e => handleDraftSelect(e.target.value)}
                  >
                    <option value="">— Select template —</option>
                    {drafts.map(d => <option key={d.id} value={d.id}>{d.subject}</option>)}
                  </select>
                </div>

                {csvHeaders.length > 0 && (
                  <div style={{ marginBottom: '1rem', padding: '0.6rem 0.85rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px' }}>
                    <p style={{ margin: '0 0 0.35rem', fontSize: '0.78rem', color: '#a5b4fc', fontWeight: 600 }}>Available Variables:</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                      {csvHeaders.map(h => (
                        <code key={h}
                          style={{ fontSize: '0.75rem', background: 'rgba(99,102,241,0.2)', color: '#c4b5fd', padding: '0.1rem 0.4rem', borderRadius: '4px', cursor: 'pointer' }}
                          onClick={() => setBody(prev => prev + `{{${h}}}`)}
                          title="Click to insert"
                        >
                          {`{{${h}}}`}
                        </code>
                      ))}
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label" htmlFor="mm-subject">Subject</label>
                  <input
                    id="mm-subject"
                    type="text"
                    className="form-control"
                    placeholder="e.g. Partnership opportunity for {{company}}"
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="mm-body">Body (HTML)</label>
                  <textarea
                    id="mm-body"
                    className="form-control"
                    style={{ minHeight: '220px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.82rem' }}
                    placeholder={`<p>Hi {{name}},</p>\n<p>I noticed your website {{website}} and...</p>`}
                    value={body}
                    onChange={e => setBody(e.target.value)}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Send Delay Between Emails</label>
                    <select
                      className="form-control"
                      value={sendDelay}
                      onChange={e => setSendDelay(Number(e.target.value))}
                      style={{ maxWidth: '220px' }}
                    >
                      <option value={0}>No delay (fastest)</option>
                      <option value={500}>500ms (recommended)</option>
                      <option value={1000}>1 second</option>
                      <option value={2000}>2 seconds</option>
                      <option value={5000}>5 seconds</option>
                    </select>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={disableTracking}
                      onChange={e => setDisableTracking(e.target.checked)}
                    />
                    Disable tracking (recommended for Primary Inbox delivery)
                  </label>
                </div>
              </div>

              {/* Live Preview Panel */}
              <div className="glass-panel" style={{ padding: '1.5rem', flex: '1 1 340px', display: 'flex', flexDirection: 'column' }}>
                <h3 className="card-title">Live Preview</h3>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
                  Using first contact: <strong style={{ color: 'var(--text-bright)' }}>{getPreviewContact()?.email || 'N/A'}</strong>
                </p>
                {getPreview() ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ padding: '0.6rem 0.85rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', borderRadius: '6px' }}>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Subject</span>
                      <p style={{ margin: '0.25rem 0 0', fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-bright)' }}>
                        {getPreview()?.subject}
                      </p>
                    </div>
                    <div style={{
                      flex: 1, padding: '0.85rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)',
                      borderRadius: '6px', overflowY: 'auto', maxHeight: '320px',
                      fontSize: '0.84rem', color: 'var(--text-main)', lineHeight: 1.65
                    }}
                      dangerouslySetInnerHTML={{ __html: getPreview()?.body || '' }}
                    />
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-muted)', flexDirection: 'column', gap: '0.5rem' }}>
                    <span style={{ fontSize: '2rem' }}>✏️</span>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>Fill in subject and body to preview</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── Step 3: Review & Send ─── */}
          {step === 3 && (
            <div className="glass-panel" style={{ padding: '1.75rem', maxWidth: '680px', margin: '0 auto', width: '100%' }}>
              <h3 className="card-title">Review & Launch Campaign</h3>

              {createError && (
                <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem' }}>
                  {createError}
                </div>
              )}

              {[
                { label: 'Campaign Name', value: campaignName },
                { label: 'Total Contacts', value: contacts.length.toLocaleString() },
                { label: 'Subject', value: subject },
                { label: 'Tracking', value: disableTracking ? 'Disabled' : 'Enabled (open + click)' },
                { label: 'Send Delay', value: sendDelay === 0 ? 'None' : `${sendDelay}ms between emails` },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.6rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.88rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-bright)', textAlign: 'right', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
                </div>
              ))}

              <div style={{ marginTop: '1.5rem', padding: '0.85rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                ℹ️ The campaign will be saved as a <strong>draft</strong>. You can launch it immediately from the Campaigns list or later.
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.75rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleCreateCampaign}
                  disabled={creating || !campaignName || !subject || !body || contacts.length === 0}
                  style={{ minWidth: '160px' }}
                >
                  {creating ? 'Creating…' : '💾 Save Campaign'}
                </button>
              </div>
            </div>
          )}

          {/* Step Navigation Footer */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              className="btn btn-secondary"
              onClick={() => { if (step === 1) { setView('campaigns'); setStep(1); } else setStep(s => (s - 1) as 1 | 2 | 3); }}
              style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
            >
              {step === 1 ? '← Cancel' : '← Back'}
            </button>

            {step < 3 && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (step === 1 && (!campaignName || contacts.length === 0)) {
                    alert('Please enter a campaign name and add at least one contact.');
                    return;
                  }
                  if (step === 2 && (!subject || !body)) {
                    alert('Subject and body are required.');
                    return;
                  }
                  setStep(s => (s + 1) as 1 | 2 | 3);
                }}
                style={{ padding: '0.5rem 1.5rem', fontSize: '0.85rem' }}
              >
                Next →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MailMerge;
