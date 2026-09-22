import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';

// Register Chart.js elements
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

export interface GeoSplitItem {
  country: string;
  countryCode?: string;
  percentage: number;
  visits?: number;
}

export interface TrafficSources {
  direct: number;
  organicSearch: number;
  paidSearch: number;
  social: number;
  referral: number;
  email: number;
}

export interface SiteStats {
  domain: string;
  monthlyVisits: number | null;
  dailyVisits: number | null;
  pageviews: number | null;
  pagesPerVisit: number | null;
  avgSessionDuration: number | null;
  bounceRate: number | null;
  geoSplit: GeoSplitItem[];
  trafficSources: TrafficSources | null;
  dataQuality: 'Live estimate' | 'Partial data' | 'Unavailable';
  providerUsed: string;
  cachedAt?: string;
  status: 'success' | 'partial' | 'no_data' | 'error';
  errorMessage?: string;
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function QualityBadge({ quality }: { quality: SiteStats['dataQuality'] }) {
  if (quality === 'Live estimate') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 12px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 700,
        background: 'rgba(0,212,177,0.15)', color: '#00d4b1', border: '1px solid rgba(0,212,177,0.4)'
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#00d4b1' }} />
        Live estimate
      </span>
    );
  }
  if (quality === 'Partial data') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 12px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 700,
        background: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.4)'
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fbbf24' }} />
        Partial data
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '4px 12px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 700,
      background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.4)'
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f87171' }} />
      Unavailable
    </span>
  );
}

