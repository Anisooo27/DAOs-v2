import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, XCircle, MinusCircle, Search, Activity, RefreshCw, ShieldCheck, ExternalLink, Info } from 'lucide-react';
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

  const getButtonProps = (proposal) => {
    const onChainState = proposalStates[proposal.proposalId];
    const totalVotes = calculateTotal(proposal.results);
    const isExecuted = proposal.status === 'EXECUTED';

    if (isExecuted) return { label: 'Already Executed', disabled: true, variant: 'secondary' };
    if (totalVotes === 0) return { label: 'No Votes Yet', disabled: true, variant: 'primary' };

    switch (onChainState) {
      case 0: return { label: 'Activate Proposal',  disabled: false, variant: 'primary' }; // Pending
      case 1: return { label: 'Push Tally to Chain', disabled: false, variant: 'primary' }; // Active
      case 2: return { label: 'Proposal Canceled',   disabled: true,  variant: 'secondary' }; // Canceled
      case 3: return { label: 'Proposal Defeated',   disabled: true,  variant: 'danger'    }; // Defeated
      case 4: return { label: 'Queue & Execute',     disabled: false, variant: 'primary' }; // Succeeded
      case 5: return { label: 'Execute Now',         disabled: false, variant: 'primary' }; // Queued
      case 6: return { label: 'Proposal Expired',    disabled: true,  variant: 'danger'    }; // Expired
      case 7: return { label: 'Proposal Executed',   disabled: true,  variant: 'success'   }; // Executed
      case undefined: return { label: 'Check State...', disabled: false, variant: 'primary' };
      default: return { label: `State ${onChainState}: Run Action`, disabled: false, variant: 'primary' };
    }
  };

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

  const handleSubmitTally = async (proposalId) => {
    setIsSubmittingMap(prev => ({ ...prev, [proposalId]: true }));
    try {
      const response = await fetch(config.SUBMIT_ENDPOINT(proposalId), {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to submit tally script');
      alert(`Tally Script Triggered! Success.`);
      await fetchProposals(); 
    } catch (err) {
      console.error("Error triggering tally:", err);
      alert(err.message);
    } finally {
      setIsSubmittingMap(prev => ({ ...prev, [proposalId]: false }));
    }
  };

  const handleFinalizeAction = async (proposal) => {
    const { proposalId } = proposal;
    const onChainState = proposalStates[proposalId];
    setIsSubmittingMap(prev => ({ ...prev, [proposalId]: true }));
    try {
      let endpoint;
      
      if (onChainState === 1 || onChainState === 0) {
        // Pending or Active → push tally on-chain
        endpoint = config.SUBMIT_ENDPOINT(proposalId);
      } else if (onChainState === 4 || onChainState === 5 || onChainState === undefined) {
        // Succeeded, Queued, or unknown → run full finalization
        endpoint = config.EXECUTE_ENDPOINT(proposalId);
      } else {
        throw new Error(`Cannot act on proposal in state ${onChainState} (${stateLabel(onChainState)}).`);
      }

      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.details || 'Action failed');
      
      // Build status message from log array or message field
      const logLines = Array.isArray(data.log) ? data.log : [];
      const successMsg = data.proof
        ? `✅ Executed! ${data.proof.recipient?.slice(0,10)}… ${data.proof.balanceBefore} → ${data.proof.balanceAfter} ETH (${data.proof.netSign ?? '+'}${data.proof.netChange} ETH)`
        : logLines[logLines.length - 1] || 'Action completed.';

      console.log('[lifecycle] Log:', logLines);
      if (data.proof) console.log('[lifecycle] ETH Transfer Proof:', data.proof);

      setSubmitStatuses(prev => ({
        ...prev,
        [proposalId]: { type: 'success', message: successMsg, proof: data.proof, log: logLines }
      }));
      await fetchProposals();
    } catch (err) {
      console.error('Error triggering action:', err);
      setSubmitStatuses(prev => ({
        ...prev,
        [proposalId]: { type: 'error', message: err.message }
      }));
    } finally {
      setIsSubmittingMap(prev => ({ ...prev, [proposalId]: false }));
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
                {proposal.status === 'EXECUTED' ? (
                  <div className="badge" style={{ background: 'rgba(56, 189, 248, 0.1)', color: 'var(--accent-primary)', borderColor: 'rgba(56, 189, 248, 0.2)' }}>Executed</div>
                ) : (
                  <div className="badge badge-success">Active</div>
                )}
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

              {proposalStates[proposal.proposalId] === 3 && totalVotes < Number(ethers.formatEther(proposalQuorums[proposal.proposalId] || '0')) && (
                <div className="alert alert-info" style={{ 
                  margin: '12px 0 24px', 
                  padding: '12px', 
                  background: 'rgba(239, 68, 68, 0.05)', 
                  border: '1px solid rgba(239, 68, 68, 0.1)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '0.85rem',
                  color: 'var(--text-muted)'
                }}>
                  <Info size={16} className="text-danger" />
                  <span>
                    <strong>Quorum Not Met:</strong> This proposal is Defeated because it didn't reach the 40,000 token threshold. 
                    <em> (Note: In Demo Mode with 0% Quorum, this usually means the Voting Period ended before the Tally was pushed.)</em>
                  </span>
                </div>
              )}

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
                <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
                  {[
                    { state: 1, label: 'Push Tally' },
                    { state: 4, label: 'Queue' },
                    { state: 5, label: 'Execute' }
                  ].map(stage => {
                    const active = proposalStates[proposal.proposalId] === stage.state;
                    const completed = proposalStates[proposal.proposalId] > stage.state || proposal.status === 'EXECUTED';
                    return (
                      <div key={stage.state} style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '4px',
                        padding: '4px 12px',
                        borderRadius: '20px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        background: active ? 'rgba(0, 255, 136, 0.1)' : completed ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                        color: active ? 'var(--accent-primary)' : completed ? 'var(--text-muted)' : 'rgba(255, 255, 255, 0.2)',
                        border: `1px solid ${active ? 'var(--accent-primary)' : 'transparent'}`
                      }}>
                        {completed ? <CheckCircle size={12} /> : <span>{stage.state === 1 ? '1' : stage.state === 4 ? '2' : '3'}</span>}
                        {stage.label}
                      </div>
                    );
                  })}
                </div>

                {(() => {
                  const props = getButtonProps(proposal);
                  return (
                    <button 
                      onClick={() => handleFinalizeAction(proposal)}
                      className={`btn ${props.variant === 'danger' ? 'btn-danger' : 'btn-primary'}`} 
                      style={{ 
                        width: '100%', 
                        padding: '12px', 
                        fontSize: '0.95rem', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        gap: '8px',
                        opacity: props.disabled ? 0.6 : 1
                      }}
                      disabled={isSubmitting || props.disabled}
                    >
                      <RefreshCw size={16} className={isSubmitting ? 'spin' : ''} />
                      {isSubmitting ? 'Processing...' : props.label}
                    </button>
                  );
                })()}

                {submitStatus && (
                  <div className="mt-3" style={{ 
                    background: submitStatus.type === 'success' ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)', 
                    borderColor: submitStatus.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                    borderWidth: '1px', borderStyle: 'solid', borderRadius: '8px', padding: '12px'
                  }}>
                    <span style={{ color: submitStatus.type === 'success' ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
                      {submitStatus.type === 'success' ? '✅ Success' : '❌ Error'}
                    </span>
                    <p style={{ fontSize: '0.85rem', marginTop: '4px', color: 'var(--text-muted)' }}>{submitStatus.message}</p>
                    {/* ETH Transfer Proof Panel */}
                    {submitStatus.proof && (
                      <div style={{ marginTop: '10px', padding: '10px', background: 'rgba(0,255,136,0.05)', borderRadius: '6px', border: '1px solid rgba(0,255,136,0.15)' }}>
                        <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '6px' }}>⚡ ETH Transfer Proof</p>
                        <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                          <tbody>
                            <tr><td style={{ color: 'var(--text-muted)', paddingRight: '12px' }}>Recipient</td><td style={{ fontFamily: 'monospace', color: 'var(--text-main)' }}>{submitStatus.proof.recipient}</td></tr>
                            <tr><td style={{ color: 'var(--text-muted)' }}>Before</td><td style={{ color: 'var(--text-main)' }}>{submitStatus.proof.balanceBefore} ETH</td></tr>
                            <tr><td style={{ color: 'var(--text-muted)' }}>After</td><td style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{submitStatus.proof.balanceAfter} ETH</td></tr>
                            <tr><td style={{ color: 'var(--text-muted)' }}>Net Change</td><td style={{ color: 'var(--success)', fontWeight: 700 }}>{submitStatus.proof.netSign ?? '+'}{submitStatus.proof.netChange} ETH</td></tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Results;
