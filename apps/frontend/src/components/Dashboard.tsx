import React, { useState, useEffect } from 'react';
import { OutreachComposer } from './OutreachComposer';
import { MailMerge } from './MailMerge';
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
  best_email?: string;
  email_validation_status?: string;
  domain_status?: string;
  ads_txt_status?: string;
  ads_detected?: string;
  contact_form_status?: string;
  linkedin_status?: string;
  status: string;
  crawled_at?: string;
  poc_name?: string;
  created_at: string;
  sellers_companies?: string;
}

interface EmailLog {
  id: string;
  lead_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  status: string;
  email_provider?: string;
  bounce_reason?: string;
  reply_count?: number;
  sent_at: string;
  delivered_at?: string;
  opened_at?: string;
  clicked_at?: string;
  reverted_at?: string;
}

interface EmailEvent {
  id: string;
  email_id: string;
  event_type: string;
  event_time: string;
  metadata?: string;
}

interface EmailStats {
  total: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  replied: number;
  recentlySent: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  deliveryRate: number;
  replyRate: number;
}

interface SlackSettings {
  bot_token: string;
  channel: string;
  signing_secret: string;
  webhook_url: string;
  configured: boolean;
}

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

interface SellersPagination {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface Draft {
  id: string;
  subject: string;
  body: string;
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
  const websiteIndex = headers.findIndex(h => h.includes('website') || h.includes('domain') || h.includes('url') || h.includes('business domain'));
  const emailIndex = headers.findIndex(h => h.includes('email') || h.includes('mail') || h.includes('contact') || h.includes('email id') || h.includes('email ids') || h.includes('fetched_emails'));
  const pocIndex = headers.findIndex(h => h.includes('poc') || h.includes('name') || h.includes('person') || h.includes('legal name'));
  const liveIndex = headers.findIndex(h => h.includes('live') || h.includes('is live') || h.includes('domain status') || h.includes('domain_status'));
  const adsIndex = headers.findIndex(h => h.includes('ads') || h.includes('ads.txt status') || h.includes('ads_txt_status'));

  // If at least one header matches, we have headers. Otherwise, it is a raw/header-less CSV.
  const hasHeaders = websiteIndex !== -1 || emailIndex !== -1 || pocIndex !== -1 || liveIndex !== -1 || adsIndex !== -1;

  interface ParsedLead {
    website: string;
    email?: string;
    pocName?: string;
    domainStatus?: string;
    adsTxtStatus?: string;
  }

  const parsedLeads: ParsedLead[] = [];

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

    const website = websiteIndex !== -1 ? tokens[websiteIndex] : (hasHeaders ? undefined : tokens[0]);
    const email = emailIndex !== -1 ? tokens[emailIndex] : (hasHeaders ? undefined : tokens[1]);
    const pocName = pocIndex !== -1 ? tokens[pocIndex] : (hasHeaders ? undefined : tokens[2]);
    const domainStatusVal = liveIndex !== -1 ? tokens[liveIndex] : undefined;
    const adsTxtStatusVal = adsIndex !== -1 ? tokens[adsIndex] : undefined;

    // Normalize domainStatus
    let domainStatus = 'pending';
    if (domainStatusVal) {
      const dsv = domainStatusVal.trim().toLowerCase();
      if (dsv === 'pass' || dsv === 'live' || dsv === 'yes' || dsv === 'true') {
        domainStatus = 'pass';
      } else if (dsv === 'failed' || dsv === 'offline' || dsv === 'no' || dsv === 'false') {
        domainStatus = 'failed';
      }
    }

    // Normalize adsTxtStatus
    let adsTxtStatus = 'pending';
    if (adsTxtStatusVal) {
      const atv = adsTxtStatusVal.trim().toLowerCase();
      if (atv === 'present' || atv === 'yes' || atv === 'true') {
        adsTxtStatus = 'present';
      } else if (atv === 'not present' || atv === 'no' || atv === 'false') {
        adsTxtStatus = 'not present';
      }
    }

    if (website) {
      parsedLeads.push({
        website: website.trim(),
        email: email ? email.trim() : undefined,
        pocName: pocName ? pocName.trim() : undefined,
        domainStatus,
        adsTxtStatus
      });
    }
  }
  return parsedLeads;
}

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

