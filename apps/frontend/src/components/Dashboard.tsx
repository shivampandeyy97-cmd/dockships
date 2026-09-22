import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API_URL } from '../config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Seller {
  id: string;
  company_domain: string;
  seller_id?: string;
  name?: string;
  seller_type?: string;
  domain: string;
  is_deleted?: number;
  domain_status?: string;
  ads_txt_status?: string;
  ads_detected?: string;
  fetched_emails?: string;
  best_email?: string;
  crawled_at?: string;
  created_at: string;
}

interface SellersStats {
  total: number;
  pending: number;
  live: number;
  failed: number;
  adsTxtPresent: number;
  adsTxtNotPresent: number;
  crawling: boolean;
}

interface Pagination {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseEmails(emailsInput: any): string[] {
  if (!emailsInput) return [];
  if (Array.isArray(emailsInput)) return emailsInput;
  if (typeof emailsInput === 'string') {
    try {
      const parsed = JSON.parse(emailsInput);
      if (Array.isArray(parsed)) return parsed;
      return emailsInput.trim() ? [emailsInput.trim()] : [];
    } catch {
      return emailsInput.trim() ? [emailsInput.trim()] : [];
    }
  }
  return [];
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'pending') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 10px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 600,
        background: 'rgba(245,158,11,0.12)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)'
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fbbf24', display: 'inline-block' }} />
        pending
      </span>
    );
  }
  if (status === 'pass') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 10px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 600,
        background: 'rgba(0,212,177,0.12)', color: '#00d4b1', border: '1px solid rgba(0,212,177,0.3)'
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#00d4b1', display: 'inline-block' }} />
        live
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 10px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 600,
      background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)'
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171', display: 'inline-block' }} />
      failed
    </span>
  );
}

function AdsTxtBadge({ status }: { status?: string }) {
  const isPresent = status === 'present';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: '6px', fontSize: '0.7rem', fontWeight: 600,
      background: isPresent ? 'rgba(0,212,177,0.1)' : 'rgba(156,163,175,0.1)',
      color: isPresent ? '#00d4b1' : '#6b7280',
      border: `1px solid ${isPresent ? 'rgba(0,212,177,0.25)' : 'rgba(156,163,175,0.2)'}`
    }}>
      {isPresent ? '✓ ads.txt' : '— ads.txt'}
    </span>
  );
}

// Stable row component — only re-renders if its own seller data changes
const SellerRow = React.memo(({ s }: { s: Seller }) => {
  const S = {
    td: {
      padding: '11px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)',
      color: '#d1faf4', verticalAlign: 'middle' as const
    }
  };
  return (
    <tr
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,212,177,0.04)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={S.td}>
        <a
          href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer"
          style={{ color: '#00d4b1', textDecoration: 'none', fontWeight: 600 }}
        >
          {s.domain}
        </a>
      </td>
      <td style={{ ...S.td, color: '#9ca3af' }}>{s.name || <span style={{ color: '#374151' }}>—</span>}</td>
      <td style={{ ...S.td, color: '#6b7280', fontFamily: 'monospace', fontSize: '0.78rem' }}>{s.seller_id || '—'}</td>
      <td style={S.td}>
        {s.seller_type ? (
          <span style={{
            padding: '2px 8px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600,
            background: s.seller_type.toLowerCase() === 'publisher' ? 'rgba(139,92,246,0.12)' : 'rgba(14,165,233,0.12)',
            color: s.seller_type.toLowerCase() === 'publisher' ? '#a78bfa' : '#38bdf8'
          }}>
            {s.seller_type}
          </span>
        ) : '—'}
      </td>
      <td style={S.td}><StatusBadge status={s.domain_status} /></td>
      <td style={S.td}><AdsTxtBadge status={s.ads_txt_status} /></td>
      <td style={{ ...S.td, fontSize: '0.8rem', color: '#9ca3af' }}>
        {s.best_email || (safeParseEmails(s.fetched_emails)[0]) || <span style={{ color: '#374151' }}>—</span>}
      </td>
      <td style={{ ...S.td, fontSize: '0.75rem', color: '#4b5563' }}>
        {s.crawled_at ? new Date(s.crawled_at).toLocaleDateString() : <span style={{ color: '#374151' }}>—</span>}
      </td>
    </tr>
  );
}, (prev, next) => JSON.stringify(prev.s) === JSON.stringify(next.s));

