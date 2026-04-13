import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Shield, LayoutDashboard, UserPlus, Vote, Send, Activity } from 'lucide-react';
import { ethers } from 'ethers';

import WalletConnect from './components/WalletConnect';
import Delegate from './pages/Delegate';
import CreateProposal from './pages/CreateProposal';
import CastVote from './pages/CastVote';
import Results from './pages/Results';

const Navigation = ({ address, setAddress, setProvider, onConnect }) => {
  const location = useLocation();
  const currentPath = location.pathname;

  return (
    <nav className="navbar">
      <Link to="/" className="logo">
        <Shield className="text-accent" size={28} />
        DAO Governance
      </Link>
      
      <div className="nav-links">
        <Link to="/" className={`nav-link ${currentPath === '/' ? 'active' : ''}`}>
          <span className="flex items-center gap-2"><LayoutDashboard size={18} /> Dashboard</span>
        </Link>
        <Link to="/delegate" className={`nav-link ${currentPath === '/delegate' ? 'active' : ''}`}>
          <span className="flex items-center gap-2"><UserPlus size={18} /> Delegate</span>
        </Link>
        <Link to="/propose" className={`nav-link ${currentPath === '/propose' ? 'active' : ''}`}>
          <span className="flex items-center gap-2"><Send size={18} /> Propose</span>
        </Link>
        <Link to="/cast-vote" className={`nav-link ${currentPath.startsWith('/cast-vote') ? 'active' : ''}`}>
          <span className="flex items-center gap-2"><Vote size={18} /> Vote Off-Chain</span>
        </Link>
        <Link to="/results" className={`nav-link ${currentPath.startsWith('/results') ? 'active' : ''}`}>
          <span className="flex items-center gap-2"><Activity size={18} /> Results</span>
        </Link>
      </div>

      <WalletConnect 
        address={address}
        onConnect={onConnect} 
      />
    </nav>
  );
};

const Dashboard = () => (
  <div className="form-container" style={{ maxWidth: '800px', textAlign: 'center' }}>
    <div className="page-header" style={{ marginBottom: '60px' }}>
      <Shield size={64} className="text-accent mx-auto mb-4" style={{ margin: '0 auto 24px' }} />
      <h1 className="page-title" style={{ fontSize: '3.5rem', marginBottom: '24px' }}>True Off-Chain DAO</h1>
      <p className="page-subtitle" style={{ fontSize: '1.2rem', lineHeight: 1.6 }}>
        Gasless. Secure. Decentralized. Participate in protocol governance without paying exorbitant network fees by signing typed data directly from your wallet.
      </p>
    </div>

    <div className="content-grid">
      <div className="glass-panel" style={{ padding: '32px' }}>
        <h3 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--text-main)' }}>Step 1: Delegate</h3>
        <p className="text-muted" style={{ marginBottom: '24px', fontSize: '0.95rem' }}>
          Assign your voting power to yourself or another address to participate in proposals.
        </p>
        <Link to="/delegate" className="btn" style={{ width: '100%' }}>Go to Delegate</Link>
      </div>
      <div className="glass-panel" style={{ padding: '32px' }}>
        <h3 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--text-main)' }}>Step 2: Propose</h3>
        <p className="text-muted" style={{ marginBottom: '24px', fontSize: '0.95rem' }}>
          Draft new protocol upgrades and submit target payloads for the community to review.
        </p>
        <Link to="/propose" className="btn" style={{ width: '100%' }}>Create Proposal</Link>
      </div>
      <div className="glass-panel" style={{ padding: '32px' }}>
        <h3 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--text-main)' }}>Step 3: Vote</h3>
        <p className="text-muted" style={{ marginBottom: '24px', fontSize: '0.95rem' }}>
          Cast your vote off-chain with a simple MetaMask signature. No gas required.
        </p>
        <Link to="/cast-vote" className="btn btn-primary" style={{ width: '100%' }}>Cast Vote</Link>
      </div>
    </div>
  </div>
);

function App() {
  const [address, setAddress] = useState('');
  const [provider, setProvider] = useState(null);

  // Centralized connection check and listeners
  useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum) return;

    // Resolve the best provider (Targeting MetaMask in multi-wallet envs)
    const providerObj = ethereum.providers ? 
      (ethereum.providers.find(p => p.isMetaMask) || ethereum.providers[0]) : 
      ethereum;

    const checkConnection = async () => {
      try {
        const accounts = await providerObj.request({ method: 'eth_accounts' });
        if (accounts.length > 0) {
          setAddress(accounts[0]);
          setProvider(new ethers.BrowserProvider(providerObj));
        }
      } catch (error) {
        console.error("Failed initial connection check:", error);
      }
    };

    const handleAccounts = (accounts) => {
      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setProvider(new ethers.BrowserProvider(providerObj));
      } else {
        setAddress('');
        setProvider(null);
      }
    };

    const handleChain = () => window.location.reload();

    checkConnection();
    providerObj.on('accountsChanged', handleAccounts);
    providerObj.on('chainChanged', handleChain);

    return () => {
      providerObj.removeListener('accountsChanged', handleAccounts);
      providerObj.removeListener('chainChanged', handleChain);
    };
  }, []);

  const switchNetwork = async () => {
    const HARDHAT_CHAIN_ID = '0x7a69';
    try {
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (currentChainId !== HARDHAT_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: HARDHAT_CHAIN_ID }],
          });
        } catch (switchError) {
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: HARDHAT_CHAIN_ID,
                chainName: 'Hardhat Localhost',
                rpcUrls: ['http://127.0.0.1:8545'],
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              }],
            });
          }
        }
      }
    } catch (error) {
      console.error("Switch network failed:", error);
    }
  };

  const handleConnect = useCallback(async (addr) => {
    setAddress(addr);
    const prov = new ethers.BrowserProvider(window.ethereum);
    setProvider(prov);
    // After connection, attempt to switch network if needed
    // This happens asynchronously and won't block the UI update
    switchNetwork();
  }, []);

  return (
    <Router>
      <div className="app-container">
        <Navigation 
          address={address} 
          setAddress={setAddress} 
          setProvider={setProvider} 
          onConnect={handleConnect}
        />
        
        <main style={{ paddingBottom: '80px' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/delegate" element={<Delegate provider={provider} address={address} />} />
            <Route path="/propose" element={<CreateProposal provider={provider} address={address} />} />
            <Route path="/cast-vote" element={<CastVote provider={provider} address={address} />} />
            <Route path="/results" element={<Results provider={provider} address={address} />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