export const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<'leads' | 'logs' | 'settings' | 'templates' | 'agent' | 'sellers' | 'mailmerge'>('leads');

  // Sellers states
  const [crawledCompanies, setCrawledCompanies] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string>('');
  const [companyInput, setCompanyInput] = useState<string>('');
  const [fetchingSellers, setFetchingSellers] = useState<boolean>(false);
  const [loadingSellers, setLoadingSellers] = useState<boolean>(false);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [sellersStats, setSellersStats] = useState<SellersStats>({
    total: 0,
    pending: 0,
    live: 0,
    failed: 0,
    adsTxtPresent: 0,
    adsTxtNotPresent: 0,
    crawling: false
  });
  const [sellersPagination, setSellersPagination] = useState<SellersPagination>({
    total: 0,
    page: 1,
    limit: 50,
    pages: 1
  });
  const [sellersSearch, setSellersSearch] = useState<string>('');
  const [sellersDomainFilter, setSellersDomainFilter] = useState<string>('all');
  const [sellersAdsTxtFilter, setSellersAdsTxtFilter] = useState<string>('all');
  const [sellersPage, setSellersPage] = useState<number>(1);
  
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
  
  // Multi-selection
  const [selectedLeadIds, setSelectedLeadIds] = useState<Record<string, boolean>>({});

  // CSV Import States
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvError, setCsvError] = useState('');
  const [csvSuccess, setCsvSuccess] = useState('');

  // Logs states
  const [emailLogs, setEmailLogs] = useState<EmailLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);




  // Draft templates states
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [selectedDraftForEdit, setSelectedDraftForEdit] = useState<Draft | null>(null);
  const [draftSubjectInput, setDraftSubjectInput] = useState('');
  const [draftBodyInput, setDraftBodyInput] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);

  // Bulk Outreach Modal States
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkSubject, setBulkSubject] = useState('');
  const [bulkBody, setBulkBody] = useState('');
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [bulkError, setBulkError] = useState('');
  const [bulkSuccess, setBulkSuccess] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [disableBulkTracking, setDisableBulkTracking] = useState(false);

  // Editing POC states
  const [editingPocLeadId, setEditingPocLeadId] = useState<string | null>(null);
  const [pocNameEditVal, setPocNameEditVal] = useState('');

  // Simplified flow filters
  const [domainFilter, setDomainFilter] = useState<'all' | 'pass' | 'failed'>('all');
  const [adsTxtFilter, setAdsTxtFilter] = useState<'all' | 'present' | 'not present'>('all');
  const [adsFilter, setAdsFilter] = useState<'all' | 'yes' | 'no'>('all');
  const [contactFilter, setContactFilter] = useState<'all' | 'email found' | 'contact form available' | 'none'>('all');
  const [linkedinFilter, setLinkedinFilter] = useState<'all' | 'working' | 'none'>('all');
  const [sellersCompanyFilter, setSellersCompanyFilter] = useState<string>('all');
  const [emailValidationFilter, setEmailValidationFilter] = useState<string>('all');

  // Email stats states
  const [emailStats, setEmailStats] = useState<EmailStats | null>(null);
  const [logsFilter, setLogsFilter] = useState<'all' | 'opened' | 'clicked' | 'bounced' | 'reverted' | 'delivered' | 'sent'>('all');
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);
  const [emailEvents, setEmailEvents] = useState<Record<string, EmailEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<Record<string, boolean>>({});

  // Slack / Agent states
  const [slackSettings, setSlackSettings] = useState<SlackSettings | null>(null);
  const [slackBotToken, setSlackBotToken] = useState('');
  const [slackChannel, setSlackChannel] = useState('#dockships-alerts');
  const [slackSigningSecret, setSlackSigningSecret] = useState('');
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [savingSlack, setSavingSlack] = useState(false);
  const [slackStatus, setSlackStatus] = useState({ success: '', error: '' });
  const [testingSlack, setTestingSlack] = useState(false);
  const [agentStats, setAgentStats] = useState<any | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentMessage, setAgentMessage] = useState('');

  // Apply Theme Toggle Class
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light-theme');
    } else {
      document.documentElement.classList.remove('light-theme');
    }
    localStorage.setItem('dockships_theme', theme);
  }, [theme]);


  // Targets CSV Export
  const handleExportLeadsCSV = () => {
    if (leads.length === 0) {
      alert("No leads available to export.");
      return;
    }

    const filtered = leads.filter(lead => {
      if (domainFilter !== 'all' && lead.domain_status !== domainFilter) return false;
      if (adsTxtFilter !== 'all' && lead.ads_txt_status !== adsTxtFilter) return false;
      if (adsFilter !== 'all') {
        const hasAds = lead.ads_detected && lead.ads_detected.toLowerCase().startsWith('yes');
        if (adsFilter === 'yes' && !hasAds) return false;
        if (adsFilter === 'no' && hasAds) return false;
      }
      if (contactFilter !== 'all' && lead.contact_form_status !== contactFilter) return false;
      if (linkedinFilter !== 'all' && lead.linkedin_status !== linkedinFilter) return false;
      
      // Sellers Company Filter
      if (sellersCompanyFilter !== 'all') {
        const companies = lead.sellers_companies
          ? lead.sellers_companies.split(',').map((c: string) => c.trim().toLowerCase())
          : [];
        if (!companies.includes(sellersCompanyFilter.toLowerCase())) return false;
      }
      
      // Email ID Live Status Filter
      if (emailValidationFilter !== 'all') {
        const validationStatus = lead.email_validation_status || 'pending';
        if (validationStatus !== emailValidationFilter) return false;
      }
      
      return true;
    });

    if (filtered.length === 0) {
      alert("No leads match current active filters.");
      return;
    }

    const headers = [
      'Website Domain',
      'POC Name',
      'Domain Status',
      'ads.txt Status',
      'Ads Detected',
      'Contact Form Status',
      'Best Email',
      'Fetched Emails',
      'Email ID Live Status',
      'LinkedIn Status',
      'Outreach Status',
      'Crawled At',
      'Created At'
    ];

    const rows = filtered.map(lead => [
      lead.website,
      lead.poc_name || '',
      lead.domain_status || 'pending',
      lead.ads_txt_status || 'pending',
      lead.ads_detected || 'pending',
      lead.contact_form_status || 'pending',
      lead.best_email || '',
      safeParseEmails(lead.fetched_emails).join('; '),
      lead.email_validation_status || 'pending',
      lead.linkedin_status || 'pending',
      lead.status || 'pending',
      lead.crawled_at || '',
      lead.created_at || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(val => `"${val.replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `dockships_leads_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Fetch company list
  const fetchCrawledCompanies = async () => {
    try {
      const response = await fetch(`${API_URL}/api/sellers/companies`);
      if (response.ok) {
        const data = await response.json();
        setCrawledCompanies(data);
      }
    } catch (e) {
      console.error('Error loading crawled companies:', e);
    }
  };

  // Fetch sellers lists & stats
  const fetchSellers = async (company: string, pageNum: number, searchVal?: string, domFilter?: string, adsTxtFilt?: string) => {
    if (!company) return;
    setLoadingSellers(true);
    try {
      const queryParams = new URLSearchParams({
        companyDomain: company,
        page: String(pageNum),
        limit: '50',
        search: searchVal !== undefined ? searchVal : sellersSearch,
        domainStatus: domFilter !== undefined ? domFilter : sellersDomainFilter,
        adsTxtStatus: adsTxtFilt !== undefined ? adsTxtFilt : sellersAdsTxtFilter
      });

      const response = await fetch(`${API_URL}/api/sellers?${queryParams}`);
      if (response.ok) {
        const data = await response.json();
        setSellers(data.sellers);
        setSellersStats(data.stats);
        setSellersPagination(data.pagination);
      }
    } catch (e) {
      console.error('Error loading sellers:', e);
    } finally {
      setLoadingSellers(false);
    }
  };

  // Fetch & crawl sellers.json
  const handleFetchSellersJson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyInput.trim()) return;
    setFetchingSellers(true);
    try {
      const response = await fetch(`${API_URL}/api/sellers/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyDomain: companyInput })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch sellers.json');
      }

      alert(data.message);
      setSelectedCompany(data.companyDomain);
      setCompanyInput('');
      setSellersPage(1);
      setSellersSearch('');
      setSellersDomainFilter('all');
      setSellersAdsTxtFilter('all');
      fetchCrawledCompanies();
      fetchSellers(data.companyDomain, 1, '', 'all', 'all');
    } catch (err: any) {
      alert(err.message || 'Error occurred fetching sellers.json');
    } finally {
      setFetchingSellers(false);
    }
  };

  // Start / Resume crawl
  const handleCrawlSellers = async () => {
    if (!selectedCompany) return;
    try {
      const response = await fetch(`${API_URL}/api/sellers/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyDomain: selectedCompany })
      });
      if (response.ok) {
        setSellersStats(prev => ({ ...prev, crawling: true }));
        fetchSellers(selectedCompany, sellersPage);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Stop crawl
  const handleStopCrawlSellers = async () => {
    if (!selectedCompany) return;
    try {
      const response = await fetch(`${API_URL}/api/sellers/crawl/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyDomain: selectedCompany })
      });
      if (response.ok) {
        setSellersStats(prev => ({ ...prev, crawling: false }));
        fetchSellers(selectedCompany, sellersPage);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Clear sellers
  const handleClearSellers = async () => {
    if (!selectedCompany) return;
    if (!window.confirm(`Are you sure you want to clear all sellers data for ${selectedCompany}?`)) return;
    try {
      const response = await fetch(`${API_URL}/api/sellers/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyDomain: selectedCompany })
      });
      if (response.ok) {
        setSelectedCompany('');
        setSellers([]);
        setSellersStats({
          total: 0,
          pending: 0,
          live: 0,
          failed: 0,
          adsTxtPresent: 0,
          adsTxtNotPresent: 0,
          crawling: false
        });
        setSellersPagination({ total: 0, page: 1, limit: 50, pages: 1 });
        fetchCrawledCompanies();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Export Sellers to CSV
  const handleExportSellersCSV = () => {
    if (sellers.length === 0 || !selectedCompany) {
      alert("No sellers data available to export.");
      return;
    }

    const headers = [
      'Seller ID',
      'Legal Name',
      'Seller Type',
      'Business Domain',
      'Is Live',
      'ads.txt Status',
      'Ads Detected',
      'Best Email',
      'Fetched Emails',
      'Crawled At'
    ];

    setLoadingSellers(true);
    const queryParams = new URLSearchParams({
      companyDomain: selectedCompany,
      page: '1',
      limit: '100000',
      search: sellersSearch,
      domainStatus: sellersDomainFilter,
      adsTxtStatus: sellersAdsTxtFilter
    });

    fetch(`${API_URL}/api/sellers?${queryParams}`)
      .then(res => {
        if (!res.ok) throw new Error("Failed to export all records.");
        return res.json();
      })
      .then(data => {
        const rows = data.sellers.map((s: any) => {
          const emailsListStr = safeParseEmails(s.fetched_emails).join('; ');
          return [
            s.seller_id || '',
            s.name || '',
            s.seller_type || '',
            s.domain,
            s.domain_status || 'pending',
            s.ads_txt_status || 'pending',
            s.ads_detected || 'pending',
            s.best_email || '',
            emailsListStr,
            s.crawled_at || ''
          ];
        });

        const csvContent = [
          headers.join(','),
          ...rows.map((row: any) => row.map((val: any) => `"${val.replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `${selectedCompany}_sellers_export_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      })
      .catch(err => {
        alert(err.message || "Failed to export CSV.");
      })
      .finally(() => {
        setLoadingSellers(false);
      });
  };

  // Fetch company lists initially + auto-select first on load
  useEffect(() => {
    fetchCrawledCompanies();
  }, []);

  // Auto-select first crawled company when list loads and nothing is selected
  useEffect(() => {
    if (crawledCompanies.length > 0 && !selectedCompany) {
      const first = crawledCompanies[0];
      setSelectedCompany(first);
      setSellersPage(1);
      fetchSellers(first, 1, '', 'all', 'all');
    }
  }, [crawledCompanies]);

  // Poll active crawls for sellers
  useEffect(() => {
    let intervalId: any = null;
    if (sellersStats.crawling && selectedCompany) {
      intervalId = setInterval(() => {
        fetchSellers(selectedCompany, sellersPage);
      }, 3000);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [sellersStats.crawling, selectedCompany, sellersPage]);

  // Load sellers when filters or pagination changes
  useEffect(() => {
    if (selectedCompany) {
      fetchSellers(selectedCompany, sellersPage);
    }
  }, [selectedCompany, sellersPage, sellersDomainFilter, sellersAdsTxtFilter]);

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

  const fetchEmailStats = async () => {
    try {
      const response = await fetch(`${API_URL}/api/emails/stats`);
      if (response.ok) {
        const data = await response.json();
        setEmailStats(data);
      }
    } catch (e) {
      console.error('Error loading email stats:', e);
    }
  };

  const fetchEmailEvents = async (emailId: string) => {
    if (emailEvents[emailId]) {
      // Toggle off if already loaded
      setExpandedEmailId(prev => prev === emailId ? null : emailId);
      return;
    }
    setLoadingEvents(prev => ({ ...prev, [emailId]: true }));
    setExpandedEmailId(emailId);
    try {
      const response = await fetch(`${API_URL}/api/emails/${emailId}/events`);
      if (response.ok) {
        const data = await response.json();
        setEmailEvents(prev => ({ ...prev, [emailId]: data }));
      }
    } catch (e) {
      console.error('Error loading email events:', e);
    } finally {
      setLoadingEvents(prev => ({ ...prev, [emailId]: false }));
    }
  };

  const fetchSlackSettings = async () => {
    try {
      const response = await fetch(`${API_URL}/api/settings/slack`);
      if (response.ok) {
        const data = await response.json();
        setSlackSettings(data);
        setSlackBotToken(data.bot_token || '');
        setSlackChannel(data.channel || '#dockships-alerts');
        setSlackSigningSecret(data.signing_secret || '');
        setSlackWebhookUrl(data.webhook_url || '');
      }
    } catch (e) {
      console.error('Error loading Slack settings:', e);
    }
  };

  const fetchAgentStats = async () => {
    try {
      const response = await fetch(`${API_URL}/api/agent/stats`);
      if (response.ok) {
        const data = await response.json();
        setAgentStats(data);
      }
    } catch (e) {
      console.error('Error loading agent stats:', e);
    }
  };



  const fetchDrafts = async () => {
    setLoadingDrafts(true);
    try {
      const response = await fetch(`${API_URL}/api/drafts`);
      if (response.ok) {
        const data = await response.json();
        setDrafts(data);
      }
    } catch (e) {
      console.error('Error loading drafts:', e);
    } finally {
      setLoadingDrafts(false);
    }
  };

  const handleSaveDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftSubjectInput || !draftBodyInput) return;

    setSavingDraft(true);
    try {
      const response = await fetch(`${API_URL}/api/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedDraftForEdit?.id || undefined,
          subject: draftSubjectInput,
          body: draftBodyInput
        })
      });

      if (response.ok) {
        setDraftSubjectInput('');
        setDraftBodyInput('');
        setSelectedDraftForEdit(null);
        fetchDrafts();
      }
    } catch (err) {
      console.error('Failed to save draft:', err);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleDeleteDraft = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      const response = await fetch(`${API_URL}/api/drafts/${id}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        fetchDrafts();
        if (selectedDraftForEdit?.id === id) {
          setSelectedDraftForEdit(null);
          setDraftSubjectInput('');
          setDraftBodyInput('');
        }
      }
    } catch (err) {
      console.error('Error deleting draft:', err);
    }
  };

  const handleTemplateChangeForBulk = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const selected = drafts.find(d => d.id === templateId);
    if (selected) {
      setBulkSubject(selected.subject);
      setBulkBody(selected.body);
    } else {
      setBulkSubject('');
      setBulkBody('');
    }
  };

  const handleSendBulkOutreach = async (e: React.FormEvent) => {
    e.preventDefault();
    const selectedIds = Object.keys(selectedLeadIds).filter(id => selectedLeadIds[id]);
    if (selectedIds.length === 0) return;

    setBulkSending(true);
    setBulkError('');
    setBulkSuccess('');
    setBulkProgress({ current: 0, total: selectedIds.length });

    try {
      const response = await fetch(`${API_URL}/api/leads/bulk-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadIds: selectedIds,
          subject: bulkSubject,
          body: bulkBody,
          service: 'smtp', // Default to saved settings
          userId: user.id,
          disableTracking: disableBulkTracking
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Bulk outreach failed.');
      }

      const jobId = data.jobId;
      if (jobId) {
        const pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`${API_URL}/api/leads/bulk-email/status/${jobId}`);
            if (statusRes.ok) {
              const jobData = await statusRes.json();
              setBulkProgress({ current: jobData.current, total: jobData.total });
              
              if (jobData.status === 'completed') {
                clearInterval(pollInterval);
                setBulkSuccess(`Outreach complete! Succeeded: ${jobData.succeeded}, Failed: ${jobData.failed}.`);
                setSelectedLeadIds({});
                fetchLeads();
                setBulkSending(false);
                setTimeout(() => {
                  setShowBulkModal(false);
                  setBulkSuccess('');
                }, 3000);
              } else if (jobData.status === 'failed') {
                clearInterval(pollInterval);
                setBulkError(jobData.error || 'Background job processing failed.');
                setBulkSending(false);
              }
            } else {
              clearInterval(pollInterval);
              setBulkError('Failed to fetch sending progress.');
              setBulkSending(false);
            }
          } catch (pollErr: any) {
            clearInterval(pollInterval);
            setBulkError(pollErr.message || 'Error tracking progress.');
            setBulkSending(false);
          }
        }, 1500);
      } else {
        // Fallback for direct responses
        const succeeded = data.results?.filter((r: any) => r.success).length || 0;
        const failed = data.results?.filter((r: any) => !r.success).length || 0;
        setBulkSuccess(`Outreach complete! Succeeded: ${succeeded}, Failed: ${failed}.`);
        setSelectedLeadIds({});
        fetchLeads();
        setBulkSending(false);
        setTimeout(() => {
          setShowBulkModal(false);
          setBulkSuccess('');
        }, 3000);
      }
    } catch (err: any) {
      setBulkError(err.message || 'Connection error.');
      setBulkSending(false);
    }
  };

  const getBulkPreview = () => {
    const selectedIds = Object.keys(selectedLeadIds).filter(id => selectedLeadIds[id]);
    if (selectedIds.length === 0) return null;
    const firstLead = leads.find(l => l.id === selectedIds[0]);
    if (!firstLead) return null;

    const poc = firstLead.poc_name || 'Team';
    const previewSubject = bulkSubject
      .replace(/\{\{website\}\}/g, firstLead.website)
      .replace(/\{\{poc\}\}/g, poc);
    const previewBody = bulkBody
      .replace(/\{\{website\}\}/g, firstLead.website)
      .replace(/\{\{poc\}\}/g, poc);

    return {
      website: firstLead.website,
      poc,
      subject: previewSubject,
      body: previewBody
    };
  };

  // Populate first template in bulk form if drafts change
  useEffect(() => {
    if (drafts.length > 0 && !selectedTemplateId) {
      const first = drafts[0];
      setSelectedTemplateId(first.id);
      setBulkSubject(first.subject);
      setBulkBody(first.body);
    }
  }, [drafts, selectedTemplateId]);

  useEffect(() => {
    fetchLeads();
    fetchDrafts();
    fetchEmailStats();
    
    const interval = setInterval(() => {
      fetchLeads();
      fetchEmailStats();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval: any;

    if (activeTab === 'logs') {
      fetchLogs();
      fetchEmailStats();
      interval = setInterval(() => { fetchLogs(); fetchEmailStats(); }, 5000);
    } else if (activeTab === 'templates') {
      fetchDrafts();
    } else if (activeTab === 'agent') {
      fetchSlackSettings();
      fetchAgentStats();
    } else if (activeTab === 'sellers') {
      fetchCrawledCompanies();
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [activeTab]);

  const handleSaveSlackSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSlack(true);
    setSlackStatus({ success: '', error: '' });
    try {
      const response = await fetch(`${API_URL}/api/settings/slack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: slackBotToken,
          channel: slackChannel,
          signingSecret: slackSigningSecret,
          webhookUrl: slackWebhookUrl,
        })
      });
      const data = await response.json();
      if (response.ok) {
        setSlackStatus({ success: 'Slack settings saved!', error: '' });
        fetchSlackSettings();
      } else {
        setSlackStatus({ success: '', error: data.error || 'Failed to save.' });
      }
    } catch (err: any) {
      setSlackStatus({ success: '', error: err.message });
    } finally {
      setSavingSlack(false);
    }
  };

  const handleTestSlack = async () => {
    setTestingSlack(true);
    setSlackStatus({ success: '', error: '' });
    try {
      const response = await fetch(`${API_URL}/api/slack/test`, { method: 'POST' });
      const data = await response.json();
      if (response.ok) {
        setSlackStatus({ success: data.message || 'Test message sent!', error: '' });
      } else {
        setSlackStatus({ success: '', error: data.error || 'Test failed.' });
      }
    } catch (err: any) {
      setSlackStatus({ success: '', error: err.message });
    } finally {
      setTestingSlack(false);
    }
  };

  const handleRunAgent = async () => {
    setAgentRunning(true);
    setAgentMessage('');
    try {
      const response = await fetch(`${API_URL}/api/agent/run`, { method: 'POST' });
      const data = await response.json();
      if (response.ok) {
        setAgentMessage(data.message || 'Agent triggered!');
        setTimeout(() => fetchAgentStats(), 3000);
      } else {
        setAgentMessage(data.error || 'Agent trigger failed.');
      }
    } catch (err: any) {
      setAgentMessage(err.message);
    } finally {
      setAgentRunning(false);
    }
  };

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

  const handleSavePocName = async (leadId: string, pocName: string) => {
    try {
      const response = await fetch(`${API_URL}/api/leads/${leadId}/poc`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pocName })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update POC name.');
      }
      setLeads(prevLeads => prevLeads.map(l => l.id === leadId ? data : l));
      setEditingPocLeadId(null);
    } catch (err: any) {
      alert(err.message || 'Failed to update POC name.');
    }
  };

  const handleAddEmail = async (leadId: string, email: string) => {
    try {
      const response = await fetch(`${API_URL}/api/leads/${leadId}/emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to add email.');
      }
      setLeads(prevLeads => prevLeads.map(l => l.id === leadId ? data : l));
    } catch (err: any) {
      alert(err.message || 'Failed to add email.');
    }
  };

  const handleDeleteEmail = async (leadId: string, email: string) => {
    if (!window.confirm(`Are you sure you want to delete ${email}?`)) return;
    try {
      const response = await fetch(`${API_URL}/api/leads/${leadId}/emails`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete email.');
      }
      setLeads(prevLeads => prevLeads.map(l => l.id === leadId ? data : l));
    } catch (err: any) {
      alert(err.message || 'Failed to delete email.');
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



  // Stats
  const totalLeads = leads.length;
  const activeDomains = leads.filter(l => l.domain_status === 'pass').length;
  const emailsCollected = leads.reduce((acc, lead) => {
    const list = new Set([
      ...(lead.manual_email ? [lead.manual_email] : []),
      ...safeParseEmails(lead.fetched_emails)
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
        <nav className="app-nav">
          <button 
            className={`btn ${activeTab === 'leads' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('leads')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            🎯 Targets Dashboard
          </button>
          <button 
            className={`btn ${activeTab === 'templates' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('templates')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            📝 Draft Templates
          </button>
          <button 
            className={`btn ${activeTab === 'logs' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('logs')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            📋 Outreach Logs
          </button>

          <button 
            className={`btn ${activeTab === 'agent' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('agent')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', position: 'relative' }}
          >
            🤖 Agent
            {slackSettings?.configured && (
              <span style={{ position: 'absolute', top: '-4px', right: '-4px', width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', border: '2px solid var(--bg-surface)' }} />
            )}
          </button>
          <button 
            className={`btn ${activeTab === 'sellers' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('sellers')}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            🔍 Sellers.json Crawler
          </button>
          <button 
            className={`btn ${activeTab === 'mailmerge' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setActiveTab('mailmerge'); fetchDrafts(); }}
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            ✉️ Mail Merge
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
          <main style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
            {/* Stats */}
            <div className="stat-card-container">
              <div className="glass-panel stat-card">
                <div className="stat-value">{totalLeads}</div>
                <div className="stat-label">Total Leads</div>
              </div>
              <div className="glass-panel stat-card">
                <div className="stat-value" style={{ color: 'var(--success)' }}>{activeDomains}</div>
                <div className="stat-label">Active Sites</div>
              </div>
              <div className="glass-panel stat-card">
                <div className="stat-value" style={{ color: 'var(--primary)' }}>{emailsCollected}</div>
                <div className="stat-label">Emails</div>
              </div>
            </div>

            {/* Leads List */}
            <div className="glass-panel leads-list">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
                <h2 className="card-title" style={{ margin: 0 }}>Active Targets Tracker</h2>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  {selectedCount > 0 && (
                    <>
                      <button 
                        className="btn btn-primary animate-fade" 
                        onClick={() => setShowBulkModal(true)}
                        style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
                      >
                        ✉️ Bulk Outreach ({selectedCount})
                      </button>
                      <button 
                        className="btn btn-danger animate-fade" 
                        onClick={handleBulkDelete}
                        style={{ padding: '0.45rem 1rem', fontSize: '0.85rem', background: '#ef4444', borderColor: '#ef4444' }}
                      >
                        🗑️ Delete Selected ({selectedCount})
                      </button>
                    </>
                  )}
                  <button className="btn btn-secondary" onClick={fetchLeads} disabled={loadingLeads} style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}>
                    Refresh
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleExportLeadsCSV} 
                    disabled={leads.length === 0} 
                    style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
                    title="Export all/filtered target leads to CSV"
                  >
                    📥 Export CSV
                  </button>
                </div>
              </div>

              {/* TOP FILTERS BAR */}
              {leads.length > 0 && (
                <div style={{
                  display: 'flex',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  padding: '1rem',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  marginBottom: '1.5rem',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)' }}>Filters:</span>
                  
                  {/* Domain Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Domain Status</label>
                    <select 
                      value={domainFilter} 
                      onChange={(e: any) => setDomainFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '130px', height: '30px' }}
                    >
                      <option value="all">All Domains</option>
                      <option value="pass">Pass</option>
                      <option value="failed">Failed</option>
                    </select>
                  </div>

                  {/* ads.txt Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ads.txt Status</label>
                    <select 
                      value={adsTxtFilter} 
                      onChange={(e: any) => setAdsTxtFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '140px', height: '30px' }}
                    >
                      <option value="all">All ads.txt</option>
                      <option value="present">Present</option>
                      <option value="not present">Not Present</option>
                    </select>
                  </div>

                  {/* Ads Detected Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Ads Appearing</label>
                    <select 
                      value={adsFilter} 
                      onChange={(e: any) => setAdsFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '120px', height: '30px' }}
                    >
                      <option value="all">All Ads</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </div>

                  {/* Contact Info Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Contact Info</label>
                    <select 
                      value={contactFilter} 
                      onChange={(e: any) => setContactFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '180px', height: '30px' }}
                    >
                      <option value="all">All Contact Info</option>
                      <option value="email found">Email Found</option>
                      <option value="contact form available">Contact Form Available</option>
                      <option value="none">None</option>
                    </select>
                  </div>

                  {/* LinkedIn Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>LinkedIn</label>
                    <select 
                      value={linkedinFilter} 
                      onChange={(e: any) => setLinkedinFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '130px', height: '30px' }}
                    >
                      <option value="all">All LinkedIn</option>
                      <option value="working">Working Link</option>
                      <option value="none">None</option>
                    </select>
                  </div>

                  {/* Sellers.json Company Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sellers.json Company</label>
                    <select 
                      value={sellersCompanyFilter} 
                      onChange={(e: any) => setSellersCompanyFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '180px', height: '30px' }}
                    >
                      <option value="all">All Companies</option>
                      {crawledCompanies.map((company) => (
                        <option key={company} value={company}>
                          {company}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Email ID Live Status Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Email ID Live Status</label>
                    <select 
                      value={emailValidationFilter} 
                      onChange={(e: any) => setEmailValidationFilter(e.target.value)}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '150px', height: '30px' }}
                    >
                      <option value="all">All Statuses</option>
                      <option value="valid">Valid</option>
                      <option value="pending">Pending</option>
                    </select>
                  </div>

                  {/* Clear Button */}
                  {(domainFilter !== 'all' || adsTxtFilter !== 'all' || adsFilter !== 'all' || contactFilter !== 'all' || linkedinFilter !== 'all' || sellersCompanyFilter !== 'all' || emailValidationFilter !== 'all') && (
                    <button 
                      onClick={() => {
                        setDomainFilter('all');
                        setAdsTxtFilter('all');
                        setAdsFilter('all');
                        setContactFilter('all');
                        setLinkedinFilter('all');
                        setSellersCompanyFilter('all');
                        setEmailValidationFilter('all');
                      }}
                      className="btn btn-secondary"
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', height: '30px', alignSelf: 'flex-end' }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              )}

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
              ) : (() => {
                const filteredLeads = leads.filter(lead => {
                  if (domainFilter !== 'all' && lead.domain_status !== domainFilter) return false;
                  if (adsTxtFilter !== 'all' && lead.ads_txt_status !== adsTxtFilter) return false;
                  if (adsFilter !== 'all') {
                    const hasAds = lead.ads_detected && lead.ads_detected.toLowerCase().startsWith('yes');
                    if (adsFilter === 'yes' && !hasAds) return false;
                    if (adsFilter === 'no' && hasAds) return false;
                  }
                  if (contactFilter !== 'all' && lead.contact_form_status !== contactFilter) return false;
                  if (linkedinFilter !== 'all' && lead.linkedin_status !== linkedinFilter) return false;
                  
                  // Sellers Company Filter
                  if (sellersCompanyFilter !== 'all') {
                    const companies = lead.sellers_companies
                      ? lead.sellers_companies.split(',').map((c: string) => c.trim().toLowerCase())
                      : [];
                    if (!companies.includes(sellersCompanyFilter.toLowerCase())) return false;
                  }

                  // Email ID Live Status Filter
                  if (emailValidationFilter !== 'all') {
                    const validationStatus = lead.email_validation_status || 'pending';
                    if (validationStatus !== emailValidationFilter) return false;
                  }

                  return true;
                });

                if (filteredLeads.length === 0) {
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '200px', color: 'var(--text-muted)' }}>
                      <span>🔍</span>
                      <p style={{ marginTop: '0.5rem' }}>No targets match the active filters.</p>
                    </div>
                  );
                }

                return (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: '40px' }}>
                            <input 
                              type="checkbox"
                              checked={filteredLeads.length > 0 && filteredLeads.every(l => selectedLeadIds[l.id])}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                const newSelected: Record<string, boolean> = { ...selectedLeadIds };
                                filteredLeads.forEach(l => {
                                  if (checked) {
                                    newSelected[l.id] = true;
                                  } else {
                                    delete newSelected[l.id];
                                  }
                                });
                                setSelectedLeadIds(newSelected);
                              }}
                            />
                          </th>
                          <th>Website Domain</th>
                          <th>POC Name</th>
                          <th>Domain Status</th>
                          <th>ads.txt</th>
                          <th>Ads Appearing</th>
                          <th>Contact Info</th>
                          <th>Email ID Live Status</th>
                          <th>LinkedIn</th>
                          <th>Status / Outreach</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLeads.map((lead) => {
                          const emailsList = Array.from(new Set([
                            ...(lead.manual_email ? [lead.manual_email] : []),
                            ...safeParseEmails(lead.fetched_emails)
                          ]));
                          const isCrawling = crawlingIds[lead.id];

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
                                  className="lead-link"
                                >
                                  {lead.website} <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>↗</span>
                                </a>
                              </td>
                              <td>
                                {editingPocLeadId === lead.id ? (
                                  <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                                    <input
                                      type="text"
                                      value={pocNameEditVal}
                                      onChange={(e) => setPocNameEditVal(e.target.value)}
                                      className="form-control"
                                      style={{
                                        fontSize: '0.8rem',
                                        padding: '0.2rem 0.4rem',
                                        width: '120px',
                                        height: 'auto',
                                        background: 'var(--input-bg)',
                                        border: '1px solid var(--input-border)',
                                        color: 'var(--input-color)',
                                        borderRadius: '4px'
                                      }}
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          handleSavePocName(lead.id, pocNameEditVal);
                                        } else if (e.key === 'Escape') {
                                          setEditingPocLeadId(null);
                                        }
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                                      onClick={() => handleSavePocName(lead.id, pocNameEditVal)}
                                      title="Save"
                                    >
                                      ✓
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                                      onClick={() => setEditingPocLeadId(null)}
                                      title="Cancel"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ) : (
                                  <div 
                                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}
                                    onClick={() => {
                                      setEditingPocLeadId(lead.id);
                                      setPocNameEditVal(lead.poc_name || '');
                                    }}
                                    title="Click to edit POC name"
                                  >
                                    {lead.poc_name ? (
                                      <span style={{ color: 'var(--text-bright)', fontWeight: 500 }}>{lead.poc_name}</span>
                                    ) : (
                                      <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>Click to enter</span>
                                    )}
                                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>✏️</span>
                                  </div>
                                )}
                              </td>
                              
                              {/* Domain Status */}
                              <td>
                                {lead.domain_status === 'pass' ? (
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
                                    Pass
                                  </span>
                                ) : lead.domain_status === 'failed' ? (
                                  <span className="badge badge-danger">Failed</span>
                                ) : (
                                  <span className="badge badge-secondary">Pending</span>
                                )}
                              </td>

                              {/* ads.txt */}
                              <td>
                                {lead.ads_txt_status === 'present' ? (
                                  <span className="badge badge-success">Present</span>
                                ) : lead.ads_txt_status === 'not present' ? (
                                  <span className="badge badge-secondary">Not Present</span>
                                ) : (
                                  <span className="badge badge-secondary">Pending</span>
                                )}
                              </td>

                              {/* Ads Appearing */}
                              <td>
                                {lead.ads_detected && lead.ads_detected !== 'none' && lead.ads_detected !== 'no' && lead.ads_detected !== 'pending' ? (
                                  <span className="badge badge-primary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.5rem', whiteSpace: 'normal', maxWidth: '180px', display: 'inline-block', textAlign: 'left' }}>
                                    {lead.ads_detected}
                                  </span>
                                ) : lead.ads_detected === 'no' || lead.ads_detected === 'none' ? (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No</span>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>Pending</span>
                                )}
                              </td>

                              {/* Contact Info */}
                              <td>
                                {lead.best_email && (
                                  <div style={{ marginBottom: '0.35rem' }}>
                                    <span style={{ fontSize: '0.72rem', color: '#22c55e', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '4px', padding: '0.15rem 0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                      ✅ <strong>{lead.best_email}</strong>
                                    </span>
                                  </div>
                                )}
                                
                                <div style={{ marginBottom: '0.35rem' }}>
                                  {lead.contact_form_status === 'email found' ? (
                                    <span className="badge badge-success">Email Found</span>
                                  ) : lead.contact_form_status === 'contact form available' ? (
                                    <span className="badge badge-info">Form Available</span>
                                  ) : lead.contact_form_status === 'none' ? (
                                    <span className="badge badge-secondary">None</span>
                                  ) : (
                                    <span className="badge badge-secondary">Pending</span>
                                  )}
                                </div>

                                <div className="email-tags">
                                  {emailsList.length > 0 && (
                                    emailsList.map((email) => {
                                      const isManual = email === lead.manual_email;
                                      const isBest = email === lead.best_email;
                                      return (
                                        <span 
                                          key={email} 
                                          className="email-tag" 
                                          style={{ 
                                            display: 'inline-flex', 
                                            alignItems: 'center', 
                                            gap: '0.25rem',
                                            background: isManual ? 'rgba(16, 185, 129, 0.1)' : isBest ? 'rgba(34,197,94,0.08)' : 'rgba(99, 102, 241, 0.1)', 
                                            borderColor: isManual ? 'rgba(16, 185, 129, 0.2)' : isBest ? 'rgba(34,197,94,0.2)' : 'rgba(99, 102, 241, 0.2)' 
                                          }}
                                        >
                                          {email} {isManual && <small style={{ opacity: 0.7 }}>(man)</small>}
                                          <button
                                            type="button"
                                            onClick={() => handleDeleteEmail(lead.id, email)}
                                            style={{
                                              background: 'none',
                                              border: 'none',
                                              color: 'rgba(239, 68, 68, 0.8)',
                                              cursor: 'pointer',
                                              padding: '0 2px',
                                              fontSize: '0.9rem',
                                              marginLeft: '2px',
                                              lineHeight: 1,
                                              fontWeight: 'bold',
                                              display: 'inline-flex',
                                              alignItems: 'center',
                                              justifyContent: 'center',
                                              height: '14px',
                                              width: '14px',
                                              borderRadius: '50%'
                                            }}
                                            title="Delete email"
                                          >
                                            &times;
                                          </button>
                                        </span>
                                      );
                                    })
                                  )}
                                </div>
                                <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                                  <input
                                    type="email"
                                    placeholder="Add email..."
                                    style={{
                                      fontSize: '0.75rem',
                                      padding: '0.2rem 0.4rem',
                                      background: 'var(--input-bg)',
                                      border: '1px solid var(--input-border)',
                                      borderRadius: '4px',
                                      color: 'var(--input-color)',
                                      width: '130px',
                                      height: '24px'
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        const target = e.currentTarget;
                                        const val = target.value.trim();
                                        if (val) {
                                          handleAddEmail(lead.id, val);
                                          target.value = '';
                                        }
                                      }
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                    onClick={(e) => {
                                      const parent = e.currentTarget.parentElement;
                                      if (parent) {
                                        const input = parent.querySelector('input') as HTMLInputElement;
                                        const val = input.value.trim();
                                        if (val) {
                                          handleAddEmail(lead.id, val);
                                          input.value = '';
                                        }
                                      }
                                    }}
                                  >
                                    +
                                  </button>
                                </div>
                              </td>

                              {/* Email ID Live Status */}
                              <td>
                                {lead.email_validation_status === 'valid' ? (
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
                                    Valid
                                  </span>
                                ) : (
                                  <span className="badge badge-secondary">Pending</span>
                                )}
                              </td>

                              {/* LinkedIn */}
                              <td>
                                {lead.linkedin_status === 'working' ? (
                                  <span className="badge badge-info">Working</span>
                                ) : lead.linkedin_status === 'none' ? (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>None</span>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>Pending</span>
                                )}
                              </td>

                              {/* Outreach Status */}
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
                                    title="Run email crawl check"
                                  >
                                    {isCrawling ? 'Crawling...' : 'Crawl'}
                                  </button>
                                  <button
                                    className="btn btn-primary"
                                    style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
                                    disabled={emailsList.length === 0 || lead.domain_status !== 'pass'}
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
                );
              })()}
            </div>
          </main>
        </div>
      )}

      {/* Agent Tab */}
      {activeTab === 'agent' && (
        <main style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 className="card-title" style={{ marginBottom: '0.25rem' }}>🤖 Dockships Agent</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Daily system health checks, analytics reports to Slack, and control via reply commands.</p>
            </div>
            <button
              className="btn btn-primary"
              onClick={handleRunAgent}
              disabled={agentRunning}
              style={{ padding: '0.6rem 1.4rem', fontSize: '0.9rem' }}
            >
              {agentRunning ? '⏳ Running...' : '▶ Run Agent Now'}
            </button>
          </div>
          {agentMessage && (
            <div style={{ padding: '0.8rem 1rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '8px', fontSize: '0.9rem', color: '#a5b4fc' }}>
              ✅ {agentMessage}
            </div>
          )}

          {/* System Stats Snapshot */}
          {agentStats && (
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-bright)' }}>📊 System Snapshot</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
                {[
                  { label: 'Total Leads', value: agentStats.totalLeads, color: '#6366f1' },
                  { label: 'Active Leads', value: agentStats.activeLeads, color: '#22c55e' },
                  { label: 'Pending Crawl', value: agentStats.pendingLeads, color: '#f59e0b' },
                  { label: 'Emails Sent', value: agentStats.totalEmailsSent, color: '#3b82f6' },
                  { label: 'Sent (24h)', value: agentStats.recentlySent, color: '#8b5cf6' },
                  { label: 'Bounced', value: agentStats.bouncedEmails, color: '#ef4444' },
                  { label: 'Open Rate', value: `${agentStats.openRate?.toFixed(1)}%`, color: '#10b981' },
                  { label: 'Reply Rate', value: `${agentStats.replyRate?.toFixed(1)}%`, color: '#06b6d4' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '1rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.6rem', fontWeight: 700, color }}>{value}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                <div style={{ padding: '0.6rem 1rem', borderRadius: '8px', background: agentStats.crawlerHealth === 'healthy' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${agentStats.crawlerHealth === 'healthy' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, fontSize: '0.85rem' }}>
                  {agentStats.crawlerHealth === 'healthy' ? '✅' : '⚠️'} Crawler: <strong>{agentStats.crawlerHealth}</strong>
                </div>
                <div style={{ padding: '0.6rem 1rem', borderRadius: '8px', background: agentStats.emailServiceHealth === 'healthy' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${agentStats.emailServiceHealth === 'healthy' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, fontSize: '0.85rem' }}>
                  {agentStats.emailServiceHealth === 'healthy' ? '✅' : '⚠️'} Email Service: <strong>{agentStats.emailServiceHealth}</strong>
                </div>
              </div>
            </div>
          )}

          {/* Slack Configuration */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                🔔 Slack Integration
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: slackSettings?.configured ? '#22c55e' : '#6b7280', display: 'inline-block' }} />
                {slackSettings?.configured ? 'Connected' : 'Not configured'}
              </div>
            </div>
            <form onSubmit={handleSaveSlackSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Bot Token (xoxb-...)</label>
                  <input
                    className="input-field"
                    type="password"
                    placeholder="xoxb-your-slack-bot-token"
                    value={slackBotToken}
                    onChange={e => setSlackBotToken(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Channel</label>
                  <input
                    className="input-field"
                    type="text"
                    placeholder="#dockships-alerts"
                    value={slackChannel}
                    onChange={e => setSlackChannel(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Signing Secret (optional)</label>
                  <input
                    className="input-field"
                    type="password"
                    placeholder="Slack app signing secret"
                    value={slackSigningSecret}
                    onChange={e => setSlackSigningSecret(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Incoming Webhook URL (alternative)</label>
                  <input
                    className="input-field"
                    type="text"
                    placeholder="https://hooks.slack.com/services/..."
                    value={slackWebhookUrl}
                    onChange={e => setSlackWebhookUrl(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
              {slackStatus.success && <div style={{ color: '#22c55e', fontSize: '0.85rem' }}>✅ {slackStatus.success}</div>}
              {slackStatus.error && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>❌ {slackStatus.error}</div>}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button type="submit" className="btn btn-primary" disabled={savingSlack}>
                  {savingSlack ? 'Saving...' : '💾 Save Slack Settings'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleTestSlack} disabled={testingSlack || (!slackSettings?.configured)}>
                  {testingSlack ? 'Sending...' : '📨 Send Test Message'}
                </button>
              </div>
            </form>
            <div style={{ marginTop: '1.25rem', padding: '1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text-bright)' }}>Webhook URL for your Slack app:</strong>
              <code style={{ display: 'block', marginTop: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.4rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem' }}>
                POST {window.location.origin.replace(':5173', ':4001')}/api/slack/webhook
              </code>
              <p style={{ marginTop: '0.5rem' }}>Configure this URL in your Slack app's <em>Interactivity & Shortcuts</em> and <em>Slash Commands</em> settings.</p>
            </div>
          </div>

          {/* Commands Reference */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-bright)' }}>💬 Available Slack Commands</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
              {[
                { cmd: 'status', desc: 'System health check — DB, crawler, email service' },
                { cmd: 'report', desc: 'Trigger an immediate analytics report' },
                { cmd: 'leads', desc: 'List top 10 most recent leads' },
                { cmd: 'emails', desc: 'Email stats — open, click, bounce, reply rates' },
                { cmd: 'pause', desc: 'Note to pause outbound email sending' },
                { cmd: 'resume', desc: 'Resume outbound email sending' },
                { cmd: 'recrawl', desc: 'Re-crawl all stuck pending leads' },
                { cmd: 'help', desc: 'Show all available commands' },
              ].map(({ cmd, desc }) => (
                <div key={cmd} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                  <code style={{ fontSize: '0.8rem', color: '#818cf8', background: 'rgba(99,102,241,0.15)', padding: '0.2rem 0.4rem', borderRadius: '4px', whiteSpace: 'nowrap' }}>{cmd}</code>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{desc}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
              📅 The agent runs automatically every day at <strong>9:00 AM</strong> and posts a full analytics report. You can also click <strong>▶ Run Agent Now</strong> above to trigger it immediately.
            </p>
          </div>
        </main>
      )}

      {/* Outreach Logs Tab */}
      {activeTab === 'logs' && (
        <main className="glass-panel" style={{ padding: '2rem', minHeight: '450px' }}>
          <h2 className="card-title">Outreach Communication Logs & Email Activity</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
            Track opens, clicks, delivery states, and replies automatically. Override statuses manually or trigger simulation events.
          </p>

          {/* Email Stats Cards */}
          {emailStats && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {[
                { label: 'Total Sent', value: emailStats.total, color: '#6366f1', icon: '📬' },
                { label: 'Delivered', value: emailStats.delivered, color: '#3b82f6', icon: '📩' },
                { label: 'Opened', value: emailStats.opened, color: '#10b981', icon: '👁' },
                { label: 'Clicked', value: emailStats.clicked, color: '#8b5cf6', icon: '🖱' },
                { label: 'Replied', value: emailStats.replied, color: '#06b6d4', icon: '↩️' },
                { label: 'Bounced', value: emailStats.bounced, color: '#ef4444', icon: '⛔' },
              ].map(({ label, value, color, icon }) => (
                <div key={label} style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${color}33`, borderRadius: '10px', padding: '0.85rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.1rem', marginBottom: '0.2rem' }}>{icon}</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{value}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{label}</div>
                </div>
              ))}
            </div>
          )}
          {emailStats && emailStats.total > 0 && (
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
              {[
                { label: 'Open Rate', value: emailStats.openRate, color: '#10b981' },
                { label: 'Click Rate', value: emailStats.clickRate, color: '#8b5cf6' },
                { label: 'Reply Rate', value: emailStats.replyRate, color: '#06b6d4' },
                { label: 'Bounce Rate', value: emailStats.bounceRate, color: '#ef4444' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem' }}>
                  <div style={{ width: '80px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(value, 100)}%`, background: color, borderRadius: '3px' }} />
                  </div>
                  <span style={{ color: 'var(--text-muted)' }}>{label}:</span>
                  <span style={{ color, fontWeight: 600 }}>{value.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}

          {/* Filter bar */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            {(['all', 'sent', 'delivered', 'opened', 'clicked', 'reverted', 'bounced'] as const).map(f => (
              <button
                key={f}
                className={`btn ${logsFilter === f ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setLogsFilter(f)}
                style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem', textTransform: 'capitalize' }}
              >
                {f === 'reverted' ? 'Replied' : f}
                {emailStats && f !== 'all' && (
                  <span style={{ marginLeft: '0.3rem', opacity: 0.7 }}>
                    ({f === 'sent' ? emailStats.total - emailStats.delivered - emailStats.bounced
                      : f === 'delivered' ? emailStats.delivered
                      : f === 'opened' ? emailStats.opened
                      : f === 'clicked' ? emailStats.clicked
                      : f === 'reverted' ? emailStats.replied
                      : emailStats.bounced})
                  </span>
                )}
              </button>
            ))}
          </div>

          {loadingLogs ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              Retrieving logs...
            </div>
          ) : emailLogs.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
              <span>✉️</span>
              <p style={{ marginTop: '0.5rem' }}>No outreach emails dispatched yet.</p>
            </div>
          ) : (() => {
            const filteredLogs = logsFilter === 'all'
              ? emailLogs
              : emailLogs.filter(l => l.status === logsFilter);
            return filteredLogs.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                No emails with status "{logsFilter}" found.
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Sent At</th>
                      <th>Recipient</th>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Replies</th>
                      <th>Simulators</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((log) => (
                      <React.Fragment key={log.id}>
                        <tr
                          onClick={() => fetchEmailEvents(log.id)}
                          style={{ cursor: 'pointer' }}
                          title="Click to view event timeline"
                        >
                          <td>{new Date(log.sent_at).toLocaleString()}</td>
                          <td style={{ fontWeight: 600 }}>
                            <div>{log.recipient_email}</div>
                            {log.bounce_reason && (
                              <div style={{ fontSize: '0.72rem', color: '#ef4444', marginTop: '0.1rem' }}>⛔ {log.bounce_reason}</div>
                            )}
                          </td>
                          <td>{log.subject}</td>
                          <td>
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
                          </td>
                          <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                            {log.reply_count || 0}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={(e) => { e.stopPropagation(); handleSimulateReply(log.recipient_email); }}
                                title="Simulate recipient replying to this email"
                              >
                                💬 Reply
                              </button>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: 'var(--danger)' }}
                                onClick={(e) => { e.stopPropagation(); handleSimulateBounce(log.recipient_email); }}
                                title="Simulate permanent bounce event"
                              >
                                🚫 Bounce
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedEmailId === log.id && (
                          <tr>
                            <td colSpan={6} style={{ padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.2)' }}>
                              {loadingEvents[log.id] ? (
                                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading event timeline...</span>
                              ) : (emailEvents[log.id] || []).length === 0 ? (
                                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>No events recorded yet for this email.</span>
                              ) : (
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                  {(emailEvents[log.id] || []).map((ev, i) => (
                                    <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                                      <span style={{ color: ev.event_type === 'bounced' ? '#ef4444' : ev.event_type === 'reverted' ? '#22c55e' : ev.event_type === 'clicked' ? '#8b5cf6' : ev.event_type === 'opened' ? '#10b981' : '#6366f1' }}>
                                        {{sent:'📤',delivered:'📩',opened:'👁',clicked:'🖱',reverted:'↩️',bounced:'⛔'}[ev.event_type] || '•'} {ev.event_type}
                                      </span>
                                      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{new Date(ev.event_time).toLocaleTimeString()}</span>
                                      {i < (emailEvents[log.id] || []).length - 1 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </main>
      )}



      {/* Draft Templates Tab */}
      {activeTab === 'templates' && (
        <main className="glass-panel" style={{ padding: '2rem', minHeight: '450px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>📝 Draft Email Templates</h2>
            <button 
              className="btn btn-primary"
              onClick={() => {
                setSelectedDraftForEdit(null);
                setDraftSubjectInput('');
                setDraftBodyInput('');
              }}
            >
              ➕ Create New Template
            </button>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
            Create and save email draft templates for your target website outreach campaigns. You can use dynamic placeholders 
            like <code>{"{{website}}"}</code> for the target domain and <code>{"{{poc}}"}</code> for the point of contact name.
          </p>

          <div className="templates-grid">
            {/* Sidebar list of templates */}
            <div className="glass-panel" style={{ padding: '1rem', height: 'fit-content' }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '1rem', fontWeight: 600 }}>Saved Templates</h3>
              {loadingDrafts && drafts.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading templates...</div>
              ) : drafts.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>No templates saved.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {drafts.map(d => (
                    <div 
                      key={d.id} 
                      style={{ 
                        padding: '0.75rem', 
                        borderRadius: '8px', 
                        background: selectedDraftForEdit?.id === d.id ? 'var(--primary-glow)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${selectedDraftForEdit?.id === d.id ? 'var(--primary)' : 'var(--card-border)'}`,
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                      onClick={() => {
                        setSelectedDraftForEdit(d);
                        setDraftSubjectInput(d.subject);
                        setDraftBodyInput(d.body);
                      }}
                    >
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                        <strong style={{ fontSize: '0.85rem', color: 'var(--text-bright)' }}>{d.subject}</strong>
                      </div>
                      <button 
                        className="btn btn-danger" 
                        style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem', background: '#ef4444', borderColor: '#ef4444' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteDraft(d.id);
                        }}
                      >
                        🗑️
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Template Editor */}
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '1.25rem', fontWeight: 700 }}>
                {selectedDraftForEdit ? 'Edit Template' : 'New Template'}
              </h3>
              <form onSubmit={handleSaveDraft}>
                <div className="form-group">
                  <label className="form-label" htmlFor="draft-subject">Email Subject</label>
                  <input
                    id="draft-subject"
                    type="text"
                    className="form-control"
                    placeholder="e.g. Partnership Proposal for {{website}}"
                    value={draftSubjectInput}
                    onChange={(e) => setDraftSubjectInput(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="draft-body">Email Body (HTML format)</label>
                  <textarea
                    id="draft-body"
                    className="form-control"
                    style={{ minHeight: '220px', resize: 'vertical' }}
                    placeholder="<p>Hello {{poc}},</p>..."
                    value={draftBodyInput}
                    onChange={(e) => setDraftBodyInput(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
                  {selectedDraftForEdit && (
                    <button 
                      type="button" 
                      className="btn btn-secondary" 
                      onClick={() => {
                        setSelectedDraftForEdit(null);
                        setDraftSubjectInput('');
                        setDraftBodyInput('');
                      }}
                    >
                      Cancel Edit
                    </button>
                  )}
                  <button type="submit" className="btn btn-primary" disabled={savingDraft}>
                    {savingDraft ? 'Saving...' : 'Save Template'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </main>
      )}

      {/* Sellers.json Crawler Tab */}
      {activeTab === 'sellers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', width: '100%' }} className="animate-fade">
          {/* Top Bar for Fetch & Select Company */}
          <div className="glass-panel" style={{ padding: '1.5rem 2rem' }}>
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              
              {/* Fetch Form */}
              <form onSubmit={handleFetchSellersJson} style={{ flex: '1 1 350px' }}>
                <h3 className="card-title" style={{ fontSize: '1.05rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.75rem' }}>
                  Fetch New Company Sellers.json
                </h3>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Enter company website (e.g. pubmatic.com)"
                    value={companyInput}
                    onChange={(e) => setCompanyInput(e.target.value)}
                    disabled={fetchingSellers}
                    required
                  />
                  <button 
                    type="submit" 
                    className="btn btn-primary"
                    disabled={fetchingSellers || !companyInput.trim()}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {fetchingSellers ? 'Fetching...' : '🔍 Fetch Sellers'}
                  </button>
                </div>
              </form>

              {/* Company Selector */}
              {crawledCompanies.length > 0 && (
                <div style={{ flex: '1 1 250px' }}>
                  <h3 className="card-title" style={{ fontSize: '1.05rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.75rem' }}>
                    Select Crawled Company
                  </h3>
                  <select
                    className="form-control"
                    value={selectedCompany}
                    onChange={(e) => {
                      setSelectedCompany(e.target.value);
                      setSellersPage(1);
                      setSellersSearch('');
                      setSellersDomainFilter('all');
                      setSellersAdsTxtFilter('all');
                    }}
                    style={{ height: '46px' }}
                  >
                    <option value="">-- Choose a Company --</option>
                    {crawledCompanies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}

            </div>
          </div>

          {selectedCompany ? (
            <main style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
              
              {/* Stats Card Section */}
              <div className="stat-card-container">
                <div className="glass-panel stat-card" style={{ position: 'relative' }}>
                  <div className="stat-value">{sellersStats.total}</div>
                  <div className="stat-label">Total Sellers</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-value" style={{ color: 'var(--success)' }}>
                    {sellersStats.live}
                  </div>
                  <div className="stat-label">Live Sites</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-value" style={{ color: 'var(--primary)' }}>
                    {sellersStats.adsTxtPresent}
                  </div>
                  <div className="stat-label">ads.txt Present</div>
                </div>
              </div>

              {/* Progress and Crawler Status Controls */}
              <div className="glass-panel" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-bright)' }}>
                      Crawler Progress for <span style={{ color: 'var(--primary)' }}>{selectedCompany}</span>
                    </h3>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      Crawled: {sellersStats.total - sellersStats.pending} / {sellersStats.total} ({sellersStats.total > 0 ? Math.round(((sellersStats.total - sellersStats.pending) / sellersStats.total) * 100) : 0}%)
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    {sellersStats.crawling ? (
                      <button className="btn btn-secondary" onClick={handleStopCrawlSellers} style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>
                        ⏸️ Pause Crawling
                      </button>
                    ) : (
                      <button className="btn btn-primary" onClick={handleCrawlSellers} disabled={sellersStats.pending === 0}>
                        ▶️ {sellersStats.pending === sellersStats.total ? 'Start Crawling' : 'Resume Crawling'}
                      </button>
                    )}
                    <button className="btn btn-danger" onClick={handleClearSellers} style={{ background: '#ef4444', borderColor: '#ef4444' }}>
                      🗑️ Delete Data
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div style={{ height: '10px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '6px', overflow: 'hidden', width: '100%' }}>
                  <div 
                    className="progress-bar-fill"
                    style={{
                      height: '100%',
                      width: `${sellersStats.total > 0 ? ((sellersStats.total - sellersStats.pending) / sellersStats.total) * 100 : 0}%`,
                      background: 'linear-gradient(90deg, var(--primary) 0%, var(--success) 100%)',
                      transition: 'width 0.5s ease',
                      boxShadow: '0 0 10px var(--primary-glow)'
                    }}
                  />
                </div>
              </div>

              {/* Sellers List */}
              <div className="glass-panel" style={{ padding: '1.5rem' }}>
                
                {/* Header Actions */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
                  <h2 className="card-title" style={{ margin: 0 }}>Sellers Directory</h2>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <button className="btn btn-secondary" onClick={() => fetchSellers(selectedCompany, sellersPage)} disabled={loadingSellers} style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}>
                      Refresh
                    </button>
                    <button className="btn btn-secondary" onClick={handleExportSellersCSV} disabled={sellers.length === 0} style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}>
                      📥 Export CSV
                    </button>
                  </div>
                </div>

                {/* Filters */}
                <div style={{
                  display: 'flex',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  padding: '1rem',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  marginBottom: '1.5rem',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)' }}>Filters:</span>

                  {/* Search Input */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1 1 200px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Search Domain or Name</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input 
                        type="text" 
                        placeholder="Search..."
                        className="form-control" 
                        value={sellersSearch} 
                        onChange={(e) => setSellersSearch(e.target.value)}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', height: '30px' }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setSellersPage(1);
                            fetchSellers(selectedCompany, 1);
                          }
                        }}
                      />
                      <button 
                        className="btn btn-secondary"
                        onClick={() => {
                          setSellersPage(1);
                          fetchSellers(selectedCompany, 1);
                        }}
                        style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', height: '30px' }}
                      >
                        Find
                      </button>
                    </div>
                  </div>

                  {/* Domain Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Is Live (Domain)</label>
                    <select 
                      value={sellersDomainFilter} 
                      onChange={(e) => {
                        setSellersDomainFilter(e.target.value);
                        setSellersPage(1);
                      }}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '130px', height: '30px' }}
                    >
                      <option value="all">All Domains</option>
                      <option value="pass">Live Only</option>
                      <option value="failed">Failed Only</option>
                      <option value="pending">Pending Only</option>
                    </select>
                  </div>

                  {/* ads.txt Filter */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ads.txt Status</label>
                    <select 
                      value={sellersAdsTxtFilter} 
                      onChange={(e) => {
                        setSellersAdsTxtFilter(e.target.value);
                        setSellersPage(1);
                      }}
                      className="form-control"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', width: '140px', height: '30px' }}
                    >
                      <option value="all">All ads.txt</option>
                      <option value="present">Present</option>
                      <option value="not present">Not Present</option>
                      <option value="pending">Pending</option>
                    </select>
                  </div>

                  {/* Clear Button */}
                  {(sellersSearch !== '' || sellersDomainFilter !== 'all' || sellersAdsTxtFilter !== 'all') && (
                    <button 
                      onClick={() => {
                        setSellersSearch('');
                        setSellersDomainFilter('all');
                        setSellersAdsTxtFilter('all');
                        setSellersPage(1);
                        fetchSellers(selectedCompany, 1, '', 'all', 'all');
                      }}
                      className="btn btn-secondary"
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', height: '30px', alignSelf: 'flex-end' }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>

                {/* Table View */}
                {loadingSellers && sellers.length === 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '250px', color: 'var(--text-muted)' }}>
                    Loading directory database...
                  </div>
                ) : sellers.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '200px', color: 'var(--text-muted)' }}>
                    <span>🔍</span>
                    <p style={{ marginTop: '0.5rem' }}>No sellers match the current filters.</p>
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>Seller ID</th>
                          <th>Legal Name</th>
                          <th>Seller Type</th>
                          <th>Business Domain</th>
                          <th>Is Live (Domain)</th>
                          <th>ads.txt Status</th>
                          <th>Ads Detected</th>
                          <th>Contact Info</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sellers.map((s) => (
                          <tr key={s.id}>
                            <td style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{s.seller_id}</td>
                            <td>{s.name || <span style={{ fontStyle: 'italic', opacity: 0.5 }}>Confidential</span>}</td>
                            <td>
                              <span style={{ fontSize: '0.75rem', fontWeight: 600, background: 'rgba(255,255,255,0.04)', padding: '0.15rem 0.4rem', borderRadius: '4px', border: '1px solid var(--card-border)' }}>
                                {s.seller_type}
                              </span>
                            </td>
                            <td>
                              <a 
                                href={`https://${s.domain}`} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="lead-link"
                              >
                                {s.domain} <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>↗</span>
                              </a>
                            </td>
                            <td>
                              {s.domain_status === 'pass' ? (
                                <span className="badge badge-success">Live</span>
                              ) : s.domain_status === 'failed' ? (
                                <span className="badge badge-danger">Offline / Error</span>
                              ) : (
                                <span className="badge badge-secondary">Pending</span>
                              )}
                            </td>
                            <td>
                              {s.ads_txt_status === 'present' ? (
                                <span className="badge badge-success">Present</span>
                              ) : s.ads_txt_status === 'not present' ? (
                                <span className="badge badge-secondary">Not Present</span>
                              ) : (
                                <span className="badge badge-secondary">Pending</span>
                              )}
                            </td>
                            {/* Ads Detected Column */}
                            <td>
                              {s.ads_detected && s.ads_detected !== 'none' && s.ads_detected !== 'no' && s.ads_detected !== 'pending' ? (
                                <span className="badge badge-primary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.5rem', whiteSpace: 'normal', maxWidth: '180px', display: 'inline-block', textAlign: 'left' }}>
                                  {s.ads_detected.startsWith('yes (') ? s.ads_detected.replace('yes (', '').replace(')', '') : s.ads_detected}
                                </span>
                              ) : s.ads_detected === 'no' || s.ads_detected === 'none' ? (
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No</span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>Pending</span>
                              )}
                            </td>
                            {/* Contact Info Column */}
                            <td>
                              {s.best_email && (
                                <div style={{ marginBottom: '0.35rem' }}>
                                  <span style={{ fontSize: '0.72rem', color: '#22c55e', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '4px', padding: '0.15rem 0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                    ✅ <strong>{s.best_email}</strong>
                                  </span>
                                </div>
                              )}
                              
                              {(() => {
                                const emailsList = safeParseEmails(s.fetched_emails);
                                const otherEmails = emailsList.filter(e => e !== s.best_email);
                                if (otherEmails.length === 0) return s.best_email ? null : <span style={{ opacity: 0.5, fontSize: '0.85rem' }}>None</span>;
                                
                                return (
                                  <div className="email-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                                    {otherEmails.map((email) => (
                                      <span 
                                        key={email} 
                                        className="email-tag" 
                                        style={{ 
                                          fontSize: '0.7rem',
                                          display: 'inline-flex', 
                                          alignItems: 'center', 
                                          gap: '0.25rem',
                                          background: 'rgba(99, 102, 241, 0.1)', 
                                          borderColor: 'rgba(99, 102, 241, 0.2)',
                                          padding: '0.1rem 0.3rem',
                                          borderRadius: '3px',
                                          border: '1px solid rgba(99, 102, 241, 0.2)'
                                        }}
                                      >
                                        {email}
                                      </span>
                                    ))}
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination Controls */}
                {sellersPagination.pages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '1.5rem' }}>
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => setSellersPage(p => Math.max(1, p - 1))}
                      disabled={sellersPage === 1}
                      style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                    >
                      ◀ Previous
                    </button>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      Page <strong>{sellersPage}</strong> of <strong>{sellersPagination.pages}</strong> ({sellersPagination.total} total matching)
                    </span>
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => setSellersPage(p => Math.min(sellersPagination.pages, p + 1))}
                      disabled={sellersPage === sellersPagination.pages}
                      style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                    >
                      Next ▶
                    </button>
                  </div>
                )}

              </div>

            </main>
          ) : (
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '300px', color: 'var(--text-muted)' }}>
              <span style={{ fontSize: '3rem', marginBottom: '1.25rem' }}>📊</span>
              <h3 style={{ margin: 0, fontWeight: 600, color: 'var(--text-bright)' }}>No Company Selected</h3>
              <p style={{ marginTop: '0.35rem', fontSize: '0.85rem' }}>Enter a website URL above to fetch sellers, or choose a previously crawled company.</p>
            </div>
          )}
        </div>
      )}

      {/* Mail Merge Tab */}
      {activeTab === 'mailmerge' && (
        <div className="animate-fade" style={{ padding: '0 0 2rem' }}>
          <MailMerge userId={user.id} drafts={drafts} />
        </div>
      )}

      {/* Modal Outreach Composer */}
      {activeLeadForOutreach && (
        <OutreachComposer
          lead={activeLeadForOutreach}
          userId={user.id}
          onClose={() => setActiveLeadForOutreach(null)}
          onSent={fetchLeads}
          drafts={drafts}
        />
      )}

      {/* Bulk Outreach Modal */}
      {showBulkModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !bulkSending) setShowBulkModal(false); }}>
          <div className="modal-content glass-panel bulk-modal-content animate-fade">
            <div className="modal-header">
              <h2 className="card-title" style={{ margin: 0 }}>Bulk Outreach Composer ({selectedCount} target leads)</h2>
              <button className="close-btn" onClick={() => setShowBulkModal(false)} disabled={bulkSending}>&times;</button>
            </div>

            {bulkError && (
              <div style={{ background: 'var(--danger-glow)', color: '#f87171', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem' }}>
                {bulkError}
              </div>
            )}

            {bulkSuccess && (
              <div style={{ background: 'var(--success-glow)', color: '#34d399', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem', textAlign: 'center' }}>
                {bulkSuccess}
              </div>
            )}

            <form onSubmit={handleSendBulkOutreach}>
              {/* Template selector */}
              <div className="form-group">
                <label className="form-label">Select Saved Draft Template</label>
                <select
                  className="form-control"
                  value={selectedTemplateId}
                  onChange={(e) => handleTemplateChangeForBulk(e.target.value)}
                  disabled={bulkSending}
                >
                  <option value="">-- No Template Selected --</option>
                  {drafts.map(d => (
                    <option key={d.id} value={d.id}>{d.subject}</option>
                  ))}
                </select>
              </div>



              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={disableBulkTracking}
                    onChange={(e) => setDisableBulkTracking(e.target.checked)}
                    disabled={bulkSending}
                  />
                  Disable email tracking (Highly recommended to land in Primary Inbox instead of Promotions)
                </label>
              </div>

              <div className="form-group">
                <label className="form-label">Subject</label>
                <input
                  type="text"
                  className="form-control"
                  value={bulkSubject}
                  onChange={(e) => setBulkSubject(e.target.value)}
                  disabled={bulkSending}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Body (HTML format)</label>
                <textarea
                  className="form-control"
                  style={{ minHeight: '140px', resize: 'vertical' }}
                  value={bulkBody}
                  onChange={(e) => setBulkBody(e.target.value)}
                  disabled={bulkSending}
                  required
                />
              </div>

              {/* Dynamic Preview */}
              {getBulkPreview() && (
                <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.25rem', background: 'rgba(255,255,255,0.01)', border: '1px dashed var(--card-border)' }}>
                  <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                    Preview (First Lead: {getBulkPreview()?.website})
                  </h4>
                  <div style={{ fontSize: '0.85rem', borderBottom: '1px solid var(--card-border)', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                    <strong>Subject:</strong> {getBulkPreview()?.subject}
                  </div>
                  <div 
                    style={{ fontSize: '0.85rem', color: 'var(--text-muted)', maxHeight: '120px', overflowY: 'auto' }} 
                    dangerouslySetInnerHTML={{ __html: getBulkPreview()?.body || '' }}
                  />
                </div>
              )}

              {bulkSending && (
                <div style={{ marginBottom: '1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                    <span>Sending bulk emails...</span>
                    <span>{bulkProgress.current} / {bulkProgress.total}</span>
                  </div>
                  <div style={{ height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
                    <div 
                      style={{ 
                        height: '100%', 
                        width: `${(bulkProgress.current / bulkProgress.total) * 100}%`, 
                        background: 'var(--primary)',
                        transition: 'width 0.2s ease'
                      }}
                    />
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowBulkModal(false)} disabled={bulkSending}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={bulkSending || !bulkSubject || !bulkBody}>
                  {bulkSending ? `Sending (${bulkProgress.current}/${bulkProgress.total})` : '🚀 Send Bulk Outreach'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
export default Dashboard;