export const TrafficDashboard: React.FC = () => {
  const [domainInput, setDomainInput] = useState('github.com');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<SiteStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchTraffic = async (domainToAnalyze: string, refresh = false) => {
    const cleanDomain = domainToAnalyze.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!cleanDomain) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/traffic?domain=${encodeURIComponent(cleanDomain)}&refresh=${refresh}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} — ${res.statusText}`);
      }
      const data: SiteStats = await res.json();
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch traffic stats.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTraffic('github.com');
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchTraffic(domainInput);
  };

  // Chart data for Geo Split (Bar Chart)
  const geoLabels = stats?.geoSplit?.map(g => g.country) || [];
  const geoValues = stats?.geoSplit?.map(g => g.percentage) || [];

  const geoBarData = {
    labels: geoLabels,
    datasets: [
      {
        label: 'Traffic Share (%)',
        data: geoValues,
        backgroundColor: [
          'rgba(0, 212, 177, 0.85)',
          'rgba(8, 145, 178, 0.85)',
          'rgba(59, 130, 246, 0.85)',
          'rgba(139, 92, 246, 0.85)',
          'rgba(236, 72, 153, 0.85)',
          'rgba(245, 158, 11, 0.85)'
        ],
        borderColor: 'rgba(0, 212, 177, 0.3)',
        borderWidth: 1,
        borderRadius: 6
      }
    ]
  };

  const geoBarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context: any) => `${context.parsed.y}% share`
        }
      }
    },
    scales: {
      x: {
        ticks: { color: '#9ca3af', font: { size: 11 } },
        grid: { color: 'rgba(255,255,255,0.05)' }
      },
      y: {
        ticks: { color: '#9ca3af', font: { size: 11 } },
        grid: { color: 'rgba(255,255,255,0.05)' }
      }
    }
  };

  // Chart data for Traffic Sources (Donut Chart)
  const sources = stats?.trafficSources;
  const donutLabels = ['Direct', 'Organic Search', 'Paid Search', 'Social', 'Referral', 'Email'];
  const donutValues = sources
    ? [sources.direct, sources.organicSearch, sources.paidSearch, sources.social, sources.referral, sources.email]
    : [0, 0, 0, 0, 0, 0];

  const donutData = {
    labels: donutLabels,
    datasets: [
      {
        data: donutValues,
        backgroundColor: [
          '#00d4b1', // Direct (Teal)
          '#3b82f6', // Organic (Blue)
          '#f59e0b', // Paid (Amber)
          '#ec4899', // Social (Pink)
          '#8b5cf6', // Referral (Purple)
          '#10b981'  // Email (Emerald)
        ],
        borderWidth: 2,
        borderColor: '#0f172a'
      }
    ]
  };

  const donutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '70%',
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: '#d1faf4',
          font: { size: 12, weight: 600 },
          boxWidth: 12,
          padding: 14
        }
      },
      tooltip: {
        callbacks: {
          label: (context: any) => `${context.label}: ${context.parsed}%`
        }
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Search Header */}
      <div style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(0,212,177,0.15)',
        borderRadius: 16,
        padding: '24px 28px',
        backdropFilter: 'blur(12px)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#f0fdfa', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>📊</span> Website Traffic Intelligence
            </h2>
            <p style={{ fontSize: '0.85rem', color: '#9ca3af', margin: '4px 0 0 0' }}>
              Analyze domain traffic, geographic distribution & acquisition sources (Pluggable Free Tier Providers)
            </p>
          </div>

          {stats && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <QualityBadge quality={stats.dataQuality} />
              <button
                onClick={() => fetchTraffic(domainInput, true)}
                style={{
                  padding: '6px 14px', borderRadius: 8,
                  border: '1px solid rgba(0,212,177,0.3)', background: 'transparent',
                  color: '#00d4b1', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer'
                }}
              >
                🔄 Refresh
              </button>
            </div>
          )}
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
            <input
              type="text"
              value={domainInput}
              onChange={e => setDomainInput(e.target.value)}
              placeholder="Enter domain (e.g. github.com, nytimes.com, wikipedia.org)"
              style={{
                width: '100%', padding: '12px 16px',
                background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,212,177,0.3)',
                borderRadius: 10, color: '#fff', fontSize: '0.95rem', outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !domainInput.trim()}
            style={{
              padding: '12px 24px', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg, #00d4b1, #0891b2)',
              color: '#fff', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(0,212,177,0.3)', display: 'flex', alignItems: 'center', gap: 8
            }}
          >
            {loading ? 'Analyzing domain…' : 'Analyze Traffic'}
          </button>
        </form>

        {/* Preset Sample Domain Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 600 }}>Try sample domains:</span>
          {['github.com', 'nytimes.com', 'wikipedia.org', 'techcrunch.com', 'openai.com'].map(d => (
            <button
              key={d}
              onClick={() => { setDomainInput(d); fetchTraffic(d); }}
              style={{
                padding: '3px 10px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
                color: '#d1faf4', fontSize: '0.75rem', cursor: 'pointer'
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '14px 20px', borderRadius: 12,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171', fontSize: '0.9rem'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Main Dashboard Results */}
      {stats && stats.status !== 'no_data' && (
        <>
          {/* Metadata Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: '#9ca3af', padding: '0 4px' }}>
            <div>
              Analyzing: <strong style={{ color: '#00d4b1' }}>{stats.domain}</strong> &bull; Data Source: <span style={{ color: '#e2e8f0' }}>{stats.providerUsed}</span>
            </div>
            {stats.cachedAt && (
              <div>
                ⚡ Cached lookup (24h TTL)
              </div>
            )}
          </div>

          {/* Overview Cards Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 16
          }}>
            <div style={{
              padding: '20px', borderRadius: 14,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                Est. Monthly Visits
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f0fdfa', marginTop: 8 }}>
                {formatNumber(stats.monthlyVisits)}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#00d4b1', marginTop: 4 }}>
                Global volume estimate
              </div>
            </div>

            <div style={{
              padding: '20px', borderRadius: 14,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                Est. Daily Visits
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f0fdfa', marginTop: 8 }}>
                {formatNumber(stats.dailyVisits)}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 4 }}>
                Derived (Monthly / 30)
              </div>
            </div>

            <div style={{
              padding: '20px', borderRadius: 14,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                Est. Pageviews
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f0fdfa', marginTop: 8 }}>
                {formatNumber(stats.pageviews)}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 4 }}>
                {stats.pagesPerVisit ? `${stats.pagesPerVisit.toFixed(1)} pages / visit` : 'Calculated total'}
              </div>
            </div>

            <div style={{
              padding: '20px', borderRadius: 14,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                Avg Session Duration
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f0fdfa', marginTop: 8 }}>
                {formatDuration(stats.avgSessionDuration)}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 4 }}>
                Time on site
              </div>
            </div>

            <div style={{
              padding: '20px', borderRadius: 14,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                Bounce Rate
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f0fdfa', marginTop: 8 }}>
                {stats.bounceRate !== null ? `${stats.bounceRate}%` : 'N/A'}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 4 }}>
                Single page visits %
              </div>
            </div>
          </div>

          {/* Cards Split Grid: Geo Distribution & Traffic Sources */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
            gap: 24
          }}>
            {/* Geo Distribution Card */}
            <div style={{
              padding: '24px', borderRadius: 16,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)',
              display: 'flex', flexDirection: 'column', gap: 16
            }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f0fdfa', margin: 0 }}>
                🌍 Top Geography Split
              </h3>

              {stats.geoSplit.length > 0 ? (
                <>
                  <div style={{ height: 180 }}>
                    <Bar data={geoBarData} options={geoBarOptions as any} />
                  </div>

                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#6b7280', textAlign: 'left' }}>
                        <th style={{ padding: '8px 4px' }}>Country</th>
                        <th style={{ padding: '8px 4px', textAlign: 'right' }}>Share (%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.geoSplit.map((g, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '8px 4px', color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '1.1rem' }}>🌐</span>
                            {g.country}
                          </td>
                          <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: 700, color: '#00d4b1' }}>
                            {g.percentage}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <p style={{ fontSize: '0.85rem', color: '#9ca3af' }}>No geographic distribution data available.</p>
              )}
            </div>

            {/* Traffic Acquisition Sources Card */}
            <div style={{
              padding: '24px', borderRadius: 16,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,177,0.15)',
              display: 'flex', flexDirection: 'column', gap: 16
            }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f0fdfa', margin: 0 }}>
                🧭 Traffic Acquisition Channels
              </h3>

              {sources ? (
                <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Doughnut data={donutData} options={donutOptions as any} />
                </div>
              ) : (
                <p style={{ fontSize: '0.85rem', color: '#9ca3af' }}>No channel split data available for this domain.</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Graceful empty state for small/new domains */}
      {stats && stats.status === 'no_data' && (
        <div style={{
          padding: '48px 24px', borderRadius: 16,
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(239,68,68,0.2)',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🔍</div>
          <h3 style={{ fontSize: '1.2rem', color: '#f87171', fontWeight: 700, margin: 0 }}>
            Insufficient Data for "{stats.domain}"
          </h3>
          <p style={{ fontSize: '0.9rem', color: '#9ca3af', maxWidth: 500, margin: '8px auto 0 auto' }}>
            This domain appears to be very new or has limited public web traffic volume.
            Free data providers could not return a confident traffic estimate.
          </p>
        </div>
      )}

      {/* Modeled Disclaimer Notice */}
      <div style={{
        textAlign: 'center', fontSize: '0.78rem', color: '#6b7280',
        padding: '16px 20px', borderRadius: 10, background: 'rgba(0,0,0,0.2)',
        border: '1px solid rgba(255,255,255,0.05)'
      }}>
        💡 <strong>Note on Traffic Estimates</strong>: All numbers presented are modeled estimates generated from public network, search, and traffic signal providers.
      </div>
    </div>
  );
};
