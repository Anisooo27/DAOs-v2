import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, XCircle, MinusCircle, Search, Activity, RefreshCw, ShieldCheck, ExternalLink, Info, AlertTriangle } from 'lucide-react';
import { ethers } from 'ethers';
import config from '../config';

const Results = ({ provider, address }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProposalId = searchParams.get('proposalId') || '';
  
  const [searchQuery, setSearchQuery] = useState(initialProposalId);
  const [proposals, setProposals] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Track submission status per proposalId
  const [submitStatuses, setSubmitStatuses] = useState({});
  const [isSubmittingMap, setIsSubmittingMap] = useState({});
  // Tracks which step is currently submitting: 'tally' | 'execute' | null
  const [stepSubmitting, setStepSubmitting] = useState({});

  const OPTIONS = [
    { id: '1', label: 'For', icon: CheckCircle, color: 'var(--success)' },
    { id: '0', label: 'Against', icon: XCircle, color: 'var(--danger)' },
    { id: '2', label: 'Abstain', icon: MinusCircle, color: 'var(--text-muted)' }
  ];

  const [proposalStates, setProposalStates] = useState({});
  const [proposalQuorums, setProposalQuorums] = useState({});
  const [recipientBalances, setRecipientBalances] = useState({});

  const fetchProposals = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      const response = await fetch(config.PROPOSALS_ENDPOINT);
      const data = await response.json();
      
      if (response.ok) {
        setProposals(data);
        
        // After fetching from backend, try to fetch on-chain states
        if (provider) {
          try {
            const configRes = await fetch(config.CONFIG_ENDPOINT);
            const confData = await configRes.json();
            const GOVERNOR_ABI = [
              "function state(uint256 proposalId) public view returns (uint8)",
              "function quorum(uint256 blockNumber) public view returns (uint256)",
              "function proposalSnapshot(uint256 proposalId) public view returns (uint256)"
            ];
            const governorContract = new ethers.Contract(confData.governorAddress, GOVERNOR_ABI, provider);
            
            const states = {};
            const quorums = {};
            const balances = {};
            for (const p of data) {
              try {
                // Number() is required here because BigInt 4n !== 4 literal in switch
                const s = Number(await governorContract.state(p.proposalId));
                
                // Fetch Quorum for the block the proposal was created in
                const snapshot = await governorContract.proposalSnapshot(p.proposalId);
                const q = await governorContract.quorum(snapshot);
                
                quorums[p.proposalId] = q.toString();
                
                // Fetch Recipient Balance: try to decode treasury calldata
                let recipient = null;
                try {
                  const withdrawSig = ethers.id('withdrawETH(address,uint256)').slice(0, 10);
                  if (p.calldata && p.calldata.startsWith(withdrawSig)) {
                    const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
                    const decoded = iface.decodeFunctionData('withdrawETH', p.calldata);
                    recipient = decoded[0];
                  }
                } catch (_) {}
                if (recipient) {
                  const bal = await provider.getBalance(recipient);
                  balances[p.proposalId] = { address: recipient, balance: ethers.formatEther(bal) };
                }

                console.log(`[results] Proposal ${p.proposalId} Diagnostics:`, { 
                  state: s, 
                  snapBlock: snapshot.toString(),
                  quorumRequired: ethers.formatEther(q),
                  turnout: calculateTotal(p.results),
                  recipientBalance: balances[p.proposalId],
                  label: s === 0 ? 'Pending' : s === 1 ? 'Active' : s === 3 ? 'Defeated' : s === 4 ? 'Succeeded' : s === 5 ? 'Queued' : s === 7 ? 'Executed' : 'Other'
                });
                states[p.proposalId] = s;
              } catch (e) {
                console.warn(`Could not fetch state/quorum for ${p.proposalId}`, e);
              }
            }
            setProposalStates(states);
            setProposalQuorums(quorums);
            setRecipientBalances(balances);
            console.log(`[diag] To check state manually in Hardhat Console: const gov = await ethers.getContractAt("DAOGovernor", "${confData.governorAddress}"); await gov.state("<ID>");`);
          } catch (e) {
            console.error("Failed to fetch on-chain states", e);
          }
        }
      } else {
        setError(data.error || 'Failed to fetch proposals');
      }
    } catch (err) {
      console.error("Error fetching proposals:", err);
      setError('Could not connect to the backend server.');
    } finally {
      setIsLoading(false);
    }
  };

  // ── helper: status setter shorthand ───────────────────────────────────────
  const setStatus = (proposalId, patch) =>
    setSubmitStatuses(prev => ({ ...prev, [proposalId]: patch ? { ...prev[proposalId], ...patch } : null }));

  useEffect(() => {
    fetchProposals();
  }, [provider]); // Refresh when provider is connected

  // ... (rest of the return block needs careful update)
  // I will replace the button section in the return block next.

  const handleSearch = (e) => {
    e.preventDefault();
    setSearchParams(searchQuery ? { proposalId: searchQuery } : {});
  };

  // When search query is entered, auto-filter the proposals
  const filteredProposals = proposals.filter(p =>
    p.proposalId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.shortId && p.shortId.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // ── Step 1: Push Tally ─────────────────────────────────────────────────────
  // Calls POST /submit → mines past voting period → SUCCEEDED or DEFEATED
  const handlePushTally = async (proposal) => {
    const { proposalId } = proposal;
    setStepSubmitting(prev => ({ ...prev, [proposalId]: 'tally' }));
    setStatus(proposalId, null);
    try {
      const res  = await fetch(config.SUBMIT_ENDPOINT(proposalId), { method: 'POST' });
      const data = await res.json();
      if (data.defeated || data.state === 3) {
        setStatus(proposalId, {
          type: 'defeated',
          message: '❌ Proposal Defeated — majority voted Against or quorum not met. Execution permanently blocked.'
        });
      } else if (!res.ok) {
        throw new Error(data.error || 'Push Tally failed');
      } else {
        const logLines = Array.isArray(data.log) ? data.log : [];
        setStatus(proposalId, {
          type: 'success',
          message: logLines[logLines.length - 1] || '✅ Tally pushed — proposal Succeeded!'
        });
      }
    } catch (err) {
      console.error('[pushTally]', err);
      const isVotingActive = err.message?.includes('Voting period still active');
      setStatus(proposalId, { type: 'error', message: err.message, isVotingActive });
    } finally {
      setStepSubmitting(prev => ({ ...prev, [proposalId]: null }));
      await fetchProposals();
    }
  };

  // ── Step 2/3: Execute (handles both Queue→Execute and Execute-only) ─────────
  // For deposit proposals: triggers MetaMask send directly.
  // For standard proposals: calls POST /execute → queue → timelock → execute.
  const handleExecute = async (proposal) => {
    const { proposalId, direction, target, value, amount } = proposal;
    setStepSubmitting(prev => ({ ...prev, [proposalId]: 'execute' }));
    setStatus(proposalId, null);
    try {
      // ── Deposit: manual MetaMask send ──────────────────────────────────────
      if (direction === 'deposit') {
        if (!provider) throw new Error('Please connect your wallet to execute this deposit.');
        setStatus(proposalId, { type: 'info', message: '⏳ MetaMask will prompt you to send ETH from your wallet to the Treasury.' });
        const signer = await provider.getSigner();
        const userAddress = await signer.getAddress();
        let depositValueWei;
        const amountNum = parseFloat(amount);
        const valueNum  = parseFloat(value);
        if (amount && amountNum > 0) {
          depositValueWei = ethers.parseEther(amount.toString());
        } else if (value && valueNum > 0) {
          const valueBig = BigInt(Math.round(valueNum));
          depositValueWei = valueBig > 1000000000000000n ? valueBig : ethers.parseEther(value.toString());
        } else {
          throw new Error(`Deposit amount is zero or missing. amount="${amount}", value="${value}".`);
        }
        const userBalBefore     = await provider.getBalance(userAddress);
        const treasuryBalBefore = await provider.getBalance(target);
        const tx = await signer.sendTransaction({ to: target, value: depositValueWei });
        await tx.wait();
        const userBalAfter     = await provider.getBalance(userAddress);
        const treasuryBalAfter = await provider.getBalance(target);
        const tDiff = treasuryBalAfter - treasuryBalBefore;
        const wDiff = userBalAfter - userBalBefore;
        const proof = {
          recipient:     target, label: 'Treasury (Deposit)', direction: 'deposit',
          txHash:        tx.hash,
          balanceBefore: ethers.formatEther(treasuryBalBefore),
          balanceAfter:  ethers.formatEther(treasuryBalAfter),
          netChange:     ethers.formatEther(tDiff < 0n ? -tDiff : tDiff),
          netSign:       tDiff >= 0n ? '+' : '-',
          walletImpact:  ethers.formatEther(wDiff < 0n ? -wDiff : wDiff),
          walletSign:    wDiff >= 0n ? '+' : '-'
        };
        await fetch(`http://localhost:5000/proposals/${proposalId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'EXECUTED' })
        }).catch(() => {});
        setStatus(proposalId, {
          type: 'success',
          message: `✅ Deposit confirmed! Sent ${amount || ethers.formatEther(depositValueWei)} ETH to the Treasury.`,
          proof
        });
        await fetchProposals();
        return;
      }

      // ── Standard: backend relayer (queue → timelock → execute) ────────────
      const res  = await fetch(config.EXECUTE_ENDPOINT(proposalId), { method: 'POST' });
      const data = await res.json();
      if (data.defeated || data.state === 3) {
        setStatus(proposalId, {
          type: 'defeated',
          message: '❌ Proposal Defeated — majority voted Against or quorum not met. Execution blocked.'
        });
      } else if (data.votingActive || data.state === 1) {
        setStatus(proposalId, {
          type: 'error', isVotingActive: true,
          message: data.error || 'Voting period still active — push tally first.'
        });
      } else if (!res.ok) {
        throw new Error(data.error || data.details || 'Execute failed');
      } else {
        const logLines = Array.isArray(data.log) ? data.log : [];
        const successMsg = data.proof
          ? `✅ Executed! ${data.proof.recipient?.slice(0,10)}… ${data.proof.balanceBefore} → ${data.proof.balanceAfter} ETH (${data.proof.netSign ?? '+'}${data.proof.netChange} ETH)`
          : logLines[logLines.length - 1] || '✅ Executed!';
        setStatus(proposalId, { type: 'success', message: successMsg, proof: data.proof, log: logLines });
      }
    } catch (err) {
      console.error('[execute]', err);
      const isDefeated    = err.message?.includes('defeated') || err.message?.includes('majority voted');
      const isVotingActive = err.message?.includes('Voting period still active');
      setStatus(proposalId, { type: 'error', message: err.message, isDefeated, isVotingActive });
    } finally {
      setStepSubmitting(prev => ({ ...prev, [proposalId]: null }));
      await fetchProposals();
    }
  };


  function stateLabel(s) {
    return ['Pending','Active','Canceled','Defeated','Succeeded','Queued','Expired','Executed'][s] ?? `State ${s}`;
  }

  const calculateTotal = (res) => {
    if (!res) return 0;
    return (res['0'] || 0) + (res['1'] || 0) + (res['2'] || 0);
  };

  const calculatePercentage = (count, total) => {
    if (total === 0) return 0;
    return Math.round((count / total) * 100);
  };

  return (
    <div className="form-container" style={{ maxWidth: '800px' }}>
      <div className="page-header">
        <h1 className="page-title">Voting Results</h1>
        <p className="page-subtitle">Real-time off-chain aggregation of all DAO proposals.</p>
      </div>

      <div className="glass-panel mb-4">
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '12px' }}>
          <div className="form-group mb-0" style={{ flexGrow: 1 }}>
            <input
              type="text"
              className="form-input"
              placeholder="Search by Proposal ID or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ padding: '0 24px' }}>
            <Search size={18} /> Search
          </button>
        </form>
      </div>

      <div className="flex justify-between items-center mb-4">
        <h3 style={{ fontSize: '1.25rem', color: 'var(--text-main)' }}>All Proposals</h3>
        <button 
          className="btn" 
          style={{ padding: '6px 12px', fontSize: '0.9rem' }}
          onClick={fetchProposals}
          disabled={isLoading}
        >
          <RefreshCw size={14} className={isLoading ? 'spin' : ''} /> Refresh List
        </button>
      </div>

      {isLoading && proposals.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '40px' }}>
          <Activity className="text-accent" size={32} style={{ animation: 'spin 2s linear infinite', margin: '0 auto 16px' }} />
          <p className="text-muted">Loading proposals framework...</p>
        </div>
      )}

      {error && (
        <div className="glass-panel mb-4" style={{ borderLeft: '4px solid var(--danger)' }}>
          <h4 style={{ color: 'var(--danger)', marginBottom: '4px' }}>Error</h4>
          <p className="text-muted">{error}</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {!isLoading && filteredProposals.length === 0 && !error && (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '40px' }}>
            <Info className="text-muted" size={32} style={{ margin: '0 auto 16px' }} />
            <p className="text-muted">No proposals found matching your criteria.</p>
          </div>
        )}

        {filteredProposals.map(proposal => {
          const totalVotes = calculateTotal(proposal.results);
          const submitStatus = submitStatuses[proposal.proposalId];
          const isSubmitting = isSubmittingMap[proposal.proposalId];

          return (
            <div key={proposal.proposalId} className="glass-panel">
              <div className="flex justify-between items-start mb-4 pb-4" style={{ borderBottom: '1px solid var(--panel-border)' }}>
                <div>
                  {/* Short ID badge + full ID */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    {proposal.shortId && (
                      <span style={{
                        fontSize: '0.85rem', fontWeight: 700,
                        background: 'rgba(139, 92, 246, 0.15)',
                        color: '#a78bfa',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        padding: '2px 10px', borderRadius: '20px'
                      }}>
                        {proposal.shortId}
                      </span>
                    )}
                    <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', fontFamily: 'monospace', margin: 0 }}>
                      {proposal.proposalId.slice(0, 12)}…
                    </h3>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.75rem', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-muted)' }}>
                      On-chain State: {proposalStates[proposal.proposalId] !== undefined ? proposalStates[proposal.proposalId] : '...'}
                    </span>
                    <span style={{ fontSize: '0.75rem', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', color: 'var(--accent-secondary)' }}>
                      DB Status: {proposal.status}
                    </span>
                    {proposal.securedVotes > 0 && (
                      <span style={{ fontSize: '0.75rem', background: 'rgba(0,255,136,0.08)', padding: '2px 8px', borderRadius: '4px', color: 'var(--accent-primary)', border: '1px solid rgba(0,255,136,0.2)' }}>
                        🔒 {proposal.securedVotes} cryptographic proof{proposal.securedVotes > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  <p className="text-muted" style={{ fontSize: '0.95rem', lineHeight: 1.5, marginBottom: '8px' }}>
                    {proposal.description}
                  </p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Proposer: <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{proposal.proposerAddress}</span>
                  </p>
                  {recipientBalances[proposal.proposalId] && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-main)', marginTop: '4px' }}>
                      <ShieldCheck size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                      Recipient ({recipientBalances[proposal.proposalId].address?.slice(0,10)}…) Balance:{' '}
                      <span style={{ fontWeight: 600 }}>{recipientBalances[proposal.proposalId].balance || recipientBalances[proposal.proposalId]} ETH</span>
                    </p>
                  )}
                </div>
              {/* Status badge: rich multi-state */}
              {(() => {
                const s = proposalStates[proposal.proposalId];
                const dbStatus = proposal.status;
                // Prefer on-chain state; fall back to DB status
                const isDefeated  = s === 3 || dbStatus === 'DEFEATED';
                const isSucceeded = s === 4 && dbStatus !== 'EXECUTED';
                const isExecuted  = s === 7 || dbStatus === 'EXECUTED';
                const isQueued    = s === 5;
                const isActive    = s === 1;
                const isPending   = s === 0;

                if (isDefeated) return (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'rgba(239,68,68,0.15)', color: '#f87171',
                    border: '1px solid rgba(239,68,68,0.35)',
                    padding: '3px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 700
                  }}>
                    <XCircle size={12} /> Defeated
                  </div>
                );
                if (isExecuted) return (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'rgba(56,189,248,0.12)', color: 'var(--accent-primary)',
                    border: '1px solid rgba(56,189,248,0.25)',
                    padding: '3px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 700
                  }}>
                    <CheckCircle size={12} /> Executed
                  </div>
                );
                if (isSucceeded) return (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'rgba(16,185,129,0.12)', color: '#34d399',
                    border: '1px solid rgba(16,185,129,0.3)',
                    padding: '3px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 700
                  }}>
                    <CheckCircle size={12} /> Succeeded
                  </div>
                );
                if (isQueued) return (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
                    border: '1px solid rgba(251,191,36,0.3)',
                    padding: '3px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 700
                  }}>
                    Queued
                  </div>
                );
                if (isActive) return (
                  <div className="badge badge-success">Active</div>
                );
                if (isPending) return (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    background: 'rgba(148,163,184,0.1)', color: '#94a3b8',
                    border: '1px solid rgba(148,163,184,0.2)',
                    padding: '3px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 700
                  }}>
                    Pending
                  </div>
                );
                return <div className="badge badge-success">{dbStatus || 'Active'}</div>;
              })()}
              </div>

              <p className="text-muted mb-4" style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span>Total Turnout: <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>{totalVotes} Votes</span></span>
                {proposalQuorums[proposal.proposalId] !== undefined && (
                  <span style={{ 
                    padding: '2px 8px', 
                    borderRadius: '4px', 
                    fontSize: '0.75rem',
                    background: Number(proposalQuorums[proposal.proposalId]) === 0 ? 'rgba(56, 189, 248, 0.1)' : (totalVotes >= Number(ethers.formatEther(proposalQuorums[proposal.proposalId])) ? 'rgba(0, 255, 136, 0.1)' : 'rgba(239, 68, 68, 0.1)'),
                    color: Number(proposalQuorums[proposal.proposalId]) === 0 ? 'var(--accent-secondary)' : (totalVotes >= Number(ethers.formatEther(proposalQuorums[proposal.proposalId])) ? 'var(--accent-primary)' : 'var(--danger)'),
                    border: `1px solid ${Number(proposalQuorums[proposal.proposalId]) === 0 ? 'rgba(56, 189, 248, 0.2)' : (totalVotes >= Number(ethers.formatEther(proposalQuorums[proposal.proposalId])) ? 'rgba(0, 255, 136, 0.2)' : 'rgba(239, 68, 68, 0.2)')}`
                  }}>
                    {Number(proposalQuorums[proposal.proposalId]) === 0 
                      ? "Quorum: 0% (Demo Mode Enabled)" 
                      : `Quorum: ${ethers.formatEther(proposalQuorums[proposal.proposalId])} required (${totalVotes >= Number(ethers.formatEther(proposalQuorums[proposal.proposalId])) ? 'MET' : 'NOT MET'})`
                    }
                  </span>
                )}
              </p>

              {/* Defeat Alert Banner */}
              {(proposalStates[proposal.proposalId] === 3 || proposal.status === 'DEFEATED') && (
                <div style={{
                  margin: '12px 0 16px',
                  padding: '14px 16px',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderLeft: '4px solid #ef4444',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  fontSize: '0.875rem'
                }}>
                  <AlertTriangle size={18} style={{ color: '#f87171', flexShrink: 0, marginTop: '1px' }} />
                  <div>
                    <p style={{ color: '#f87171', fontWeight: 700, marginBottom: '2px' }}>❌ Proposal Defeated</p>
                    <p style={{ color: 'var(--text-muted)', margin: 0 }}>
                      Majority voted <strong>Against</strong> (or quorum not met). Execution is permanently blocked for this proposal.
                    </p>
                  </div>
                </div>
              )}

              {/* Quorum-only defeat note (no majority defeat — just quorum) */}
              {proposalStates[proposal.proposalId] === 3
                && proposal.status !== 'DEFEATED'
                && (() => {
                  const q = proposalQuorums[proposal.proposalId];
                  const totalVotes = calculateTotal(proposal.results);
                  if (!q || Number(q) === 0) return null;
                  const qNum = Number(ethers.formatEther(q));
                  if (totalVotes >= qNum) return null; // quorum met — this was a majority defeat
                  return (
                    <div style={{
                      marginBottom: '16px', padding: '10px 14px',
                      background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)',
                      borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px',
                      fontSize: '0.82rem', color: 'var(--text-muted)'
                    }}>
                      <Info size={14} style={{ color: 'var(--danger)' }} />
                      <span><strong>Quorum Not Met:</strong> {qNum.toFixed(0)} votes required — only {totalVotes} cast.</span>
                    </div>
                  );
                })()
              }

              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '24px' }}>
                {OPTIONS.map(opt => {
                  const Icon = opt.icon;
                  const count = proposal.results ? (proposal.results[opt.id] || 0) : 0;
                  const percentage = calculatePercentage(count, totalVotes);

                  return (
                    <div key={opt.id}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Icon size={16} style={{ color: opt.color }} />
                          <span style={{ fontWeight: 500, fontSize: '0.95rem' }}>{opt.label}</span>
                        </div>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: '1rem', marginRight: '8px' }}>{percentage}%</span>
                          <span className="text-muted" style={{ fontSize: '0.85rem' }}>({count} votes)</span>
                        </div>
                      </div>
                      <div className="progress-bg" style={{ height: '6px' }}>
                        <div 
                          className="progress-fill" 
                          style={{ 
                            width: `${percentage}%`,
                            background: opt.color === 'var(--success)' ? 'var(--success)' : opt.color === 'var(--danger)' ? 'var(--danger)' : 'var(--text-muted)'
                          }} 
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--panel-border)' }}>
                {/* ── Step progress indicator ──────────────────────────────── */}
                {(() => {
                  const s   = proposalStates[proposal.proposalId];
                  const db  = proposal.status;
                  const STAGES = [
                    { key: 'tally',   chainState: 1, step: 1, label: 'Push Tally' },
                    { key: 'queue',   chainState: 4, step: 2, label: 'Queue' },
                    { key: 'execute', chainState: 5, step: 3, label: 'Execute' }
                  ];
                  const defeated = s === 3 || db === 'DEFEATED';
                  return (
                    <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
                      {STAGES.map(stage => {
                        const active    = s === stage.chainState;
                        const completed = !defeated && (s > stage.chainState || db === 'EXECUTED'
                          || (stage.chainState === 4 && s === 5));
                        const pill = {
                          display: 'flex', alignItems: 'center', gap: '4px',
                          padding: '4px 12px', borderRadius: '20px',
                          fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
                          background: defeated
                            ? 'rgba(239,68,68,0.08)'
                            : active    ? 'rgba(0,255,136,0.1)'
                            : completed ? 'rgba(255,255,255,0.05)' : 'transparent',
                          color: defeated
                            ? 'rgba(248,113,113,0.6)'
                            : active    ? 'var(--accent-primary)'
                            : completed ? 'var(--text-muted)' : 'rgba(255,255,255,0.2)',
                          border: `1px solid ${active && !defeated ? 'var(--accent-primary)' : 'transparent'}`
                        };
                        return (
                          <div key={stage.key} style={pill}>
                            {completed ? <CheckCircle size={12}/> : defeated ? <XCircle size={12}/> : <span>{stage.step}</span>}
                            {stage.label}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* ── Per-stage action buttons ─────────────────────────────── */}
                {(() => {
                  const s          = proposalStates[proposal.proposalId];
                  const db         = proposal.status;
                  const isDeposit  = proposal.direction === 'deposit';
                  const isDefeated = s === 3 || db === 'DEFEATED';
                  const isDone     = s === 7 || db === 'EXECUTED';
                  const tallyBusy  = stepSubmitting[proposal.proposalId] === 'tally';
                  const execBusy   = stepSubmitting[proposal.proposalId] === 'execute';

                  const btnBase = {
                    width: '100%', padding: '12px', fontSize: '0.95rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                  };

                  if (isDone) return (
                    <div style={{ ...btnBase, background: 'rgba(56,189,248,0.07)',
                      border: '1px solid rgba(56,189,248,0.2)', borderRadius: '8px',
                      color: 'var(--accent-primary)', fontWeight: 600, fontSize: '0.9rem' }}>
                      <CheckCircle size={16}/> Proposal Executed — Complete
                    </div>
                  );

                  if (isDefeated) return (
                    <div style={{ ...btnBase, background: 'rgba(239,68,68,0.08)',
                      border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px',
                      color: '#f87171', fontWeight: 600, fontSize: '0.9rem',
                      flexDirection: 'column', gap: '4px' }}>
                      <span><XCircle size={15} style={{verticalAlign:'middle',marginRight:'6px'}}/>Proposal Defeated — Cannot Execute</span>
                      <span style={{fontSize:'0.78rem',opacity:0.7,fontWeight:400}}>Majority voted Against or quorum not met.</span>
                    </div>
                  );

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {/* Push Tally — shown when Active (1) */}
                      {s === 1 && (
                        <button onClick={() => handlePushTally(proposal)}
                          disabled={tallyBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={tallyBusy ? 'spin' : ''}/>
                          {tallyBusy ? 'Pushing Tally…' : '📊 Push Tally to Chain'}
                        </button>
                      )}

                      {/* Queue & Execute — shown when Succeeded (4) */}
                      {s === 4 && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Queueing & Executing…' : '🚀 Queue & Execute'}
                        </button>
                      )}

                      {/* Execute Now — shown when Queued (5) */}
                      {s === 5 && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Executing…' : '⚡ Execute Now'}
                        </button>
                      )}

                      {/* Deposit: Send ETH — shown when tally done but not yet executed */}
                      {isDeposit && (s === 4 || s === 5 || s === undefined) && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Sending ETH…' : '💳 Send ETH to Treasury'}
                        </button>
                      )}

                      {/* Pending — waiting for activation */}
                      {s === 0 && (
                        <div style={{ ...btnBase, background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px',
                          color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                          ⏳ Pending — awaiting voting delay…
                        </div>
                      )}

                      {/* Active (voting) — no tally button for deposit */}
                      {s === 1 && isDeposit && (
                        <div style={{ ...btnBase, background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px',
                          color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                          🗳️ Voting in Progress — cast your votes then push tally
                        </div>
                      )}

                      {/* Unknown state — prompt refresh */}
                      {s === undefined && !isDeposit && (
                        <button onClick={fetchProposals} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16}/> Refresh State
                        </button>
                      )}
                    </div>
                  );
                })()}

                {submitStatus && (() => {
                  const t = submitStatus.type;
                  const isDefeated    = t === 'defeated' || submitStatus.isDefeated;
                  const isVotingActive = submitStatus.isVotingActive;
                  const isInfo        = t === 'info';
                  const isSuccess     = t === 'success';
                  const bg    = isSuccess ? 'rgba(16,185,129,0.05)' : isVotingActive ? 'rgba(251,191,36,0.08)' : isDefeated ? 'rgba(239,68,68,0.08)' : isInfo ? 'rgba(56,189,248,0.07)' : 'rgba(239,68,68,0.05)';
                  const bc    = isSuccess ? 'rgba(16,185,129,0.2)'  : isVotingActive ? 'rgba(251,191,36,0.35)' : isDefeated ? 'rgba(239,68,68,0.3)'  : isInfo ? 'rgba(56,189,248,0.2)'  : 'rgba(239,68,68,0.2)';
                  const bleft = isVotingActive ? '4px solid #fbbf24' : isDefeated ? '4px solid #ef4444' : isInfo ? '4px solid var(--accent-secondary)' : undefined;
                  const labelColor = isSuccess ? 'var(--success)' : isVotingActive ? '#fbbf24' : isInfo ? 'var(--accent-secondary)' : 'var(--danger)';
                  const label = isSuccess ? '✅ Success' : isVotingActive ? '🗳️ Voting Active' : isDefeated ? '❌ Proposal Defeated' : isInfo ? 'ℹ️ Action Required' : '❌ Error';
                  return (
                    <div className="mt-3" style={{ background: bg, borderColor: bc, borderLeft: bleft, borderWidth: '1px', borderStyle: 'solid', borderRadius: '8px', padding: '12px' }}>
                      <span style={{ color: labelColor, fontWeight: 600 }}>{label}</span>
                      <p style={{ fontSize: '0.85rem', marginTop: '4px', color: 'var(--text-muted)' }}>{submitStatus.message}</p>
                      {submitStatus.proof && (
                        <div style={{ marginTop: '10px', padding: '10px', background: 'rgba(0,255,136,0.05)', borderRadius: '6px', border: '1px solid rgba(0,255,136,0.15)' }}>
                          <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '6px' }}>⚡ ETH Transfer Proof</p>
                          <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                            <tbody>
                              <tr><td style={{ color: 'var(--text-muted)', paddingRight: '12px' }}>Recipient</td><td style={{ fontFamily: 'monospace', color: 'var(--text-main)' }}>{submitStatus.proof.recipient}</td></tr>
                              <tr><td style={{ color: 'var(--text-muted)' }}>Before</td><td style={{ color: 'var(--text-main)' }}>{submitStatus.proof.balanceBefore} ETH</td></tr>
                              <tr><td style={{ color: 'var(--text-muted)' }}>After</td><td style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{submitStatus.proof.balanceAfter} ETH</td></tr>
                              <tr><td style={{ color: 'var(--text-muted)' }}>Net Change</td><td style={{ color: 'var(--success)', fontWeight: 700 }}>{submitStatus.proof.netSign ?? '+'}{submitStatus.proof.netChange} ETH</td></tr>
                              {submitStatus.proof.walletImpact && (
                                <tr>
                                  <td style={{ color: 'var(--text-muted)' }}>Wallet Impact</td>
                                  <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{submitStatus.proof.walletSign}{submitStatus.proof.walletImpact} ETH (incl. gas)</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Results;
