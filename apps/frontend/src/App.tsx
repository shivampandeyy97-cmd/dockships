import { useState, useEffect } from 'react';
import { Dashboard } from './components/Dashboard';

interface User {
  id: string;
  email: string;
}

// Default user — no login required, app is publicly accessible
const DEFAULT_USER: User = {
  id: 'default-user',
  email: 'admin@dockships.com'
};

function App() {
  const [user] = useState<User>(DEFAULT_USER);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Auto-set the default user credentials for API calls that need userId
    localStorage.setItem('dockships_user', JSON.stringify(DEFAULT_USER));
    localStorage.setItem('dockships_token', 'default-token');
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--bg-gradient)' }}>
        <div className="brand-logo" style={{ animation: 'glow 2s infinite' }}>DS</div>
      </div>
    );
  }

  return (
    <>
      <Dashboard user={user} onLogout={() => {}} />
    </>
  );
}

export default App;
