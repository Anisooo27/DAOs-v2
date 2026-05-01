import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle, AlertCircle,
  Coins, RefreshCw, ShieldCheck
} from 'lucide-react';
import { ethers } from 'ethers';

// ── Constants ─────────────────────────────────────────────────────────────────
const BACKEND = 'http://localhost:5000';

// ─────────────────────────────────────────────────────────────────────────────
const Membership = ({ provider, address }) => {
  // ── State ──────────────────────────────────────────────────────────────────
  const [govBalance, setGovBalance]           = useState(null); // raw BigInt string
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isMinting, setIsMinting]             = useState(false);
  const [mintStep, setMintStep]               = useState('');
  const [mintResult, setMintResult]           = useState(null);
  const [error, setError]                     = useState('');

  // ── Refresh on-chain balance from backend ─────────────────────────────────
  const refreshStatus = useCallback(async () => {
    if (!address) return;
    setIsLoadingStatus(true);
    try {
      const res = await fetch(`${BACKEND}/membership/${address}`);
      if (!res.ok) return;
      const data = await res.json();
      setGovBalance(data.govBalance ?? '0');
    } catch (err) {
      console.warn('[membership] Status refresh failed:', err.message);
    } finally {
      setIsLoadingStatus(false);
    }
  }, [address]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // ── Derived values ────────────────────────────────────────────────────────
  const govBalanceEth = govBalance !== null ? ethers.formatEther(govBalance) : null;
  const hasTokens     = govBalance !== null && BigInt(govBalance) > 0n;

  // ── Get GOV Tokens ────────────────────────────────────────────────────────
  const handleGetTokens = async () => {
    setError('');
    setMintResult(null);
    if (!address) { setError('Connect your wallet first.'); return; }

    try {
      setIsMinting(true);
      setMintStep('Requesting GOV token mint...');

      if (!provider) throw new Error('Wallet provider not found');
      
      const configRes = await fetch('http://localhost:5000/config/contract');
      const configData = await configRes.json();
      
      const signer = await provider.getSigner();
      
      const TOKEN_ABI = [
        'function faucetMint(uint256 amount) public'
      ];
      const tokenContract = new ethers.Contract(configData.tokenAddress, TOKEN_ABI, signer);
      
      setMintStep('Confirm in MetaMask to mint GOV tokens...');
      const tx = await tokenContract.faucetMint(ethers.parseUnits("1000", 18));
      
      setMintStep('Confirming...');
      await tx.wait();

      setMintResult({ txHash: tx.hash, amount: "1000" });
      await refreshStatus();
    } catch (err) {
      console.error('[get-tokens]', err);
      setError(err.message || 'Token minting failed');
    } finally {
      setIsMinting(false);
      setMintStep('');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Membership</h1>
        <p className="page-subtitle">
          Holding GOV tokens automatically grants voting power. No delegation required.
        </p>
      </div>

      {/* ── Governance Model Banner ────────────────────────────────────────── */}
      <div className="glass-panel mb-4" style={{
        background: 'rgba(0,255,136,0.04)',
        border: '1px solid rgba(0,255,136,0.2)',
        padding: '18px 22px',
        display: 'flex', alignItems: 'flex-start', gap: '14px'
      }}>
        <ShieldCheck size={22} style={{ color: 'var(--accent-primary)', flexShrink: 0, marginTop: '2px' }} />
        <div>
          <p style={{ fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px', fontSize: '0.95rem' }}>
            Balance-Based Voting Power
          </p>
          <p style={{ fontSize: '0.83rem', opacity: 0.75, lineHeight: 1.65 }}>
            Your voting weight equals your GOV token balance at the time of each proposal snapshot.
            Simply hold GOV tokens — no <code>delegate()</code> transaction needed — to propose and vote on governance actions.
          </p>
        </div>
      </div>

      {/* ── Status Dashboard ────────────────────────────────────────────────── */}
      {address && (
        <div className="glass-panel mb-4" style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span style={{ fontWeight: 600, fontSize: '0.88rem', opacity: 0.7 }}>Your Membership Status</span>
            <button
              onClick={refreshStatus}
              disabled={isLoadingStatus}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: '4px',
                fontSize: '0.78rem', opacity: isLoadingStatus ? 0.5 : 1
              }}
            >
              <RefreshCw size={12} style={{ animation: isLoadingStatus ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>

          {/* Balance + Voting Power grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontSize: '0.68rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>GOV Balance</div>
              <div style={{ fontWeight: 700, fontSize: '1.25rem', color: hasTokens ? 'var(--accent-primary)' : 'var(--danger)' }}>
                {govBalanceEth === null ? '⏳' : `${parseFloat(govBalanceEth).toLocaleString()} GOV`}
              </div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontSize: '0.68rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>Voting Power</div>
              <div style={{ fontWeight: 700, fontSize: '1.25rem', color: hasTokens ? 'var(--accent-primary)' : 'var(--danger)' }}>
                {govBalanceEth === null ? '⏳' : `${parseFloat(govBalanceEth).toLocaleString()} GOV`}
              </div>
              <div style={{ fontSize: '0.68rem', opacity: 0.4, marginTop: '4px' }}>= token balance</div>
            </div>
          </div>

          {/* Status pill */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {govBalance === null ? (
              <div style={{ fontSize: '0.82rem', opacity: 0.5 }}>⏳ Loading status…</div>
            ) : hasTokens ? (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                background: 'rgba(0,255,136,0.07)', border: '1px solid rgba(0,255,136,0.2)',
                padding: '10px 18px', borderRadius: '8px', fontSize: '0.85rem'
              }}>
                <CheckCircle size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                  You're a member! You can propose and vote on governance actions.
                </span>
              </div>
            ) : (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)',
                padding: '10px 18px', borderRadius: '8px', fontSize: '0.85rem'
              }}>
                <AlertCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                  No GOV tokens — get tokens below to participate in governance.
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Get GOV Tokens ────────────────────────────────────────────────── */}
      <div className="glass-panel mb-4" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ padding: '6px', background: hasTokens ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.08)', borderRadius: '6px' }}>
            <Coins size={16} style={{ color: hasTokens ? 'var(--accent-primary)' : 'inherit' }} />
          </div>
          <h3 style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            Get GOV Tokens
            {hasTokens && <span style={{ marginLeft: '8px', color: 'var(--accent-primary)', fontSize: '0.8rem' }}>✅ You already have tokens</span>}
          </h3>
        </div>
        <p style={{ fontSize: '0.83rem', opacity: 0.6, marginBottom: '16px', lineHeight: 1.6 }}>
          This mints 1,000 GOV directly to your connected wallet. Confirm in MetaMask to activate voting power.
        </p>

        {!address ? (
          <div style={{ fontSize: '0.85rem', opacity: 0.5, fontStyle: 'italic' }}>Connect your wallet to enable this button.</div>
        ) : hasTokens ? (
          <div style={{ fontSize: '0.83rem', color: 'var(--accent-primary)', fontWeight: 600 }}>
            ✅ You already have {parseFloat(govBalanceEth).toLocaleString()} GOV tokens. You're ready to propose and vote!
          </div>
        ) : (
          <button
            onClick={handleGetTokens}
            disabled={isMinting || !address}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px' }}
          >
            <Coins size={16} />
            {isMinting ? (mintStep || 'Minting...') : 'Mint GOV Tokens (MetaMask transaction required)'}
          </button>
        )}

        {mintResult && (
          <div style={{
            marginTop: '14px', padding: '10px 14px', borderRadius: '8px',
            background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)',
            fontSize: '0.82rem'
          }}>
            <div style={{ color: 'var(--accent-primary)', fontWeight: 600, marginBottom: '4px' }}>
              ✅ {mintResult.amount} GOV transferred!
            </div>
            <div style={{ opacity: 0.6, wordBreak: 'break-all' }}>Tx: {mintResult.txHash}</div>
            <div style={{ marginTop: '8px', fontWeight: 600 }}>
              → Your voting power is now active. Navigate to <strong>Propose</strong> or <strong>Vote</strong>.
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: '8px', padding: '12px 16px', marginTop: '14px',
            color: 'var(--danger)', fontSize: '0.83rem', whiteSpace: 'pre-wrap',
            display: 'flex', gap: '8px', alignItems: 'flex-start'
          }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default Membership;
