'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ICP {
  value_prop: string;
  industries: string[];
  company_size_range: string;
  target_titles: string[];
  pain_points: string[];
  keywords: string[];
}

interface Prospect {
  id: string;
  company_name: string;
  company_domain?: string;
  industry?: string;
  company_size?: string;
  contact_name?: string;
  contact_title?: string;
  contact_email?: string;
  email_confidence?: number;
  email_source?: string;
  source?: string;
}

interface Draft {
  id: string;
  prospect_id: string;
  subject: string;
  body: string;
  personalization_note?: string;
  review_status: 'pending' | 'approved' | 'rejected' | 'sent';
}

interface Progress {
  stage: number;
  stageName: string;
  message: string;
  done: boolean;
  error?: string;
}

interface JobStatus {
  jobId: string;
  domain: string;
  status: string;
  icp: ICP | null;
  progress: Progress;
  prospects: Prospect[];
  drafts: Draft[];
}

// ─── Stage Definitions ────────────────────────────────────────────────────────

const STAGES = [
  { num: 1, name: 'Site Reader', icon: '🌐', desc: 'Fetch homepage & about pages' },
  { num: 2, name: 'ICP Builder', icon: '🧩', desc: 'Analyze content, build ICP' },
  { num: 3, name: 'Prospect Finder', icon: '🔍', desc: 'Apollo.io / Google Places search' },
  { num: 4, name: 'Email Finder', icon: '📧', desc: 'Hunter.io + pattern guesser' },
  { num: 5, name: 'Email Writer', icon: '✍️', desc: 'LLM-drafted personalized emails' },
  { num: 6, name: 'Sequencer', icon: '📬', desc: 'Send & track (feature-flagged off)' },
];

// ─── Components ───────────────────────────────────────────────────────────────

function StageTimeline({ currentStage, done }: { currentStage: number; done: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {STAGES.map((s) => {
        const isActive = s.num === currentStage && !done;
        const isDone = s.num < currentStage || done && s.num <= 5;
        const isPending = s.num > currentStage;
        const isDisabled = s.num === 6;

        return (
          <div key={s.num} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            opacity: isDisabled ? 0.4 : 1,
            padding: '8px 12px', borderRadius: 10,
            background: isActive ? 'rgba(99,102,241,0.08)' : 'transparent',
            border: isActive ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
            transition: 'all 0.3s ease',
          }}>
            <div className={`stage-dot ${isActive ? 'active' : isDone ? 'done' : 'pending'}`} />
            <span style={{ fontSize: '1rem' }}>{s.icon}</span>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: isActive ? '#c4b5fd' : isDone ? '#34d399' : '#6b7280' }}>
                Stage {s.num}: {s.name}
                {isDisabled && <span style={{ marginLeft: 6, fontSize: '0.65rem', background: 'rgba(245,158,11,0.15)', color: '#fbbf24', padding: '1px 6px', borderRadius: 4 }}>OFF</span>}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#4b5563' }}>{s.desc}</div>
            </div>
            {isDone && <span style={{ marginLeft: 'auto', color: '#34d399', fontSize: '0.8rem' }}>✓</span>}
          </div>
        );
      })}
    </div>
  );
}

