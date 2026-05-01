import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, XCircle, MinusCircle, Search, Activity, RefreshCw, ShieldCheck, Info, AlertTriangle } from 'lucide-react';
import { ethers } from 'ethers';
import config from '../config';

const Results = ({ provider, address }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProposalId = searchParams.get('proposalId') || '';
  
  const [searchQuery, setSearchQuery] = useState(initialProposalId);
  const [proposals, setProposals] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const [submitStatuses, setSubmitStatuses] = useState({});
  const [isSubmittingMap, setIsSubmittingMap] = useState({});
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
      
      if (!provider) {
        setIsLoading(false);
        return; // wait for provider
      }

      const configRes = await fetch(config.CONFIG_ENDPOINT);
      const confData = await configRes.json();
      
      const GOVERNOR_ABI = [
        "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)",
        "function state(uint256 proposalId) public view returns (uint8)",
        "function quorum(uint256 blockNumber) public view returns (uint256)",
        "function proposalSnapshot(uint256 proposalId) public view returns (uint256)",
        "function proposalVotes(uint256 proposalId) public view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)"
      ];
      
      const governorContract = new ethers.Contract(confData.governorAddress, GOVERNOR_ABI, provider);
      
      const events = await governorContract.queryFilter('ProposalCreated');
      
      const parsedProposals = [];
      const states = {};
      const quorums = {};
      const balances = {};
      
      for (const evt of events) {
        const [proposalId, proposer, targets, values, signatures, calldatas, startBlock, endBlock, cid] = evt.args;
        
        let metadata = {
          description: cid,
          direction: 'general',
          target: targets[0] || '0x0000000000000000000000000000000000000000',
          value: values[0]?.toString() || '0',
          calldata: calldatas[0] || '0x'
        };

        try {
          const res = await fetch(`http://localhost:5000/ipfs/gateway/${cid}`);
          if (res.ok) {
            metadata = await res.json();
          }
        } catch (e) {
          // ignore
        }
        
        const pStr = proposalId.toString();
        
        parsedProposals.push({
          proposalId: pStr,
          shortId: `P-${pStr.slice(0, 6)}`,
          proposerAddress: proposer,
          description: metadata.description,
          target: metadata.target,
          value: metadata.value,
          calldata: metadata.calldata,
          direction: metadata.direction,
          cid: cid,
          securedVotes: 0 // removed offchain db references
        });

        try {
          const s = Number(await governorContract.state(proposalId));
          states[pStr] = s;
          
          const snapshot = await governorContract.proposalSnapshot(proposalId);
          if (snapshot > 0n) {
            const q = await governorContract.quorum(snapshot);
            quorums[pStr] = q.toString();
          } else {
            quorums[pStr] = "0";
          }
          
          const votes = await governorContract.proposalVotes(proposalId);
          const resObj = parsedProposals[parsedProposals.length - 1];
          resObj.results = {
            '0': Number(ethers.formatEther(votes[0])),
            '1': Number(ethers.formatEther(votes[1])),
            '2': Number(ethers.formatEther(votes[2]))
          };
          
          let recipient = null;
          try {
            const withdrawSig = ethers.id('withdrawETH(address,uint256)').slice(0, 10);
            if (metadata.calldata && metadata.calldata.startsWith(withdrawSig)) {
              const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
              const decoded = iface.decodeFunctionData('withdrawETH', metadata.calldata);
              recipient = decoded[0];
            }
          } catch (_) {}
          
          if (recipient) {
            const bal = await provider.getBalance(recipient);
            balances[pStr] = { address: recipient, balance: ethers.formatEther(bal) };
          }
        } catch (e) {
          console.warn(`Could not fetch state/quorum for ${pStr}`, e);
        }
      }
      
      setProposals(parsedProposals.reverse());
      setProposalStates(states);
      setProposalQuorums(quorums);
      setRecipientBalances(balances);
      
    } catch (err) {
      console.error("Error fetching proposals:", err);
      setError('Could not fetch proposals from blockchain.');
    } finally {
      setIsLoading(false);
    }
  };

  const setStatus = (proposalId, patch) =>
    setSubmitStatuses(prev => ({ ...prev, [proposalId]: patch ? { ...prev[proposalId], ...patch } : null }));

  useEffect(() => {
    fetchProposals();
  }, [provider]);

  const handleSearch = (e) => {
    e.preventDefault();
    setSearchParams(searchQuery ? { proposalId: searchQuery } : {});
  };

  const filteredProposals = proposals.filter(p =>
    p.proposalId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.shortId && p.shortId.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleAdvanceToVoting = async (proposal) => {
    const { proposalId } = proposal;
    setStepSubmitting(prev => ({ ...prev, [proposalId]: 'advance' }));
    setStatus(proposalId, null);
    try {
      const configRes = await fetch(config.CONFIG_ENDPOINT);
      const confData = await configRes.json();
      const governorContract = new ethers.Contract(confData.governorAddress, ["function votingDelay() public view returns (uint256)", "function state(uint256 proposalId) public view returns (uint8)"], provider);
      
      const vDelay = await governorContract.votingDelay();
      
      const res = await fetch('http://localhost:5000/rpc/mine', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: Number(vDelay) + 1 })
      });
      if (!res.ok) throw new Error('Failed to mine blocks to advance to voting');
      
      setStatus(proposalId, { type: 'success', message: 'Blocks mined. Voting is now active!' });
    } catch (err) {
      console.error('[advance]', err);
      setStatus(proposalId, { type: 'error', message: err.message });
    } finally {
      setStepSubmitting(prev => ({ ...prev, [proposalId]: null }));
      await fetchProposals();
    }
  };

  const handlePushTally = async (proposal) => {
    const { proposalId } = proposal;
    setStepSubmitting(prev => ({ ...prev, [proposalId]: 'tally' }));
    setStatus(proposalId, null);
    try {
      const configRes = await fetch(config.CONFIG_ENDPOINT);
      const confData = await configRes.json();
      const governorContract = new ethers.Contract(confData.governorAddress, ["function votingPeriod() public view returns (uint256)", "function state(uint256 proposalId) public view returns (uint8)"], provider);
      
      const votingPeriod = await governorContract.votingPeriod();
      
      const res = await fetch('http://localhost:5000/rpc/mine', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: Number(votingPeriod) + 1, proposalId })
      });
      if (!res.ok) throw new Error('Failed to mine blocks to advance tally');
      
      const s = Number(await governorContract.state(proposalId));
      if (s === 3) {
        setStatus(proposalId, {
          type: 'defeated',
          message: '❌ Proposal Defeated — majority voted Against or quorum not met. Execution permanently blocked.'
        });
      } else if (s === 4) {
        setStatus(proposalId, {
          type: 'success',
          message: '✅ Tally pushed — proposal Succeeded!'
        });
      } else {
        setStatus(proposalId, { type: 'info', message: `Block mined. Proposal state is now ${s}.` });
      }
    } catch (err) {
      console.error('[pushTally]', err);
      setStatus(proposalId, { type: 'error', message: err.message });
    } finally {
      setStepSubmitting(prev => ({ ...prev, [proposalId]: null }));
      await fetchProposals();
    }
  };

  const handleExecute = async (proposal) => {
    const { proposalId, direction, target, value, calldata, cid, description } = proposal;
    setStepSubmitting(prev => ({ ...prev, [proposalId]: 'execute' }));
    setStatus(proposalId, null);
    try {
      if (!provider) throw new Error('Please connect your wallet.');
      const signer = await provider.getSigner();

      if (direction === 'deposit') {
        setStatus(proposalId, { type: 'info', message: '⏳ MetaMask will prompt you to send ETH from your wallet to the Treasury.' });
        let depositValueWei = BigInt(value || '0');
        if (depositValueWei <= 0n) throw new Error('Deposit amount is zero or missing.');
        
        const tx = await signer.sendTransaction({ to: target, value: depositValueWei });
        await tx.wait();
        setStatus(proposalId, {
          type: 'success',
          message: `✅ Deposit confirmed! Sent ETH to the Treasury.`
        });
        await fetchProposals();
        return;
      }

      const configRes = await fetch(config.CONFIG_ENDPOINT);
      const confData = await configRes.json();
      
      const GOVERNOR_ABI = [
        "function state(uint256 proposalId) public view returns (uint8)",
        "function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public returns (uint256)",
        "function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) public payable returns (uint256)"
      ];
      const governorContract = new ethers.Contract(confData.governorAddress, GOVERNOR_ABI, signer);

      let s = Number(await governorContract.state(proposalId));
      
      if (s === 3) {
        console.log(`[execute] ⛔ Cannot execute proposal ${proposalId} — Defeated.`);
        throw new Error(`⛔ Cannot execute proposal ${proposalId} — Defeated.`);
      }

      // If cid is undefined, hash the description. This happens for old DB proposals without a CID.
      const descHash = ethers.id(cid || description);

      if (s === 4) { // Succeeded -> Queue
        setStatus(proposalId, { type: 'info', message: '⏳ Queueing proposal via MetaMask...' });
        const txQ = await governorContract.queue([target], [BigInt(value || '0')], [calldata], descHash);
        await txQ.wait();
        
        setStatus(proposalId, { type: 'info', message: '⏳ Time travelling past timelock (demo mode)...' });
        await fetch('http://localhost:5000/rpc/mine', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: 3601 }) 
        });
        s = Number(await governorContract.state(proposalId));
      }

      if (s === 5) { // Queued -> Execute
        setStatus(proposalId, { type: 'info', message: '⏳ Executing proposal via MetaMask...' });
        const txE = await governorContract.execute([target], [BigInt(value || '0')], [calldata], descHash);
        await txE.wait();
        
        setStatus(proposalId, { type: 'success', message: '✅ Executed!' });
      } else {
        throw new Error(`Unexpected state: ${s}`);
      }

    } catch (err) {
      console.error('[execute]', err);
      setStatus(proposalId, { type: 'error', message: err.message });
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
        <p className="page-subtitle">Voting results are immutable and stored on-chain. Proposal metadata stored on IPFS. Immutable hash recorded on-chain.</p>
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
          <p className="text-muted">Loading proposals from blockchain...</p>
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
            <p className="text-muted">No proposals found on the blockchain.</p>
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
                    {proposal.cid && (
                      <span style={{ fontSize: '0.75rem', background: 'rgba(56,189,248,0.1)', padding: '2px 6px', borderRadius: '4px', color: 'var(--accent-secondary)' }}>
                        IPFS: {proposal.cid.slice(0, 8)}...
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
              {(() => {
                const s = proposalStates[proposal.proposalId];
                const isDefeated  = s === 3;
                const isSucceeded = s === 4;
                const isExecuted  = s === 7;
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
                return <div className="badge badge-success">{stateLabel(s)}</div>;
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

              {proposalStates[proposal.proposalId] === 3 && (
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
                {(() => {
                  const s   = proposalStates[proposal.proposalId];
                  const STAGES = [
                    { key: 'tally',   chainState: 1, step: 1, label: 'Push Tally' },
                    { key: 'queue',   chainState: 4, step: 2, label: 'Queue' },
                    { key: 'execute', chainState: 5, step: 3, label: 'Execute' }
                  ];
                  const defeated = s === 3;
                  return (
                    <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
                      {STAGES.map(stage => {
                        const active    = s === stage.chainState;
                        const completed = !defeated && (s > stage.chainState || s === 7
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

                {(() => {
                  const s          = proposalStates[proposal.proposalId];
                  const isDeposit  = proposal.direction === 'deposit';
                  const isDefeated = s === 3;
                  const isDone     = s === 7;
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
                      {s === 1 && (
                        <button onClick={() => handlePushTally(proposal)}
                          disabled={tallyBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={tallyBusy ? 'spin' : ''}/>
                          {tallyBusy ? 'Pushing Tally…' : '📊 Advance Time & Refresh'}
                        </button>
                      )}

                      {s === 4 && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Queueing…' : '🚀 Queue Proposal'}
                        </button>
                      )}

                      {s === 5 && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Executing…' : '⚡ Execute Now'}
                        </button>
                      )}

                      {isDeposit && (s === 4 || s === 5 || s === undefined) && (
                        <button onClick={() => handleExecute(proposal)}
                          disabled={execBusy} className="btn btn-primary" style={btnBase}>
                          <RefreshCw size={16} className={execBusy ? 'spin' : ''}/>
                          {execBusy ? 'Sending ETH…' : '💳 Send ETH to Treasury'}
                        </button>
                      )}

                      {s === 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <div style={{ ...btnBase, background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px',
                            color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                            ⏳ Proposal pending, advance blocks to activate.
                          </div>
                          <button onClick={() => handleAdvanceToVoting(proposal)}
                            disabled={stepSubmitting[proposal.proposalId] === 'advance'} className="btn btn-primary" style={btnBase}>
                            <RefreshCw size={16} className={stepSubmitting[proposal.proposalId] === 'advance' ? 'spin' : ''}/>
                            {stepSubmitting[proposal.proposalId] === 'advance' ? 'Advancing…' : '⏩ Advance to Voting'}
                          </button>
                        </div>
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
