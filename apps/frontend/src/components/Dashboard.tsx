import React, { useState, useEffect } from 'react';
import { OutreachComposer } from './OutreachComposer';
import { API_URL } from '../config';

interface User {
  id: string;
  email: string;
}

interface Lead {
  id: string;
  website: string;
  manual_email?: string;
  fetched_emails: string[];
  domain_active: boolean;
  status: string;
  crawled_at?: string;
  poc_name?: string;
  similarweb_visits?: number;
  similarweb_pages_per_visit?: number;
  similarweb_total_traffic?: number;
  similarweb_top_geos?: Array<{ name: string; share: number }>;
  similarweb_country?: string;
  similarweb_fetched_at?: string;
  created_at: string;
}

interface EmailLog {
  id: string;
  lead_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  status: string;
  sent_at: string;
  opened_at?: string;
  clicked_at?: string;
  reverted_at?: string;
}

interface CronJob {
  id: string;
  name: string;
  expression: string;
  job_type: string;
  active: number;
  last_run?: string;
  created_at: string;
}

interface DashboardProps {
  user: User;
  onLogout: () => void;
}

// Custom CSV Parser helper
function parseCSV(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const websiteIndex = headers.findIndex(h => h.includes('website') || h.includes('domain') || h.includes('url'));
  const emailIndex = headers.findIndex(h => h.includes('email') || h.includes('mail') || h.includes('contact'));
  const pocIndex = headers.findIndex(h => h.includes('poc') || h.includes('name') || h.includes('person'));

  const parsedLeads: { website: string; email?: string; pocName?: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const tokens: string[] = [];
    let currentToken = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        tokens.push(currentToken.trim().replace(/^["']|["']$/g, ''));
        currentToken = '';
      } else {
        currentToken += char;
      }
    }
    tokens.push(currentToken.trim().replace(/^["']|["']$/g, ''));

    const website = websiteIndex !== -1 ? tokens[websiteIndex] : tokens[0];
    const email = emailIndex !== -1 ? tokens[emailIndex] : tokens[1];
    const pocName = pocIndex !== -1 ? tokens[pocIndex] : tokens[2];

    if (website) {
      parsedLeads.push({
        website: website.trim(),
        email: email ? email.trim() : undefined,
        pocName: pocName ? pocName.trim() : undefined
      });
    }
  }
  return parsedLeads;
}

export const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<'leads' | 'logs' | 'settings' | 'cron'>('leads');
  
  // Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('dockships_theme') as 'dark' | 'light') || 'dark'
  );

  // Leads states
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [websiteInput, setWebsiteInput] = useState('');
  const [manualEmailInput, setManualEmailInput] = useState('');
  const [pocNameInput, setPocNameInput] = useState('');
  const [addingLead, setAddingLead] = useState(false);
  const [activeLeadForOutreach, setActiveLeadForOutreach] = useState<Lead | null>(null);
  const [crawlingIds, setCrawlingIds] = useState<Record<string, boolean>>({});
  const [fetchingSimilarWebIds, setFetchingSimilarWebIds] = useState<Record<string, boolean>>({});
  
  // Multi-selection
  const [selectedLeadIds, setSelectedLeadIds] = useState<Record<string, boolean>>({});

  // CSV Import States
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvError, setCsvError] = useState('');
  const [csvSuccess, setCsvSuccess] = useState('');

  // Logs states
  const [emailLogs, setEmailLogs] = useState<EmailLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Cron states
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loadingCron, setLoadingCron] = useState(false);

  // Settings states
  const [activeService, setActiveService] = useState<'smtp' | 'mailgun'>('smtp');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpSenderName, setSmtpSenderName] = useState('');
  const [smtpSenderEmail, setSmtpSenderEmail] = useState('');
  const [mailgunApiKey, setMailgunApiKey] = useState('');
  const [mailgunDomain, setMailgunDomain] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState({ success: '', error: '' });

  // Apply Theme Toggle Class
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light-theme');
    } else {
      document.documentElement.classList.remove('light-theme');
    }
    localStorage.setItem('dockships_theme', theme);
  }, [theme]);

  // Fetch functions
  const fetchLeads = async () => {
    try {
      const response = await fetch(`${API_URL}/api/leads`);
      if (response.ok) {
        const data = await response.json();
        setLeads(data);
      }
    } catch (e) {
      console.error('Error loading leads:', e);
    } finally {
      setLoadingLeads(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const response = await fetch(`${API_URL}/api/emails`);
      if (response.ok) {
        const data = await response.json();
        setEmailLogs(data);
      }
    } catch (e) {
      console.error('Error loading email logs:', e);
    } finally {
      setLoadingLogs(false);
    }
  };

  const fetchCronJobs = async () => {
    setLoadingCron(true);
    try {
      const response = await fetch(`${API_URL}/api/cron`);
      if (response.ok) {
        const data = await response.json();
        setCronJobs(data);
      }
    } catch (e) {
      console.error('Error loading cron jobs:', e);
    } finally {
      setLoadingCron(false);
    }
  };

  const fetchSmtpSettings = async () => {
    try {
      const response = await fetch(`${API_URL}/api/settings/smtp?userId=${user.id}`);
      if (response.ok) {
        const data = await response.json();
        if (data) {
          setSmtpHost(data.host || '');
          setSmtpPort(String(data.port || '587'));
          setSmtpUsername(data.username || '');
          setSmtpSenderName(data.sender_name || '');
          setSmtpSenderEmail(data.sender_email || '');
          setMailgunDomain(data.mailgun_domain || '');
          setActiveService(data.active_service || 'smtp');
        }
      }
    } catch (e) {
      console.error('Error loading Settings:', e);
    }
  };

  useEffect(() => {
    fetchLeads();
    fetchSmtpSettings();
    
    const interval = setInterval(fetchLeads, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') {
      fetchLogs();
    } else if (activeTab === 'cron') {
      fetchCronJobs();
    }
  }, [activeTab]);

  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!websiteInput) return;

    setAddingLead(true);
    try {
      const response = await fetch(`${API_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          website: websiteInput,
          manualEmail: manualEmailInput || undefined,
          pocName: pocNameInput || undefined
        })
      });

      if (response.ok) {
        setWebsiteInput('');
        setManualEmailInput('');
        setPocNameInput('');
        fetchLeads();
      }
    } catch (err) {
      console.error('Failed to create lead:', err);
    } finally {
      setAddingLead(false);
    }
  };

  const handleForceCrawl = async (id: string) => {
    setCrawlingIds(prev => ({ ...prev, [id]: true }));
    try {
      const response = await fetch(`${API_URL}/api/leads/${id}/crawl`, {
        method: 'POST'
      });
      if (response.ok) {
        fetchLeads();
      }
    } catch (err) {
      console.error('Error forcing crawl:', err);
    } finally {
      setCrawlingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleFetchSimilarWeb = async (id: string) => {
    setFetchingSimilarWebIds(prev => ({ ...prev, [id]: true }));
    try {
      const response = await fetch(`${API_URL}/api/leads/${id}/similarweb`, {
        method: 'POST'
      });
      if (response.ok) {
        fetchLeads();
      } else {
        const err = await response.json();
        alert(err.error || 'Failed to fetch SimilarWeb metrics.');
      }
    } catch (err) {
      console.error('SimilarWeb fetch error:', err);
    } finally {
      setFetchingSimilarWebIds(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleDeleteLead = async (id: string) => {
    if (!confirm('Are you sure you want to delete this lead and its logs?')) return;
    try {
      const response = await fetch(`${API_URL}/api/leads/${id}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        fetchLeads();
        setSelectedLeadIds(prev => {
          const updated = { ...prev };
          delete updated[id];
          return updated;
        });
      }
    } catch (err) {
      console.error('Error deleting lead:', err);
    }
  };

  const handleBulkDelete = async () => {
    const selectedIds = Object.keys(selectedLeadIds).filter(id => selectedLeadIds[id]);
    if (selectedIds.length === 0) return;

    if (!confirm(`Are you sure you want to delete ${selectedIds.length} selected leads and their logs?`)) return;

    try {
      const response = await fetch(`${API_URL}/api/leads`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds })
      });
      if (response.ok) {
        setSelectedLeadIds({});
        fetchLeads();
      }
    } catch (err) {
      console.error('Error deleting leads:', err);
    }
  };

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvUploading(true);
    setCsvError('');
    setCsvSuccess('');

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target?.result as string;
        const parsed = parseCSV(text);
        
        if (parsed.length === 0) {
          throw new Error('No valid website URL / domain column found. CSV should include "website" header.');
        }

        const response = await fetch(`${API_URL}/api/leads/bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: parsed })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Bulk upload server error.');
        }

        setCsvSuccess(`Successfully registered ${parsed.length} leads! Scrapers running in background.`);
        fetchLeads();
      } catch (err: any) {
        setCsvError(err.message || 'Failed to process CSV file.');
      } finally {
        setCsvUploading(false);
        e.target.value = ''; 
      }
    };
    reader.readAsText(file);
  };

  const handleOverrideStatus = async (emailId: string, status: string) => {
    try {
      const response = await fetch(`${API_URL}/api/emails/${emailId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (response.ok) {
        fetchLogs();
        fetchLeads();
      }
    } catch (e) {
      console.error('Error updating log status:', e);
    }
  };

  const handleSimulateReply = async (email: string) => {
    if (!email) return;
    try {
      const response = await fetch(`${API_URL}/api/emails/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: email,
          subject: 'RE: proposal',
          'stripped-text': 'Hi, I saw your outreach email and would love to connect. Let me know when you are free.'
        })
      });
      if (response.ok) {
        alert(`Successfully simulated reply webhook from ${email}. Status updated!`);
        fetchLeads();
        fetchLogs();
      }
    } catch (e) {
      console.error('Error simulating reply:', e);
    }
  };

  const handleSimulateBounce = async (email: string) => {
    if (!email) return;
    try {
      const response = await fetch(`${API_URL}/api/emails/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'event-data': {
            event: 'failed',
            recipient: email,
            reason: 'Hardbounce: Recipient mailbox unavailable'
          }
        })
      });
      if (response.ok) {
        alert(`Successfully simulated permanent bounce webhook for ${email}. Status updated!`);
        fetchLeads();
        fetchLogs();
      }
    } catch (e) {
      console.error('Error simulating bounce:', e);
    }
  };

  const handleToggleCron = async (id: string, active: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/cron/${id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active })
      });
      if (response.ok) {
        fetchCronJobs();
      }
    } catch (e) {
      console.error('Error toggling cron job:', e);
    }
  };

  const handleRunCron = async (id: string) => {
    try {
      const response = await fetch(`${API_URL}/api/cron/${id}/run`, { method: 'POST' });
      if (response.ok) {
        alert('Cron job triggered successfully! Check server logs for output.');
        fetchCronJobs();
      }
    } catch (e) {
      console.error('Error executing cron:', e);
    }
  };

  const handleSaveSmtpSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsStatus({ success: '', error: '' });

    try {
      const response = await fetch(`${API_URL}/api/settings/smtp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          host: smtpHost,
          port: smtpPort ? parseInt(smtpPort, 10) : undefined,
          username: smtpUsername,
          password: smtpPassword,
          senderName: smtpSenderName,
          senderEmail: smtpSenderEmail,
          mailgunApiKey: mailgunApiKey || undefined,
          mailgunDomain: mailgunDomain || undefined,
          activeService
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save configuration.');
      }

      setSettingsStatus({ success: 'Configuration successfully saved!', error: '' });
      setSmtpPassword(''); 
      setMailgunApiKey('');
    } catch (err: any) {
      setSettingsStatus({ success: '', error: err.message || 'Network error occurred.' });
    } finally {
      setSavingSettings(false);
    }
  };

  // Stats
  const totalLeads = leads.length;
  const activeDomains = leads.filter(l => l.domain_active).length;
  const emailsCollected = leads.reduce((acc, lead) => {
    const list = new Set([
      ...(lead.manual_email ? [lead.manual_email] : []),
      ...(lead.fetched_emails || [])
    ]);
    return acc + list.size;
  }, 0);

  const selectedCount = Object.keys(selectedLeadIds).filter(id => selectedLeadIds[id]).length;

  return (
    <div className="main-wrapper animate-fade">
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">DS</div>
          <h1 className="brand-name">Dockships</h1>
        </div>
        
        {/* Navigation tabs */}
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className={`btn ${activeTab === 'leads' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('leads')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            🎯 Targets Dashboard
          </button>
          <button 
            className={`btn ${activeTab === 'logs' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('logs')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            📋 Outreach Logs
          </button>
          <button 
            className={`btn ${activeTab === 'cron' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('cron')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            ⏰ Task Scheduler
          </button>
          <button 
            className={`btn ${activeTab === 'settings' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('settings')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            ⚙️ SMTP Settings
          </button>
        </nav>

        <div className="user-profile">
          <button 
            className="btn btn-secondary" 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
          >
            {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            User: <strong style={{ color: 'var(--text-bright)' }}>{user.email}</strong>
          </span>
          <button className="btn btn-secondary" onClick={onLogout} style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
            Logout
          </button>
        </div>
      </header>

      {/* Leads Tab view */}
      {activeTab === 'leads' && (
        <div className="dashboard-grid">
          {/* Sidebar */}
          <aside style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Stats */}
            <div className="glass-panel stat-card-container">
              <div className="stat-card">
                <div className="stat-value">{totalLeads}</div>
                <div className="stat-label">Total Leads</div>
              </div>
              <div className="stat-card" style={{ borderLeft: '1px solid var(--card-border)', borderRight: '1px solid var(--card-border)' }}>
                <div className="stat-value" style={{ color: 'var(--success)' }}>{activeDomains}</div>
                <div className="stat-label">Active Sites</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: 'var(--primary)' }}>{emailsCollected}</div>
                <div className="stat-label">Emails</div>
              </div>
            </div>

            {/* Add Target */}
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h2 className="card-title">Add Target Lead</h2>
              <form onSubmit={handleAddLead}>
                <div className="form-group">
                  <label className="form-label" htmlFor="website-url-input">Website URL</label>
                  <input
                    id="website-url-input"
                    type="text"
                    className="form-control"
                    placeholder="e.g. mytargetsite.com"
                    value={websiteInput}
                    onChange={(e) => setWebsiteInput(e.target.value)}
                    disabled={addingLead}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="poc-name-input">POC Name (Optional)</label>
                  <input
                    id="poc-name-input"
                    type="text"
                    className="form-control"
                    placeholder="e.g. Jane Doe"
                    value={pocNameInput}
                    onChange={(e) => setPocNameInput(e.target.value)}
                    disabled={addingLead}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="manual-email-input">Manual Contact Email (Optional)</label>
                  <input
                    id="manual-email-input"
                    type="email"
                    className="form-control"
                    placeholder="e.g. contact@site.com"
                    value={manualEmailInput}
                    onChange={(e) => setManualEmailInput(e.target.value)}
                    disabled={addingLead}
                  />
                </div>

                <button 
                  type="submit" 
                  className="btn btn-primary" 
                  style={{ width: '100%', marginTop: '0.5rem' }}
                  disabled={addingLead || !websiteInput}
                >
                  {addingLead ? 'Submitting...' : 'Register Lead & Crawl'}
                </button>
              </form>
            </div>

            {/* Import CSV */}
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h2 className="card-title">Import Leads via CSV</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
                Upload a CSV file containing headers: <strong>website / domain</strong>, <strong>email</strong>, and optionally <strong>poc / name</strong>.
              </p>
              
              {csvError && (
                <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                  {csvError}
                </div>
              )}
              {csvSuccess && (
                <div style={{ background: 'var(--success-glow)', color: '#34d399', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                  {csvSuccess}
                </div>
              )}

              <label className="btn btn-secondary" style={{ width: '100%', display: 'block', textAlign: 'center', cursor: 'pointer', boxSizing: 'border-box' }}>
                {csvUploading ? 'Importing...' : '📁 Choose CSV File'}
                <input 
                  type="file" 
                  accept=".csv" 
                  style={{ display: 'none' }} 
                  onChange={handleCsvImport}
                  disabled={csvUploading}
                />
              </label>
            </div>
          </aside>

          {/* Table */}
          <main className="glass-panel leads-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>Active Targets Tracker</h2>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                {selectedCount > 0 && (
                  <button 
                    className="btn btn-danger animate-fade" 
                    onClick={handleBulkDelete}
                    style={{ padding: '0.45rem 1rem', fontSize: '0.85rem', background: '#ef4444', borderColor: '#ef4444' }}
                  >
                    🗑️ Delete Selected ({selectedCount})
                  </button>
                )}
                <button className="btn btn-secondary" onClick={fetchLeads} disabled={loadingLeads} style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}>
                  Refresh
                </button>
              </div>
            </div>

            {loadingLeads && leads.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
                Loading database...
              </div>
            ) : leads.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🌐</span>
                <p>No outreach targets registered yet.</p>
                <p style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>Enter a website URL or import a CSV on the left to start.</p>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>
                        <input 
                          type="checkbox"
                          checked={leads.length > 0 && leads.every(l => selectedLeadIds[l.id])}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            const newSelected: Record<string, boolean> = {};
                            if (checked) {
                              leads.forEach(l => { newSelected[l.id] = true; });
                            }
                            setSelectedLeadIds(newSelected);
                          }}
                        />
                      </th>
                      <th>Domain</th>
                      <th>POC Name</th>
                      <th>Status</th>
                      <th>Monthly Visits</th>
                      <th>Total Volume</th>
                      <th>Top 5 GEOS</th>
                      <th>Contact Details</th>
                      <th>Flow Status</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => {
                      const emailsList = Array.from(new Set([
                        ...(lead.manual_email ? [lead.manual_email] : []),
                        ...(lead.fetched_emails || [])
                      ]));
                      const isCrawling = crawlingIds[lead.id];
                      const isFetchingSW = fetchingSimilarWebIds[lead.id];

                      return (
                        <tr key={lead.id} className={selectedLeadIds[lead.id] ? 'selected-row' : ''}>
                          <td>
                            <input 
                              type="checkbox" 
                              checked={!!selectedLeadIds[lead.id]}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setSelectedLeadIds(prev => ({ ...prev, [lead.id]: checked }));
                              }}
                            />
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            <a 
                              href={`https://${lead.website}`} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              style={{ color: 'white', textDecoration: 'none' }}
                            >
                              {lead.website} <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>↗</span>
                            </a>
                          </td>
                          <td>
                            {lead.poc_name ? (
                              <span style={{ color: 'var(--text-bright)', fontWeight: 500 }}>{lead.poc_name}</span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>-</span>
                            )}
                          </td>
                          <td>
                            {lead.domain_active ? (
                              <span className="badge badge-success">
                                <span style={{ 
                                  width: '6px', 
                                  height: '6px', 
                                  borderRadius: '50%', 
                                  background: '#10b981', 
                                  display: 'inline-block', 
                                  marginRight: '4px',
                                  animation: 'pulse-dot 1.5s infinite' 
                                }}></span>
                                Online
                              </span>
                            ) : (
                              <span className="badge badge-danger">Offline</span>
                            )}
                          </td>
                          <td>
                            {lead.similarweb_visits !== undefined && lead.similarweb_visits !== null ? (
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <strong style={{ color: 'var(--text-bright)' }}>
                                  {new Intl.NumberFormat('en-US', { notation: 'compact' }).format(lead.similarweb_visits)}
                                </strong>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                  {lead.similarweb_pages_per_visit ? `${lead.similarweb_pages_per_visit.toFixed(1)} p/v` : '-'}
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>-</span>
                            )}
                          </td>
                          <td>
                            {lead.similarweb_total_traffic !== undefined && lead.similarweb_total_traffic !== null ? (
                              <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>
                                {new Intl.NumberFormat('en-US', { notation: 'compact' }).format(lead.similarweb_total_traffic)}
                              </strong>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>-</span>
                            )}
                          </td>
                          <td>
                            {Array.isArray(lead.similarweb_top_geos) && lead.similarweb_top_geos.length > 0 ? (
                              <div className="geo-list">
                                {lead.similarweb_top_geos.slice(0, 5).map((geo: any, idx: number) => (
                                  <div key={idx} className="geo-badge">
                                    <span>{geo.name}</span>
                                    <strong style={{ color: 'var(--primary)', marginLeft: '4px' }}>
                                      {(geo.share * 100).toFixed(0)}%
                                    </strong>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>-</span>
                            )}
                          </td>
                          <td>
                            <div className="email-tags">
                              {emailsList.length === 0 ? (
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                                  {lead.status === 'pending' ? 'Crawl scheduled...' : 'No contact found'}
                                </span>
                              ) : (
                                emailsList.map((email) => {
                                  const isManual = email === lead.manual_email;
                                  return (
                                    <span key={email} className="email-tag" style={{ background: isManual ? 'rgba(16, 185, 129, 0.1)' : 'rgba(99, 102, 241, 0.1)', borderColor: isManual ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.2)' }}>
                                      {email} {isManual && <small style={{ opacity: 0.7 }}>(man)</small>}
                                    </span>
                                  );
                                })
                              )}
                            </div>
                          </td>
                          <td>
                            {lead.status === 'reverted' ? (
                              <span className="badge badge-success" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                                💬 Replied
                              </span>
                            ) : lead.status === 'clicked' ? (
                              <span className="badge badge-info" style={{ background: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                                🖱️ Clicked
                              </span>
                            ) : lead.status === 'opened' ? (
                              <span className="badge badge-primary" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
                                👁️ Opened
                              </span>
                            ) : lead.status === 'delivered' ? (
                              <span className="badge badge-info" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                                📦 Delivered
                              </span>
                            ) : lead.status === 'bounced' ? (
                              <span className="badge badge-danger">
                                🚫 Bounced
                              </span>
                            ) : lead.status === 'outreach_sent' ? (
                              <span className="badge badge-secondary" style={{ background: 'rgba(156, 163, 175, 0.15)', color: '#9ca3af', border: '1px solid rgba(156, 163, 175, 0.3)' }}>
                                ✉️ Sent
                              </span>
                            ) : lead.status === 'active' ? (
                              <span className="badge badge-warning" style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.2)' }}>Active</span>
                            ) : lead.status === 'inactive' ? (
                              <span className="badge badge-danger">Unavailable</span>
                            ) : (
                              <span className="badge" style={{ background: 'rgba(255,255,255,0.06)' }}>Pending</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.4rem' }}>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                                onClick={() => handleForceCrawl(lead.id)}
                                disabled={isCrawling}
                                title="Run merged status, emails and SimilarWeb checks"
                              >
                                {isCrawling ? 'Crawling...' : 'Crawl'}
                              </button>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                                onClick={() => handleFetchSimilarWeb(lead.id)}
                                disabled={isFetchingSW}
                                title="Scrape SimilarWeb visits & geography separately"
                              >
                                {isFetchingSW ? 'SW Fetch...' : 'SW'}
                              </button>
                              <button
                                className="btn btn-primary"
                                style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                                disabled={emailsList.length === 0 || !lead.domain_active}
                                onClick={() => setActiveLeadForOutreach(lead)}
                              >
                                Outreach
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem', background: '#ef4444', borderColor: '#ef4444' }}
                                onClick={() => handleDeleteLead(lead.id)}
                                title="Delete Lead"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        </div>
      )}

      {/* Outreach Logs Tab */}
      {activeTab === 'logs' && (
        <main className="glass-panel" style={{ padding: '2rem', minHeight: '450px' }}>
          <h2 className="card-title">Outreach Communication Logs & Email Activity</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
            Track opens, clicks, delivery states, and replies automatically. Override statuses manually or trigger simulation events.
          </p>

          {loadingLogs ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              Retrieving logs...
            </div>
          ) : emailLogs.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              <span>✉️</span>
              <p style={{ marginTop: '0.5rem' }}>No outreach emails dispatched yet.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Sent At</th>
                    <th>Recipient</th>
                    <th>Subject</th>
                    <th>Email Status Tracker</th>
                    <th>Simulators</th>
                  </tr>
                </thead>
                <tbody>
                  {emailLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{new Date(log.sent_at).toLocaleString()}</td>
                      <td style={{ fontWeight: 600 }}>{log.recipient_email}</td>
                      <td>{log.subject}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span className={`badge ${
                            log.status === 'reverted' ? 'badge-success' :
                            log.status === 'clicked' ? 'badge-info' :
                            log.status === 'opened' ? 'badge-primary' :
                            log.status === 'delivered' ? 'badge-info' :
                            log.status === 'bounced' ? 'badge-danger' : 'badge-secondary'
                          }`} style={{ fontSize: '0.75rem' }}>
                            {log.status === 'reverted' ? 'Replied' :
                             log.status === 'clicked' ? 'Clicked' :
                             log.status === 'opened' ? 'Opened' :
                             log.status === 'delivered' ? 'Delivered' :
                             log.status === 'bounced' ? 'Bounced' : 'Sent'}
                          </span>
                          <select
                            value={log.status}
                            onChange={(e) => handleOverrideStatus(log.id, e.target.value)}
                            style={{
                              background: 'var(--input-bg)',
                              color: 'var(--input-color)',
                              border: '1px solid var(--input-border)',
                              borderRadius: '4px',
                              padding: '0.15rem 0.3rem',
                              fontSize: '0.75rem',
                              cursor: 'pointer'
                            }}
                          >
                            <option value="sent">Sent</option>
                            <option value="delivered">Delivered</option>
                            <option value="opened">Opened</option>
                            <option value="clicked">Clicked</option>
                            <option value="bounced">Bounced</option>
                            <option value="reverted">Replied/Reverted</option>
                          </select>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            onClick={() => handleSimulateReply(log.recipient_email)}
                            title="Simulate recipient replying to this email"
                          >
                            💬 Reply
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: 'var(--danger)' }}
                            onClick={() => handleSimulateBounce(log.recipient_email)}
                            title="Simulate Mailgun permanent bounce event"
                          >
                            🚫 Bounce
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      )}

      {/* Task Scheduler Tab */}
      {activeTab === 'cron' && (
        <main className="glass-panel" style={{ padding: '2rem', minHeight: '450px' }}>
          <h2 className="card-title">⏰ Cron Jobs & Scheduled Tasks</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
            Manage and monitor automated background tasks (e.g. status checkers, system syncing). Tasks can be toggled on/off, or triggered immediately.
          </p>

          {loadingCron && cronJobs.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              Retrieving scheduler details...
            </div>
          ) : cronJobs.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              <span>⏰</span>
              <p style={{ marginTop: '0.5rem' }}>No cron jobs configured in system database.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Job Name</th>
                    <th>Cron Expression</th>
                    <th>Job Type</th>
                    <th>Last Run Time</th>
                    <th>State</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cronJobs.map((job) => (
                    <tr key={job.id}>
                      <td style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{job.name}</td>
                      <td>
                        <code style={{ background: 'rgba(0,0,0,0.15)', padding: '0.2rem 0.4rem', borderRadius: '4px', fontSize: '0.85rem' }}>
                          {job.expression}
                        </code>
                      </td>
                      <td>{job.job_type}</td>
                      <td>
                        {job.last_run ? (
                          new Date(job.last_run).toLocaleString()
                        ) : (
                          <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Never run</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span className={`badge ${job.active === 1 ? 'badge-success' : 'badge-secondary'}`}>
                            {job.active === 1 ? 'Active' : 'Disabled'}
                          </span>
                          <input 
                            type="checkbox" 
                            checked={job.active === 1}
                            onChange={(e) => handleToggleCron(job.id, e.target.checked)}
                            style={{ cursor: 'pointer' }}
                          />
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-primary"
                          style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                          onClick={() => handleRunCron(job.id)}
                        >
                          ⚡ Run Now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      )}

      {/* SMTP / Mailgun Settings Tab */}
      {activeTab === 'settings' && (
        <main className="glass-panel" style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
          <h2 className="card-title">Outreach Service Settings</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
            Configure your custom outgoing SMTP mail server or Mailgun API details. These settings will be securely used to send targeted proposals to your leads.
          </p>

          {settingsStatus.success && (
            <div style={{ background: 'var(--success-glow)', color: '#34d399', padding: '0.75rem 1.25rem', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
              {settingsStatus.success}
            </div>
          )}

          {settingsStatus.error && (
            <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.75rem 1.25rem', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
              {settingsStatus.error}
            </div>
          )}

          <form onSubmit={handleSaveSmtpSettings}>
            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
              <label className="form-label">Active Outreach Service</label>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="active-service-type"
                    checked={activeService === 'smtp'}
                    onChange={() => setActiveService('smtp')}
                    disabled={savingSettings}
                  />
                  SMTP Mail Server
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="active-service-type"
                    checked={activeService === 'mailgun'}
                    onChange={() => setActiveService('mailgun')}
                    disabled={savingSettings}
                  />
                  Mailgun API
                </label>
              </div>
            </div>

            {/* Conditionally Render SMTP Fields */}
            {activeService === 'smtp' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="smtp-host">SMTP Host</label>
                  <input
                    id="smtp-host"
                    type="text"
                    className="form-control"
                    placeholder="e.g. smtp.gmail.com"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'smtp'}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="smtp-port">SMTP Port</label>
                  <input
                    id="smtp-port"
                    type="number"
                    className="form-control"
                    placeholder="e.g. 587 or 465"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'smtp'}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="smtp-username">SMTP Username</label>
                  <input
                    id="smtp-username"
                    type="text"
                    className="form-control"
                    placeholder="Username or Email"
                    value={smtpUsername}
                    onChange={(e) => setSmtpUsername(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'smtp'}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="smtp-password">SMTP Password</label>
                  <input
                    id="smtp-password"
                    type="password"
                    className="form-control"
                    placeholder="Enter Password to change"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'smtp' && !smtpHost} 
                  />
                </div>
              </div>
            )}

            {/* Conditionally Render Mailgun Fields */}
            {activeService === 'mailgun' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="mailgun-domain">Mailgun Domain</label>
                  <input
                    id="mailgun-domain"
                    type="text"
                    className="form-control"
                    placeholder="e.g. mg.mydomain.com"
                    value={mailgunDomain}
                    onChange={(e) => setMailgunDomain(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'mailgun'}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="mailgun-key">Mailgun API Key</label>
                  <input
                    id="mailgun-key"
                    type="password"
                    className="form-control"
                    placeholder="key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    value={mailgunApiKey}
                    onChange={(e) => setMailgunApiKey(e.target.value)}
                    disabled={savingSettings}
                    required={activeService === 'mailgun' && !mailgunDomain} 
                  />
                </div>
              </div>
            )}

            {/* Global Sender Identity (Required for both SMTP and Mailgun) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="smtp-sender-name">Sender Display Name</label>
                <input
                  id="smtp-sender-name"
                  type="text"
                  className="form-control"
                  placeholder="e.g. Outreach Team"
                  value={smtpSenderName}
                  onChange={(e) => setSmtpSenderName(e.target.value)}
                  disabled={savingSettings}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="smtp-sender-email">Sender Email Address</label>
                <input
                  id="smtp-sender-email"
                  type="email"
                  className="form-control"
                  placeholder="e.g. outreach@mybusiness.com"
                  value={smtpSenderEmail}
                  onChange={(e) => setSmtpSenderEmail(e.target.value)}
                  disabled={savingSettings}
                  required
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button type="submit" className="btn btn-primary" disabled={savingSettings}>
                {savingSettings ? 'Saving details...' : 'Save Configuration'}
              </button>
            </div>
          </form>
        </main>
      )}

      {/* Modal Outreach Composer */}
      {activeLeadForOutreach && (
        <OutreachComposer
          lead={activeLeadForOutreach}
          userId={user.id}
          onClose={() => setActiveLeadForOutreach(null)}
          onSent={fetchLeads}
        />
      )}
    </div>
  );
};
export default Dashboard;