function ICPCard({ icp }: { icp: ICP }) {
  return (
    <div className="glass-card" style={{ padding: 20, marginTop: 24 }}>
      <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>
        🧩 Ideal Customer Profile
      </h3>
      <p style={{ fontSize: '0.9rem', color: '#e2e8f0', marginBottom: 16, lineHeight: 1.6 }}>{icp.value_prop}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Industries</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {icp.industries.map(i => (
              <span key={i} className="badge badge-blue">{i}</span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Target Titles</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {icp.target_titles.map(t => (
              <span key={t} className="badge badge-purple">{t}</span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Company Size</div>
          <span className="badge badge-gray">{icp.company_size_range}</span>
        </div>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Keywords</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {icp.keywords.slice(0, 4).map(k => (
              <span key={k} className="badge badge-gray">{k}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProspectCard({
  prospect,
  draft,
  onApprove,
  onReject,
}: {
  prospect: Prospect;
  draft?: Draft;
  onApprove: (draftId: string) => void;
  onReject: (draftId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const confidence = draft ? null : null;
  const emailConf = prospect.email_confidence ? Math.round(prospect.email_confidence * 100) : null;

  return (
    <div className="glass-card animate-fade-up" style={{ padding: 20, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10, flexShrink: 0,
          background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
          border: '1px solid rgba(99,102,241,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.1rem', fontWeight: 800, color: '#a78bfa'
        }}>
          {(prospect.company_name || '?')[0]?.toUpperCase()}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#e2e8f0' }}>{prospect.company_name}</span>
            {prospect.source && (
              <span className={`badge ${prospect.source === 'apollo' ? 'badge-blue' : 'badge-purple'}`}>
                {prospect.source}
              </span>
            )}
            {draft && (
              <span className={`badge ${draft.review_status === 'approved' ? 'badge-success' : draft.review_status === 'rejected' ? 'badge-gray' : 'badge-warning'}`}>
                {draft.review_status}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
            {prospect.company_domain && (
              <a href={`https://${prospect.company_domain}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.8rem', color: '#6366f1', textDecoration: 'none' }}>
                {prospect.company_domain}
              </a>
            )}
            {prospect.contact_name && (
              <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
                👤 {prospect.contact_name}{prospect.contact_title ? ` · ${prospect.contact_title}` : ''}
              </span>
            )}
            {prospect.contact_email && (
              <span style={{ fontSize: '0.8rem', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }}>
                📧 {prospect.contact_email}
                {emailConf !== null && (
                  <span style={{
                    fontSize: '0.65rem', padding: '1px 5px', borderRadius: 4,
                    background: emailConf > 70 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                    color: emailConf > 70 ? '#34d399' : '#fbbf24'
                  }}>
                    {emailConf}%
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        {draft && draft.review_status === 'pending' && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              id={`approve-draft-${draft.id}`}
              onClick={() => onApprove(draft.id)}
              style={{
                padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                background: 'rgba(16,185,129,0.15)', color: '#34d399',
                fontSize: '0.8rem', fontWeight: 600, fontFamily: 'inherit',
                border: '1px solid rgba(16,185,129,0.25)'
              }}
            >
              ✓ Approve
            </button>
            <button
              id={`reject-draft-${draft.id}`}
              onClick={() => onReject(draft.id)}
              style={{
                padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                background: 'rgba(239,68,68,0.1)', color: '#f87171',
                fontSize: '0.8rem', fontWeight: 600, fontFamily: 'inherit',
                border: '1px solid rgba(239,68,68,0.2)'
              }}
            >
              ✕ Reject
            </button>
          </div>
        )}
      </div>

      {/* Email Draft Preview */}
      {draft && (
        <div style={{ marginTop: 14 }}>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280',
              fontSize: '0.8rem', padding: 0, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4
            }}
          >
            {expanded ? '▾' : '▸'} {expanded ? 'Hide' : 'Preview'} email draft
          </button>

          {expanded && (
            <div style={{
              marginTop: 10, padding: 14, borderRadius: 10,
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)'
            }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9ca3af', marginBottom: 6 }}>
                Subject: <span style={{ color: '#e2e8f0' }}>{draft.subject}</span>
              </div>
              {draft.personalization_note && (
                <div style={{
                  fontSize: '0.75rem', color: '#6366f1', marginBottom: 8,
                  background: 'rgba(99,102,241,0.08)', padding: '4px 8px', borderRadius: 6
                }}>
                  💡 {draft.personalization_note}
                </div>
              )}
              <div
                style={{ fontSize: '0.82rem', color: '#d1d5db', lineHeight: 1.7 }}
                dangerouslySetInnerHTML={{ __html: draft.body.replace(/\{\{UNSUBSCRIBE_LINK\}\}/g, '#') }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const field = (key: string, label: string, placeholder: string, type = 'text') => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: '0.75rem', color: '#6b7280', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {label}
      </label>
      <input
        type={type}
        className="form-input"
        placeholder={placeholder}
        value={settings[key] || ''}
        onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
      />
    </div>
  );

  const section = (title: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: '0.8rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 14 }}>
        {title}
      </h3>
      {children}
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
    }} onClick={onClose}>
      <div
        style={{
          width: 440, height: '100vh', background: '#0f1629',
          border: '1px solid rgba(255,255,255,0.08)', padding: '32px 28px',
          overflowY: 'auto', animation: 'fadeUp 0.25s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>⚙️ Settings</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        {section('Sender Identity', <>
          {field('sender_name', 'Your Name', 'Jane Smith')}
          {field('sender_company', 'Your Company', 'Acme Corp')}
          {field('sender_domain', 'Your Domain', 'acme.com')}
        </>)}

        {section('LLM Provider', <>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#6b7280', marginBottom: 5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Provider
            </label>
            <select
              id="llm-provider-select"
              className="form-input"
              value={settings['llm_provider'] || 'anthropic'}
              onChange={e => setSettings(s => ({ ...s, llm_provider: e.target.value }))}
              style={{ cursor: 'pointer' }}
            >
              <option value="anthropic">Anthropic (Claude 3.5 Haiku)</option>
              <option value="openai">OpenAI (GPT-4o mini)</option>
              <option value="ollama">Ollama (Local, $0 forever)</option>
            </select>
          </div>
          {(settings['llm_provider'] || 'anthropic') !== 'ollama'
            ? field('llm_api_key', `${(settings['llm_provider'] || 'anthropic') === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key`, 'sk-...', 'password')
            : <>
              {field('ollama_url', 'Ollama URL', 'http://localhost:11434')}
              {field('ollama_model', 'Ollama Model', 'llama3.2')}
            </>
          }
        </>)}

        {section('Prospect Finder', <>
          {field('apollo_api_key', 'Apollo.io API Key (free: 200/mo)', 'your-apollo-key', 'password')}
          {field('google_places_api_key', 'Google Places API Key (fallback)', 'AIza...', 'password')}
        </>)}

        {section('Email Finder', <>
          {field('hunter_api_key', 'Hunter.io API Key (free: 25/mo)', 'your-hunter-key', 'password')}
        </>)}

        <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: 14, marginBottom: 24, fontSize: '0.78rem', color: '#fbbf24', lineHeight: 1.6 }}>
          🔒 All API keys are stored locally in <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4 }}>.freegtm/freegtm.db</code> on your machine. Never sent to any server.
        </div>

        <button id="save-settings-btn" className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleSave} disabled={saving}>
          {saving ? <span className="spinner" /> : saved ? '✓ Saved!' : '💾 Save Settings'}
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FreeGTMPage() {
  const [domain, setDomain] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'prospects' | 'icp'>('prospects');
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // ─── Polling ──────────────────────────────────────────────────────────────

  const pollStatus = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/pipeline/status/${id}`);
      if (!res.ok) return;
      const data: JobStatus = await res.json();
      setJobStatus(data);

      if (data.progress?.done || data.status === 'completed' || data.status === 'failed') {
        setRunning(false);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch { }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(() => pollStatus(jobId), 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, pollStatus]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain.trim()) return;
    setError('');
    setRunning(true);
    setJobStatus(null);
    setJobId(null);

    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start pipeline');
      setJobId(data.jobId);
    } catch (err: any) {
      setError(err.message);
      setRunning(false);
    }
  };

  const handleDraftAction = async (draftId: string, action: 'approved' | 'rejected') => {
    await fetch(`/api/drafts/${draftId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: action }),
    });
    if (jobId) pollStatus(jobId);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const progress = jobStatus?.progress;
  const isDone = !!(progress?.done && jobStatus?.status === 'completed');
  const isFailed = jobStatus?.status === 'failed';
  const currentStage = progress?.stage || 0;

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #070b14 0%, #0d1426 50%, #070b14 100%)' }}>
      {/* Header */}
      <header style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '0 32px',
        height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        backdropFilter: 'blur(12px)', background: 'rgba(7,11,20,0.8)',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1rem', boxShadow: '0 0 16px rgba(99,102,241,0.4)'
          }}>🚀</div>
          <div>
            <span style={{ fontWeight: 800, fontSize: '1.05rem', color: '#f1f5f9' }}>FreeGTM</span>
            <span style={{ marginLeft: 8, fontSize: '0.72rem', color: '#4b5563', fontWeight: 500 }}>$0 GTM Automation</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="btn-ghost" style={{ fontSize: '0.8rem' }}>
            GitHub
          </a>
          <button id="open-settings-btn" className="btn-ghost" onClick={() => setShowSettings(true)}>
            ⚙️ Settings
          </button>
        </div>
      </header>

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '40px 32px', display: 'grid', gridTemplateColumns: '300px 1fr', gap: 32, minHeight: 'calc(100vh - 60px)' }}>

        {/* Left Sidebar */}
        <div>
          {/* Hero */}
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 900, lineHeight: 1.2, marginBottom: 8 }}>
              <span className="shimmer-text">Zero-cost GTM</span>
              <br />
              <span style={{ color: '#f1f5f9' }}>automation</span>
            </h1>
            <p style={{ fontSize: '0.85rem', color: '#6b7280', lineHeight: 1.6 }}>
              Paste a company domain. We research it, build an ICP, find matching prospects, and draft personalized emails — using only free APIs.
            </p>
          </div>

          {/* Run Form */}
          <form onSubmit={handleRun} style={{ marginBottom: 24 }}>
            <div style={{ position: 'relative' }}>
              <input
                id="domain-input"
                className="form-input"
                placeholder="yourcompany.com"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                disabled={running}
                style={{ paddingRight: 110 }}
              />
              <button
                id="run-pipeline-btn"
                type="submit"
                className="btn-primary"
                disabled={running || !domain.trim()}
                style={{ position: 'absolute', right: 4, top: 4, padding: '6px 14px', fontSize: '0.82rem' }}
              >
                {running ? <span className="spinner" style={{ width: 14, height: 14 }} /> : '▶ Run'}
              </button>
            </div>
            {error && (
              <div style={{
                marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: '0.78rem',
                background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)'
              }}>
                {error}
              </div>
            )}
          </form>

          {/* Stage Timeline */}
          <div className="glass-card" style={{ padding: 16 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 14 }}>
              Pipeline Stages
            </div>
            <StageTimeline currentStage={currentStage} done={isDone} />
          </div>

          {/* Current progress message */}
          {running && progress && (
            <div style={{
              marginTop: 16, padding: 12, borderRadius: 10,
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
              fontSize: '0.8rem', color: '#c4b5fd', lineHeight: 1.5
            }}>
              <span style={{ display: 'block', fontWeight: 600, marginBottom: 2 }}>
                Stage {currentStage}: {progress.stageName}
              </span>
              {progress.message}
            </div>
          )}

          {/* Free tier info */}
          <div style={{ marginTop: 20, padding: 14, borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', fontSize: '0.72rem', color: '#4b5563', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: '#6b7280', marginBottom: 6 }}>Free tier limits</div>
            <div>🔵 Apollo.io — 200 exports/month</div>
            <div>📍 Google Places — ~6,250 calls/month</div>
            <div>📧 Hunter.io — 25 finder calls/month</div>
            <div>🤖 Ollama — unlimited (local)</div>
            <div>💾 SQLite — unlimited (local)</div>
          </div>
        </div>

        {/* Main Content */}
        <div>
          {!jobStatus && !running && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', textAlign: 'center' }}>
              <div style={{ fontSize: 56, marginBottom: 16 }}>🚀</div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#1f2937', marginBottom: 8 }}>
                <span style={{ color: '#374151' }}>Enter a domain to start the pipeline</span>
              </h2>
              <p style={{ color: '#6b7280', maxWidth: 400, lineHeight: 1.6, fontSize: '0.9rem' }}>
                FreeGTM will research the company, build an ICP, find matching prospects using Apollo.io or Google Places, verify emails, and draft personalized cold emails ready for your review.
              </p>
              <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                {['stripe.com', 'notion.so', 'vercel.com'].map(d => (
                  <button
                    key={d}
                    className="btn-ghost"
                    onClick={() => setDomain(d)}
                    style={{ fontSize: '0.8rem' }}
                  >
                    Try {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(jobStatus || running) && (
            <>
              {/* Job Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
                <div>
                  <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#f1f5f9' }}>
                    {jobStatus?.domain || domain}
                  </h2>
                  <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: 2 }}>
                    {isDone && `${jobStatus?.prospects?.length || 0} prospects found • ${jobStatus?.drafts?.length || 0} email drafts ready`}
                    {running && 'Pipeline running…'}
                    {isFailed && <span style={{ color: '#f87171' }}>Pipeline failed: {jobStatus?.progress?.error}</span>}
                  </div>
                </div>
              </div>

              {/* Tabs */}
              {isDone && (
                <>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(255,255,255,0.04)', padding: 4, borderRadius: 10, width: 'fit-content' }}>
                    {(['prospects', 'icp'] as const).map(tab => (
                      <button
                        key={tab}
                        id={`tab-${tab}`}
                        onClick={() => setActiveTab(tab)}
                        style={{
                          padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                          fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 600,
                          background: activeTab === tab ? 'rgba(99,102,241,0.2)' : 'transparent',
                          color: activeTab === tab ? '#a78bfa' : '#6b7280',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {tab === 'prospects' ? `👥 Prospects (${jobStatus?.prospects?.length || 0})` : '🧩 ICP'}
                      </button>
                    ))}
                  </div>

                  {activeTab === 'icp' && jobStatus?.icp && <ICPCard icp={jobStatus.icp} />}

                  {activeTab === 'prospects' && (
                    <div>
                      <div style={{ fontSize: '0.78rem', color: '#4b5563', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', padding: '3px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600 }}>
                          ⚠️ Human review required before sending
                        </span>
                        Stage 6 (send) is off by default. Approve drafts below, then enable sending in .env.local
                      </div>

                      {jobStatus?.prospects?.map(prospect => {
                        const draft = jobStatus.drafts.find(d => d.prospect_id === prospect.id);
                        return (
                          <ProspectCard
                            key={prospect.id}
                            prospect={prospect}
                            draft={draft}
                            onApprove={(draftId) => handleDraftAction(draftId, 'approved')}
                            onReject={(draftId) => handleDraftAction(draftId, 'rejected')}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Running skeleton */}
              {running && !isDone && [1, 2, 3].map(i => (
                <div key={i} className="glass-card" style={{ padding: 20, marginBottom: 12, opacity: 0.4 }}>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(255,255,255,0.05)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ height: 14, borderRadius: 4, background: 'rgba(255,255,255,0.06)', marginBottom: 6, width: '40%' }} />
                      <div style={{ height: 10, borderRadius: 4, background: 'rgba(255,255,255,0.04)', width: '60%' }} />
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
