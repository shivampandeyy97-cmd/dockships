import { useState, useEffect } from 'react';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';

interface User {
  id: string;
  email: string;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedUser = localStorage.getItem('dockships_user');
    const savedToken = localStorage.getItem('dockships_token');
    
    if (savedUser && savedToken) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (e) {
        localStorage.removeItem('dockships_user');
        localStorage.removeItem('dockships_token');
      }
    }
    setLoading(false);
  }, []);

  const handleLoginSuccess = (loggedInUser: User, token: string) => {
    localStorage.setItem('dockships_user', JSON.stringify(loggedInUser));
    localStorage.setItem('dockships_token', token);
    setUser(loggedInUser);
  };

  const handleLogout = () => {
    localStorage.removeItem('dockships_user');
    localStorage.removeItem('dockships_token');
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--bg-gradient)' }}>
        <div className="brand-logo" style={{ animation: 'glow 2s infinite' }}>DS</div>
      </div>
    );
  }

  return (
    <>
      {!user ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : (
        <Dashboard user={user} onLogout={handleLogout} />
      )}
    </>
  );
}

export default App;
