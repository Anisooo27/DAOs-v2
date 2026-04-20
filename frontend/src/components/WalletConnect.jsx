import { useState } from 'react';
import { Wallet, LogOut } from 'lucide-react';

const WalletConnect = ({ address, onConnect, onDisconnect }) => {
  const [isConnecting, setIsConnecting] = useState(false);

  const getProvider = () => {
    if (!window.ethereum) return null;
    // Handle multiple providers (e.g. MetaMask + Phantom)
    if (window.ethereum.providers) {
      return window.ethereum.providers.find(p => p.isMetaMask) || window.ethereum.providers[0];
    }
    return window.ethereum;
  };

  const connectWallet = async () => {
    console.log("[WalletConnect] Clicked 'Connect Wallet'");
    const provider = getProvider();
    
    if (!provider) {
      console.warn("[WalletConnect] No ethereum provider found");
      alert("Error: MetaMask not found. Please install the MetaMask extension and refresh the page.");
      return;
    }

    try {
      setIsConnecting(true);
      console.log("[WalletConnect] Requesting accounts (with 5s timeout)...");
      
      // TIMEOUT MECHANISM: 5 seconds
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("TIMEOUT")), 5000)
      );

      // THE REQUEST
      const requestPromise = provider.request({ method: 'eth_requestAccounts' });

      // RACE
      const accounts = await Promise.race([requestPromise, timeoutPromise]);

      console.log("[WalletConnect] Request resolved:", accounts);
      
      if (accounts && accounts.length > 0) {
        if (onConnect) {
          onConnect(accounts[0]);
        }
      }
    } catch (error) {
      console.error("[WalletConnect] Error:", error);
      
      if (error.message === "TIMEOUT") {
        alert("Connection Stuck: MetaMask didn't respond in time. This often happens if an extension like Zotero is conflicting or if a request is already hidden in MetaMask. Please open MetaMask manually and refresh.");
      } else if (error.code === 4001) {
        console.log("[WalletConnect] User rejected");
      } else if (error.code === -32002) {
        alert("Action Required: A request is already pending. Please open your MetaMask extension (top right icon) to approve it.");
      } else {
        alert(`MetaMask Error: ${error.message || "Request failed"}`);
      }
    } finally {
      setIsConnecting(false);
      console.log("[WalletConnect] Done");
    }
  };

  const formatAddress = (addr) => {
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
  };

  return address ? (
    <div style={{ display: 'flex', gap: '8px' }}>
      <button className="btn btn-primary" style={{ cursor: 'default' }}>
        <Wallet size={18} />
        {formatAddress(address)}
      </button>
      <button 
        className="btn"
        style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
        onClick={() => {
          if (window.ethereum && window.ethereum.disconnect) {
            window.ethereum.disconnect(); // If a provider actually supports it
          }
          if (onDisconnect) onDisconnect();
        }}
        title="Disconnect Wallet"
      >
        <LogOut size={18} /> Disconnect
      </button>
    </div>
  ) : (
    <button 
      className="btn"
      id="connect-wallet-btn"
      onClick={connectWallet}
      disabled={isConnecting}
    >
      <Wallet size={18} />
      {isConnecting ? 'Connecting...' : 'Connect Wallet'}
    </button>
  );
};

export default WalletConnect;
