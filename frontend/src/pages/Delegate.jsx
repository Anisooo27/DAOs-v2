import { useState, useEffect, useCallback } from 'react';
import {
  UserPlus, Info, CheckCircle, AlertCircle, Zap,
  Coins, ArrowRight, RefreshCw, ExternalLink
} from 'lucide-react';
import { ethers } from 'ethers';

// ── Constants ─────────────────────────────────────────────────────────────────
const BACKEND = 'http://localhost:5000';

const GOV_TOKEN_ABI = [
  'function delegate(address delegatee) external',
  'function getVotes(address account) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

// ── Helper: status badge ───────────────────────────────────────────────────────
const Badge = ({ ok, loading, label, title }) => (
  <div
    title={title}
    style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '4px', cursor: title ? 'help' : 'default'
    }}
  >
    <span style={{ fontSize: '1.2rem' }}>
      {loading ? '⏳' : ok ? '✅' : '❌'}
    </span>
    <span style={{
      fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em',
      opacity: loading ? 0.5 : 1,
      color: loading ? 'inherit' : ok ? 'var(--accent-primary)' : 'var(--danger)'
    }}>
      {label}
    </span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
const Delegate = ({ provider, address }) => {
  // ── State ──────────────────────────────────────────────────────────────────
  const [delegatee, setDelegatee]               = useState('');
  const [tokenAddress, setTokenAddress]         = useState(null);

  // Token info from backend
  const [govBalance, setGovBalance]             = useState(null); // BigInt string from API
  const [onChainVotes, setOnChainVotes]         = useState(null); // BigInt string from API
  const [mongoRecord, setMongoRecord]           = useState(null); // bool | null

  // Loading states
  const [isLoadingStatus, setIsLoadingStatus]   = useState(false);
  const [isMinting, setIsMinting]               = useState(false);
  const [isDelegating, setIsDelegating]         = useState(false);

  // Step labels
  const [mintStep, setMintStep]                 = useState('');
  const [delegateStep, setDelegateStep]         = useState('');

  // Results / errors
  const [mintResult, setMintResult]             = useState(null); // { txHash, amount }
  const [delegateResult, setDelegateResult]     = useState(null); // { txHash }
  const [error, setError]                       = useState('');

  // Pre-fill delegatee to connected address
  useEffect(() => {
    if (address && !delegatee) setDelegatee(address);
  }, [address]);

  // ── Load token address from backend ──────────────────────────────────────
  useEffect(() => {
    fetch(`${BACKEND}/config/contract`)
      .then(r => r.json())
      .then(d => setTokenAddress(d.tokenAddress || null))
      .catch(() => {});
  }, []);

  // ── Refresh on-chain + MongoDB status ────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    if (!address) return;
    setIsLoadingStatus(true);
    try {
      const res = await fetch(`${BACKEND}/delegation/${address}`);
      if (!res.ok) return;
      const data = await res.json();
      setMongoRecord(data.mongoRecordExists ?? data.delegated ?? false);
      setOnChainVotes(data.onChainVotes ?? '0');
      setGovBalance(data.govBalance ?? '0');
    } catch (err) {
      console.warn('[delegate] Status refresh failed:', err.message);
    } finally {
      setIsLoadingStatus(false);
    }
  }, [address]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // ── Derived booleans ──────────────────────────────────────────────────────
  const govBalanceEth   = govBalance !== null ? ethers.formatEther(govBalance)   : null;
  const votesEth        = onChainVotes !== null ? ethers.formatEther(onChainVotes) : null;
  const hasTokens       = govBalance !== null && BigInt(govBalance) > 0n;
  const hasVotingPower  = onChainVotes !== null && BigInt(onChainVotes) > 0n;
  const fullySetUp      = mongoRecord && hasVotingPower;

  // ── STEP A: Get GOV Tokens ────────────────────────────────────────────────
  const handleGetTokens = async () => {
    setError('');
    setMintResult(null);
    if (!address) { setError('Connect your wallet first.'); return; }

    try {
      setIsMinting(true);
      setMintStep('Requesting GOV token transfer from deployer...');

      const res = await fetch(`${BACKEND}/admin/setup-voter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAddress: address, amount: '1000' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Token transfer failed');

      setMintStep('Confirming...');
      setMintResult({ txHash: data.transferTx, amount: data.transferred });
      await refreshStatus();
    } catch (err) {
      console.error('[get-tokens]', err);
      setError(err.message);
    } finally {
      setIsMinting(false);
      setMintStep('');
    }
  };

  // ── STEP B: Delegate on-chain then record in MongoDB ─────────────────────
  const handleDelegate = async (e) => {
    e.preventDefault();
    setError('');
    setDelegateResult(null);

    if (!address) { setError('Connect your wallet first.'); return; }
    if (!ethers.isAddress(delegatee)) { setError('Enter a valid delegatee address.'); return; }
    if (!hasTokens) {
      setError('You have 0 GOV tokens. Click "Get GOV Tokens" first.');
      return;
    }

    try {
      setIsDelegating(true);
      if (!provider) throw new Error('Wallet provider not found');
      const signer = await provider.getSigner();

      // ── 1. On-chain delegate() ─────────────────────────────────────────────
      setDelegateStep('Step 1/2 — Confirm MetaMask transaction…');
      if (!tokenAddress) throw new Error('Token address not loaded from backend. Refresh the page.');
      const token = new ethers.Contract(tokenAddress, GOV_TOKEN_ABI, signer);

      const bal = await token.balanceOf(address);
      if (bal === 0n) throw new Error('Wallet has 0 GOV tokens. Click "Get GOV Tokens" first.');

      const delegateTx = await token.delegate(delegatee);
      console.log('[delegate] On-chain tx sent:', delegateTx.hash);
      setDelegateStep('Step 1/2 — Waiting for confirmation…');
      await delegateTx.wait();
      console.log('[delegate] On-chain delegation confirmed.');

      // ── 2. Sign + POST /delegate for MongoDB record ────────────────────────
      setDelegateStep('Step 2/2 — Recording delegation…');
      const message   = `Delegate votes to ${delegatee}`;
      const signature = await signer.signMessage(message);

      await fetch(`${BACKEND}/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegatorAddress: address, delegateeAddress: delegatee, signature })
      }).catch(err => console.warn('[delegate] MongoDB record failed (non-critical):', err.message));

      setDelegateResult({ txHash: delegateTx.hash });
      await refreshStatus();
    } catch (err) {
      console.error('[delegate]', err);
      setError(err.message || 'Delegation failed');
    } finally {
      setIsDelegating(false);
      setDelegateStep('');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Delegate Votes</h1>
        <p className="page-subtitle">
          Get GOV tokens, delegate on-chain, and unlock proposal + voting rights — all from this page.
        </p>
      </div>

      {/* ── Status Dashboard ──────────────────────────────────────────────── */}
      {address && (
        <div className="glass-panel mb-4" style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span style={{ fontWeight: 600, fontSize: '0.88rem', opacity: 0.7 }}>Your Governance Status</span>
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

          {/* Token + Votes numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '0.68rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>GOV Balance</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: hasTokens ? 'var(--accent-primary)' : 'var(--danger)' }}>
                {govBalanceEth === null ? '⏳' : `${parseFloat(govBalanceEth).toLocaleString()} GOV`}
              </div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '0.68rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>On-Chain Votes</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: hasVotingPower ? 'var(--accent-primary)' : 'var(--danger)' }}>
                {votesEth === null ? '⏳' : `${parseFloat(votesEth).toLocaleString()}`}
              </div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '0.68rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>DB Record</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: mongoRecord ? 'var(--accent-primary)' : 'var(--danger)' }}>
                {mongoRecord === null ? '⏳' : mongoRecord ? 'Recorded' : 'Missing'}
              </div>
            </div>
          </div>

          {/* Checklist badges */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '14px' }}>
            <Badge
              ok={hasTokens}
              loading={govBalance === null}
              label="Has Tokens"
              title={hasTokens ? `${govBalanceEth} GOV` : 'No GOV balance — click Get GOV Tokens'}
            />
            <Badge
              ok={hasVotingPower}
              loading={onChainVotes === null}
              label="Delegated"
              title={
                onChainVotes === null ? 'Checking...' :
                hasVotingPower ? `${votesEth} on-chain votes` :
                hasTokens ? 'Has tokens but not delegated on-chain — use form below' :
                'No tokens and not delegated'
              }
            />
            <Badge
              ok={mongoRecord === true}
              loading={mongoRecord === null}
              label="DB Record"
              title={mongoRecord ? 'Delegation recorded in MongoDB' : 'No DB record — delegation form creates this'}
            />
          </div>

          {fullySetUp && (
            <div style={{
              marginTop: '16px', padding: '10px 14px', borderRadius: '8px',
              background: 'rgba(0,255,136,0.07)', border: '1px solid rgba(0,255,136,0.2)',
              display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem'
            }}>
              <CheckCircle size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                You're fully set up! Navigate to <strong>Propose</strong> to create a proposal.
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── STEP A: Get GOV Tokens ────────────────────────────────────────── */}
      <div className="glass-panel mb-4" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ padding: '6px', background: hasTokens ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.08)', borderRadius: '6px' }}>
            <Coins size={16} style={{ color: hasTokens ? 'var(--accent-primary)' : 'inherit' }} />
          </div>
          <h3 style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            Step 1 — Get GOV Tokens
            {hasTokens && <span style={{ marginLeft: '8px', color: 'var(--accent-primary)', fontSize: '0.8rem' }}>✅ Done</span>}
          </h3>
        </div>
        <p style={{ fontSize: '0.83rem', opacity: 0.6, marginBottom: '16px', lineHeight: 1.6 }}>
          This transfers 1,000 GOV from the Hardhat deployer to your connected wallet via the backend.
          Only works on <code>localhost</code>. No MetaMask confirmation needed for this step.
        </p>

        {!address ? (
          <div style={{ fontSize: '0.85rem', opacity: 0.5, fontStyle: 'italic' }}>Connect your wallet to enable this button.</div>
        ) : hasTokens ? (
          <div style={{ fontSize: '0.83rem', color: 'var(--accent-primary)', fontWeight: 600 }}>
            ✅ You already have {parseFloat(govBalanceEth).toLocaleString()} GOV tokens.
          </div>
        ) : (
          <button
            onClick={handleGetTokens}
            disabled={isMinting || !address}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px' }}
          >
            <Coins size={16} />
            {isMinting ? (mintStep || 'Transferring...') : 'Get GOV Tokens (1,000)'}
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
              → Now complete Step 2 below to activate your voting power.
            </div>
          </div>
        )}
      </div>

      {/* ── STEP B: Delegate On-Chain ─────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{ padding: '6px', background: hasVotingPower ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.08)', borderRadius: '6px' }}>
            <UserPlus size={16} style={{ color: hasVotingPower ? 'var(--accent-primary)' : 'inherit' }} />
          </div>
          <h3 style={{ fontWeight: 700, fontSize: '0.95rem' }}>
            Step 2 — Delegate Votes On-Chain
            {hasVotingPower && mongoRecord && <span style={{ marginLeft: '8px', color: 'var(--accent-primary)', fontSize: '0.8rem' }}>✅ Done</span>}
          </h3>
        </div>
        <p style={{ fontSize: '0.83rem', opacity: 0.6, marginBottom: '16px', lineHeight: 1.6 }}>
          This sends a <strong>MetaMask transaction</strong> to call <code>token.delegate()</code> on-chain,
          then records the delegation in the DAO database. Both steps must complete before you can propose.
        </p>

        <form onSubmit={handleDelegate}>
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label className="form-label" htmlFor="delegatee" style={{ fontWeight: 600, marginBottom: '8px', display: 'block' }}>
              Delegatee Address
            </label>
            <input
              id="delegatee"
              type="text"
              className="form-input"
              placeholder="0x... (your own address = self-delegate)"
              value={delegatee}
              onChange={(e) => setDelegatee(e.target.value)}
              required
              disabled={isDelegating}
              style={{ padding: '12px' }}
            />
            {address && delegatee.toLowerCase() !== address.toLowerCase() && (
              <button
                type="button"
                onClick={() => setDelegatee(address)}
                style={{
                  marginTop: '8px', background: 'rgba(0,255,136,0.06)',
                  border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent-primary)',
                  borderRadius: '6px', padding: '5px 12px', fontSize: '0.78rem',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                }}
              >
                <Zap size={11} /> Use my own address
              </button>
            )}
            <p style={{ marginTop: '8px', fontSize: '0.78rem', opacity: 0.5, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Info size={12} />
              To vote yourself, delegate to your own address. Required for proposing or voting.
            </p>
          </div>

          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '8px', padding: '12px 16px', marginBottom: '14px',
              color: 'var(--danger)', fontSize: '0.83rem', whiteSpace: 'pre-wrap',
              display: 'flex', gap: '8px', alignItems: 'flex-start'
            }}>
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{
              width: '100%', padding: '14px', fontSize: '1rem',
              opacity: (!hasTokens && !isDelegating) ? 0.5 : 1
            }}
            disabled={isDelegating || !address}
          >
            <UserPlus size={17} />
            {isDelegating ? (delegateStep || 'Delegating...') : 'Delegate Votes'}
          </button>
          <p style={{ textAlign: 'center', fontSize: '0.75rem', opacity: 0.4, marginTop: '10px' }}>
            Sends an on-chain transaction (MetaMask required) then records in DAO database.
          </p>
        </form>

        {delegateResult && (
          <div style={{
            marginTop: '16px', padding: '14px 16px', borderRadius: '8px',
            background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <CheckCircle size={16} style={{ color: 'var(--accent-primary)' }} />
              <strong style={{ color: 'var(--accent-primary)' }}>Delegation Complete!</strong>
            </div>
            <p style={{ fontSize: '0.82rem', opacity: 0.7, marginBottom: '6px' }}>
              On-chain voting power is active. You can now create proposals.
            </p>
            {votesEth && (
              <div style={{ fontWeight: 700, color: 'var(--accent-primary)', fontSize: '0.88rem' }}>
                ✅ Active votes: {parseFloat(votesEth).toLocaleString()} GOV
              </div>
            )}
            <div style={{ opacity: 0.5, fontSize: '0.75rem', marginTop: '6px', wordBreak: 'break-all' }}>
              Tx: {delegateResult.txHash}
            </div>
          </div>
        )}
      </div>

      {/* ── CLI fallback instructions ─────────────────────────────────────── */}
      <div className="glass-panel mt-4" style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.06)', padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', opacity: 0.6 }}>
          <Info size={14} />
          <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>Alternative: CLI Setup</span>
        </div>
        <p style={{ fontSize: '0.78rem', opacity: 0.5, lineHeight: 1.6, marginBottom: '10px' }}>
          If the button above fails (e.g. PRIVATE_KEY not set), run this in the project root:
        </p>
        <div style={{
          background: 'rgba(0,0,0,0.5)', borderRadius: '6px', padding: '10px 14px',
          fontFamily: 'monospace', fontSize: '0.77rem', color: '#a3e635', overflowX: 'auto'
        }}>
          TARGET_ADDRESS={address || '0xYourAddress'} npx hardhat run scripts/mintAndSetupVoter.js --network localhost
        </div>
        <p style={{ fontSize: '0.72rem', opacity: 0.35, marginTop: '6px' }}>
          Then return here and click "Delegate Votes" to complete the on-chain delegation.
        </p>
      </div>
    </div>
  );
};

export default Delegate;