// ─── Main Component ───────────────────────────────────────────────────────────

export const Dashboard: React.FC = () => {
  // Company / fetch state
  const [companyInput, setCompanyInput] = useState('');
  const [fetchingSellers, setFetchingSellers] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Company list
  const [crawledCompanies, setCrawledCompanies] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');

  // Sellers data
  const [sellers, setSellers] = useState<Seller[]>([]);
  // initialLoading: only true on the very first fetch for a company (no data yet)
  const [initialLoading, setInitialLoading] = useState(false);
  const [stats, setStats] = useState<SellersStats>({
    total: 0, pending: 0, live: 0, failed: 0,
    adsTxtPresent: 0, adsTxtNotPresent: 0, crawling: false
  });
  const [pagination, setPagination] = useState<Pagination>({ total: 0, page: 1, limit: 50, pages: 1 });

  // Filters
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');
  const [adsTxtFilter, setAdsTxtFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Export loading
  const [exporting, setExporting] = useState(false);

  // Refs — used by polling interval so it never needs to restart
  const crawlingRef = useRef(false);
  const selectedCompanyRef = useRef('');
  const pageRef = useRef(1);
  const searchRef = useRef('');
  const domainFilterRef = useRef('all');
  const adsTxtFilterRef = useRef('all');
  // Track how many sellers we currently have — if 0, show initial loader
  const hasDataRef = useRef(false);

  // ─── Data fetching ──────────────────────────────────────────────────────────

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/sellers/companies`);
      if (res.ok) {
        const data: string[] = await res.json();
        setCrawledCompanies(data);
      }
    } catch (e) {
      console.error('Error loading companies:', e);
    }
  }, []);

  /**
   * Core data fetcher.
   * silent=true → background poll, NEVER touches loading state, NEVER unmounts table.
   * silent=false → user-triggered, shows initial loader only if no data yet.
   */
  const fetchSellers = useCallback(async (
    company: string,
    pageNum: number,
    searchVal: string,
    domFilt: string,
    adsFilt: string,
    silent: boolean
  ) => {
    if (!company) return;

    // Only show the loading spinner on the very first load (no rows yet)
    const showLoader = !silent && !hasDataRef.current;
    if (showLoader) setInitialLoading(true);

    try {
      const params = new URLSearchParams({
        companyDomain: company,
        page: String(pageNum),
        limit: '50',
        search: searchVal,
        domainStatus: domFilt,
        adsTxtStatus: adsFilt
      });
      const res = await fetch(`${API_URL}/api/sellers?${params}`);
      if (res.ok) {
        const data = await res.json();

        // Stats always update (tiny update, just numbers — no DOM change)
        setStats(data.stats);
        crawlingRef.current = data.stats.crawling;

        // Sellers — only replace array reference if content actually changed
        // This prevents React from re-rendering every single <SellerRow>
        setSellers((prev: Seller[]) => {
          if (prev.length === data.sellers.length) {
            // Quick check: compare just IDs and domain_status (what visually changes during crawl)
            const changed = data.sellers.some((s: Seller, i: number) =>
              !prev[i] ||
              prev[i].id !== s.id ||
              prev[i].domain_status !== s.domain_status ||
              prev[i].best_email !== s.best_email ||
              prev[i].ads_txt_status !== s.ads_txt_status
            );
            if (!changed) return prev; // exact same — skip re-render
          }
          hasDataRef.current = data.sellers.length > 0;
          return data.sellers;
        });
        setPagination(data.pagination);
        hasDataRef.current = data.sellers.length > 0;
      }
    } catch (e) {
      console.error('Error loading sellers:', e);
    } finally {
      if (showLoader) setInitialLoading(false);
    }
  }, []); // NO dependencies — reads everything from refs or params

  // ─── Keep refs in sync with state ──────────────────────────────────────────
  useEffect(() => { selectedCompanyRef.current = selectedCompany; }, [selectedCompany]);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { crawlingRef.current = stats.crawling; }, [stats.crawling]);
  useEffect(() => { searchRef.current = search; }, [search]);
  useEffect(() => { domainFilterRef.current = domainFilter; }, [domainFilter]);
  useEffect(() => { adsTxtFilterRef.current = adsTxtFilter; }, [adsTxtFilter]);

  // ─── Effects ────────────────────────────────────────────────────────────────

  // Initial load
  useEffect(() => { fetchCompanies(); }, [fetchCompanies]);

  // Auto-select first company on initial load
  useEffect(() => {
    if (crawledCompanies.length > 0 && !selectedCompany) {
      const first = crawledCompanies[0];
      setSelectedCompany(first);
      selectedCompanyRef.current = first;
      hasDataRef.current = false;
      fetchSellers(first, 1, '', 'all', 'all', false);
    }
  }, [crawledCompanies, fetchSellers]);

  // Re-fetch when company / page / filters change (user-triggered, non-silent)
  useEffect(() => {
    if (!selectedCompany) return;
    // When switching company, reset hasDataRef so loader shows
    hasDataRef.current = sellers.length > 0 && selectedCompanyRef.current === selectedCompany;
    fetchSellers(selectedCompany, page, search, domainFilter, adsTxtFilter, false);
  }, [selectedCompany, page, domainFilter, adsTxtFilter, fetchSellers]);
  // NOTE: `search` intentionally omitted — search is submit-triggered via handleSearchSubmit

  // Single persistent polling interval — NEVER restarts during crawl
  // Uses refs so it always has fresh values without causing effect re-runs
  useEffect(() => {
    const id = setInterval(() => {
      if (crawlingRef.current && selectedCompanyRef.current) {
        fetchSellers(
          selectedCompanyRef.current,
          pageRef.current,
          searchRef.current,
          domainFilterRef.current,
          adsTxtFilterRef.current,
          true // silent — no loading state, no spinner, no table blink
        );
      }
    }, 3000);
    return () => clearInterval(id);
  }, [fetchSellers]); // fetchSellers has no deps itself, so this runs once

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleFetch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyInput.trim()) return;
    setFetchError('');
    setFetchingSellers(true);
    try {
      const res = await fetch(`${API_URL}/api/sellers/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyDomain: companyInput.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch sellers.json');

      setCompanyInput('');
      setSelectedCompany(data.companyDomain);
      setPage(1);
      setSearch('');
      setDomainFilter('all');
      setAdsTxtFilter('all');
      hasDataRef.current = false;
      await fetchCompanies();
      fetchSellers(data.companyDomain, 1, '', 'all', 'all', false);
    } catch (err: any) {
      setFetchError(err.message || 'Error fetching sellers.json');
    } finally {
      setFetchingSellers(false);
    }
  };

  const handleStartCrawl = async () => {
    if (!selectedCompany) return;
    await fetch(`${API_URL}/api/sellers/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyDomain: selectedCompany })
    });
    crawlingRef.current = true;
    setStats(prev => ({ ...prev, crawling: true }));
    fetchSellers(selectedCompany, page, search, domainFilter, adsTxtFilter, false);
  };

  const handleStopCrawl = async () => {
    if (!selectedCompany) return;
    await fetch(`${API_URL}/api/sellers/crawl/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyDomain: selectedCompany })
    });
    crawlingRef.current = false;
    setStats(prev => ({ ...prev, crawling: false }));
  };

  const handleClearSellers = async () => {
    if (!selectedCompany) return;
    if (!window.confirm(`Clear all sellers data for ${selectedCompany}?`)) return;
    await fetch(`${API_URL}/api/sellers/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyDomain: selectedCompany })
    });
    setSelectedCompany('');
    setSellers([]);
    hasDataRef.current = false;
    setStats({ total: 0, pending: 0, live: 0, failed: 0, adsTxtPresent: 0, adsTxtNotPresent: 0, crawling: false });
    setPagination({ total: 0, page: 1, limit: 50, pages: 1 });
    fetchCompanies();
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchSellers(selectedCompany, 1, search, domainFilter, adsTxtFilter, false);
  };

  const handleExportCSV = async () => {
    if (!selectedCompany) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({
        companyDomain: selectedCompany, page: '1', limit: '100000',
        search, domainStatus: domainFilter, adsTxtStatus: adsTxtFilter
      });
      const res = await fetch(`${API_URL}/api/sellers?${params}`);
      const data = await res.json();
      const list: Seller[] = data?.sellers || [];

      const headers = ['Seller ID', 'Legal Name', 'Seller Type', 'Business Domain', 'Is Live', 'ads.txt Status', 'Best Email', 'All Emails', 'Crawled At'];
      const rows = list.map(s => [
        s.seller_id || '', s.name || '', s.seller_type || '', s.domain || '',
        s.domain_status || 'pending', s.ads_txt_status || 'pending',
        s.best_email || '', safeParseEmails(s.fetched_emails).join('; '), s.crawled_at || ''
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(val => `"${String(val ?? '').replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${selectedCompany}_sellers_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setExporting(false);
    }
  };

  // ─── Styles ─────────────────────────────────────────────────────────────────

  const S = {
    layout: {
      display: 'flex', minHeight: '100vh',
      background: 'linear-gradient(135deg, #060d1a 0%, #0a1628 50%, #060d1a 100%)',
      fontFamily: "'Outfit', sans-serif"
    } as React.CSSProperties,

    sidebar: {
      width: 240, flexShrink: 0,
      background: 'rgba(255,255,255,0.03)',
      borderRight: '1px solid rgba(0,212,177,0.1)',
      display: 'flex', flexDirection: 'column' as const,
      padding: '24px 16px'
    },

    logo: {
      display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32
    },

    logoIcon: {
      width: 40, height: 40, borderRadius: 12,
      background: 'linear-gradient(135deg, #00d4b1, #0891b2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 20, boxShadow: '0 4px 16px rgba(0,212,177,0.3)'
    },

    logoText: {
      fontSize: '1.25rem', fontWeight: 800, color: '#f0fdfa',
      letterSpacing: '-0.3px'
    },

    sidebarLabel: {
      fontSize: '0.7rem', fontWeight: 700, color: 'rgba(0,212,177,0.6)',
      textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 8, paddingLeft: 8
    },

    companyBtn: (active: boolean) => ({
      width: '100%', textAlign: 'left' as const, padding: '8px 12px',
      borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: '0.85rem',
      marginBottom: 4, transition: 'all 0.15s ease', fontFamily: 'inherit',
      background: active ? 'rgba(0,212,177,0.15)' : 'transparent',
      color: active ? '#00d4b1' : '#9ca3af',
      fontWeight: active ? 600 : 400,
      borderLeft: active ? '2px solid #00d4b1' : '2px solid transparent'
    }),

    main: {
      flex: 1, padding: '28px 32px', overflowX: 'hidden' as const, minWidth: 0
    },

    fetchBar: {
      display: 'flex', gap: 12, marginBottom: 28, alignItems: 'flex-start', flexWrap: 'wrap' as const
    },

    fetchInput: {
      flex: 1, minWidth: 240, padding: '10px 16px',
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(0,212,177,0.2)',
      borderRadius: 10, color: '#f0fdfa', fontSize: '0.95rem', fontFamily: 'inherit',
      outline: 'none', transition: 'border-color 0.2s'
    },

    btnTeal: {
      padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
      background: 'linear-gradient(135deg, #00d4b1, #0891b2)',
      color: '#fff', fontWeight: 700, fontSize: '0.9rem', fontFamily: 'inherit',
      boxShadow: '0 4px 14px rgba(0,212,177,0.3)', transition: 'all 0.2s ease',
      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' as const
    },

    btnOutline: {
      padding: '8px 16px', borderRadius: 10,
      border: '1px solid rgba(0,212,177,0.3)', cursor: 'pointer',
      background: 'transparent', color: '#00d4b1', fontWeight: 600,
      fontSize: '0.85rem', fontFamily: 'inherit', transition: 'all 0.2s ease',
      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' as const
    },

    btnDanger: {
      padding: '8px 16px', borderRadius: 10,
      border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
      background: 'transparent', color: '#f87171', fontWeight: 600,
      fontSize: '0.85rem', fontFamily: 'inherit', transition: 'all 0.2s ease',
      whiteSpace: 'nowrap' as const
    },

    statsGrid: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
      gap: 16, marginBottom: 24
    },

    statCard: {
      padding: '20px 16px', textAlign: 'center' as const, borderRadius: 14,
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,212,177,0.12)',
      backdropFilter: 'blur(12px)'
    },

    statValue: {
      fontSize: '1.75rem', fontWeight: 800, color: '#f0fdfa', lineHeight: 1
    },

    statLabel: {
      fontSize: '0.7rem', color: '#6b7280', textTransform: 'uppercase' as const,
      letterSpacing: 1, marginTop: 6, fontWeight: 600
    },

    filterBar: {
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const,
      marginBottom: 16
    },

    filterSelect: {
      padding: '7px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.1)', color: '#d1faf4',
      fontSize: '0.85rem', fontFamily: 'inherit', outline: 'none', cursor: 'pointer'
    },

    searchInput: {
      flex: 1, minWidth: 180, padding: '7px 12px',
      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 8, color: '#f0fdfa', fontSize: '0.85rem', fontFamily: 'inherit',
      outline: 'none'
    },

    tableWrapper: {
      borderRadius: 14, border: '1px solid rgba(0,212,177,0.12)',
      background: 'rgba(255,255,255,0.02)', overflow: 'hidden'
    },

    table: {
      width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem'
    },

    th: {
      padding: '12px 14px', fontSize: '0.72rem', fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 1, color: '#6b7280',
      background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(0,212,177,0.1)',
      textAlign: 'left' as const, whiteSpace: 'nowrap' as const
    },

    crawlingPill: {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', borderRadius: '9999px',
      background: 'rgba(0,212,177,0.12)', border: '1px solid rgba(0,212,177,0.3)',
      color: '#00d4b1', fontSize: '0.78rem', fontWeight: 700
    },

    dot: {
      width: 8, height: 8, borderRadius: '50%', background: '#00d4b1',
      animation: 'pulse-dot 1.4s ease-in-out infinite'
    },

    pageBtn: (active: boolean) => ({
      width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
      fontSize: '0.85rem', fontFamily: 'inherit', transition: 'all 0.15s',
      background: active ? 'linear-gradient(135deg,#00d4b1,#0891b2)' : 'rgba(255,255,255,0.05)',
      color: active ? '#fff' : '#9ca3af', fontWeight: active ? 700 : 400
    }),

    emptyState: {
      padding: '60px 20px', textAlign: 'center' as const
    },

    errorMsg: {
      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
      color: '#f87171', padding: '10px 16px', borderRadius: 10,
      fontSize: '0.85rem', marginBottom: 16
    }
  };

  // ─── Pagination helper ───────────────────────────────────────────────────────

  const renderPagination = () => {
    if (pagination.pages <= 1) return null;
    const pages = Array.from({ length: Math.min(pagination.pages, 10) }, (_, i) => i + 1);
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '14px 16px', borderTop: '1px solid rgba(0,212,177,0.1)' }}>
        <button
          style={S.pageBtn(false)}
          disabled={page <= 1}
          onClick={() => { setPage(p => p - 1); }}
        >‹</button>
        {pages.map(p => (
          <button key={p} style={S.pageBtn(p === page)} onClick={() => setPage(p)}>{p}</button>
        ))}
        {pagination.pages > 10 && <span style={{ color: '#6b7280', alignSelf: 'center', fontSize: '0.8rem' }}>…{pagination.pages}</span>}
        <button
          style={S.pageBtn(false)}
          disabled={page >= pagination.pages}
          onClick={() => { setPage(p => p + 1); }}
        >›</button>
      </div>
    );
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={S.layout}>
      {/* Sidebar */}
      <aside style={S.sidebar}>
        <div style={S.logo}>
          <div style={S.logoIcon}>⚓</div>
          <span style={S.logoText}>Dockships</span>
        </div>

        {crawledCompanies.length > 0 && (
          <>
            <div style={S.sidebarLabel}>Crawled Companies</div>
            {crawledCompanies.map(c => (
              <button
                key={c}
                id={`company-btn-${c.replace(/\./g, '-')}`}
                style={S.companyBtn(c === selectedCompany)}
                onClick={() => {
                  setSelectedCompany(c);
                  setPage(1);
                  setSearch('');
                  setDomainFilter('all');
                  setAdsTxtFilter('all');
                  hasDataRef.current = false;
                  fetchSellers(c, 1, '', 'all', 'all', false);
                }}
              >
                {c}
              </button>
            ))}
          </>
        )}

        {crawledCompanies.length === 0 && (
          <p style={{ fontSize: '0.8rem', color: '#4b5563', paddingLeft: 8 }}>
            No companies yet. Fetch a sellers.json to get started.
          </p>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 24 }}>
          <p style={{ fontSize: '0.72rem', color: '#374151', textAlign: 'center' }}>
            sellers.json crawler
          </p>
        </div>
      </aside>

      {/* Main */}
      <main style={S.main}>
        {/* Fetch Bar */}
        <form onSubmit={handleFetch} style={S.fetchBar}>
          <input
            id="domain-input"
            style={S.fetchInput}
            placeholder="Enter company domain (e.g. google.com)"
            value={companyInput}
            onChange={e => setCompanyInput(e.target.value)}
            onFocus={e => (e.target.style.borderColor = 'rgba(0,212,177,0.5)')}
            onBlur={e => (e.target.style.borderColor = 'rgba(0,212,177,0.2)')}
          />
          <button id="fetch-btn" type="submit" style={S.btnTeal} disabled={fetchingSellers || !companyInput.trim()}>
            {fetchingSellers ? (
              <>
                <span style={{ ...S.dot, animation: 'pulse-dot 0.8s ease-in-out infinite' }} />
                Fetching…
              </>
            ) : '⬇ Fetch sellers.json'}
          </button>
        </form>

        {fetchError && <div id="fetch-error" style={S.errorMsg}>{fetchError}</div>}

        {/* Stats Cards */}
        {selectedCompany && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f0fdfa' }}>
                {selectedCompany}
              </h2>
              {stats.crawling && (
                <div id="crawling-indicator" style={S.crawlingPill}>
                  <span style={S.dot} /> Crawling…
                </div>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {stats.crawling ? (
                  <button id="stop-crawl-btn" style={S.btnOutline} onClick={handleStopCrawl}>
                    ⏹ Stop Crawl
                  </button>
                ) : (
                  <button id="start-crawl-btn" style={S.btnOutline} onClick={handleStartCrawl}
                    disabled={stats.pending === 0 && stats.total > 0}>
                    ▶ {stats.pending > 0 ? 'Resume Crawl' : 'Start Crawl'}
                  </button>
                )}
                <button id="export-csv-btn" style={S.btnOutline} onClick={handleExportCSV} disabled={exporting || sellers.length === 0}>
                  {exporting ? '…' : '↓ Export CSV'}
                </button>
                <button id="clear-sellers-btn" style={S.btnDanger} onClick={handleClearSellers}>
                  🗑 Clear
                </button>
              </div>
            </div>

            <div style={S.statsGrid}>
              {[
                { label: 'Total Sellers', value: stats.total.toLocaleString(), color: '#f0fdfa' },
                { label: 'Live Domains', value: stats.live.toLocaleString(), color: '#00d4b1' },
                { label: 'Failed', value: stats.failed.toLocaleString(), color: '#f87171' },
                { label: 'Pending', value: stats.pending.toLocaleString(), color: '#fbbf24' },
                { label: 'ads.txt Present', value: stats.adsTxtPresent.toLocaleString(), color: '#00d4b1' },
                { label: 'ads.txt Missing', value: stats.adsTxtNotPresent.toLocaleString(), color: '#6b7280' },
              ].map(s => (
                <div key={s.label} style={S.statCard}>
                  <div style={{ ...S.statValue, color: s.color }}>{s.value}</div>
                  <div style={S.statLabel}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Filter + Search */}
            <form onSubmit={handleSearchSubmit} style={S.filterBar}>
              <input
                id="sellers-search"
                style={S.searchInput}
                placeholder="Search domain, name, email…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <select
                id="domain-status-filter"
                style={S.filterSelect}
                value={domainFilter}
                onChange={e => { setDomainFilter(e.target.value); setPage(1); }}
              >
                <option value="all">All Domains</option>
                <option value="pass">Live</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
              </select>
              <select
                id="ads-txt-filter"
                style={S.filterSelect}
                value={adsTxtFilter}
                onChange={e => { setAdsTxtFilter(e.target.value); setPage(1); }}
              >
                <option value="all">All ads.txt</option>
                <option value="present">Present</option>
                <option value="not present">Missing</option>
              </select>
              <button type="submit" style={{ ...S.btnTeal, padding: '7px 16px', fontSize: '0.85rem', boxShadow: 'none' }}>
                Search
              </button>
            </form>

            {/* Table — NEVER unmounts during polling */}
            <div style={S.tableWrapper}>
              {initialLoading ? (
                <div style={S.emptyState}>
                  <div style={{ ...S.dot, margin: '0 auto 12px', width: 12, height: 12 }} />
                  <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>Loading sellers…</p>
                </div>
              ) : sellers.length === 0 ? (
                <div style={S.emptyState}>
                  <p style={{ color: '#4b5563', fontSize: '0.9rem' }}>
                    {stats.total === 0
                      ? 'No sellers found. Fetch a sellers.json to begin.'
                      : 'No sellers match the current filters.'}
                  </p>
                </div>
              ) : (
                <>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {['Business Domain', 'Legal Name', 'Seller ID', 'Type', 'Domain Status', 'ads.txt', 'Best Email', 'Crawled'].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sellers.map(s => (
                        <SellerRow key={s.id} s={s} />
                      ))}
                    </tbody>
                  </table>
                  {renderPagination()}
                </>
              )}
            </div>
          </>
        )}

        {/* No company selected + none crawled yet */}
        {!selectedCompany && crawledCompanies.length === 0 && !fetchingSellers && (
          <div style={{ ...S.emptyState, paddingTop: 80 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚓</div>
            <h2 style={{ color: '#f0fdfa', marginBottom: 8, fontWeight: 700 }}>sellers.json Crawler</h2>
            <p style={{ color: '#6b7280', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
              Enter any ad tech company domain above to fetch their <code style={{ background: 'rgba(0,212,177,0.1)', padding: '1px 6px', borderRadius: 4, color: '#00d4b1' }}>sellers.json</code> file and crawl all their listed seller domains.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
