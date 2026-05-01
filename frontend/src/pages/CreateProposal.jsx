import { useState, useEffect } from 'react';
import { Send, FileText, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';

const NULL_TARGET = '0x0000000000000000000000000000000000000000';

const CreateProposal = ({ provider, address }) => {
  const [template, setTemplate] = useState('signaling');
  const [params, setParams] = useState({});
  const [description, setDescription] = useState('');
  const [contractConfig, setContractConfig] = useState({
    governorAddress: null,
    treasuryAddress: null,
    tokenAddress:    null
  });
  const [isSubmitting, setIsSubmitting]            = useState(false);
  const [govBalance, setGovBalance]                = useState(null);
  const [isCheckingProposer, setIsCheckingProposer] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const checkBalance = async () => {
      if (!address) { setGovBalance(null); return; }
      try {
        setIsCheckingProposer(true);
        const res = await fetch(`http://localhost:5000/membership/${address}`);
        if (res.ok) {
          const data = await res.json();
          setGovBalance(data.govBalance ?? '0');
        } else {
          setGovBalance('0');
        }
      } catch {
        setGovBalance('0');
      } finally {
        setIsCheckingProposer(false);
      }
    };
    checkBalance();
  }, [address]);

  useEffect(() => {
    const fetchBalance = async () => {
      if (!address || !contractConfig.tokenAddress || !provider) return;
      try {
        const signer = await provider.getSigner();
        const tokenContract = new ethers.Contract(contractConfig.tokenAddress, [
          'function balanceOf(address account) view returns (uint256)'
        ], signer);
        const bal = await tokenContract.balanceOf(address);
        setGovBalance(bal.toString());
      } catch (err) {
        console.warn('[proposer] Direct balanceOf() failed:', err.message);
      }
    };
    fetchBalance();
  }, [address, contractConfig.tokenAddress, provider]);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res  = await fetch('http://localhost:5000/config/contract');
        const data = await res.json();
        setContractConfig(data);
      } catch {
        console.info('[sync] Contract config unavailable, using defaults.');
      }
    };
    fetchConfig();
  }, []);

  const handleParamChange = (k, v) => setParams(prev => ({ ...prev, [k]: v }));

  const handleCreateProposal = async (e) => {
    e.preventDefault();
    if (!address) { alert('Please connect your wallet first'); return; }

    try {
      setIsSubmitting(true);
      if (!provider) throw new Error('Wallet provider not found');

      const signer = await provider.getSigner();

      // Encode Calldata via Frontend
      let target = '0x0000000000000000000000000000000000000000';
      let value = '0';
      let calldata = '0x';

      if (template === 'signaling') {
        // Defaults already handle this
      } else if (template === 'treasury_transfer') {
        const { recipient, amount } = params;
        if (!ethers.isAddress(recipient)) throw new Error('Invalid recipient address');
        if (!amount || isNaN(amount)) throw new Error('Invalid amount');
        
        target = contractConfig.treasuryAddress;
        const iface = new ethers.Interface(['function withdrawETH(address payable to, uint256 amount)']);
        calldata = iface.encodeFunctionData('withdrawETH', [recipient, ethers.parseEther(amount.toString())]);
      } else if (template === 'parameter_change') {
        const { paramType, newValue } = params;
        if (!['votingDelay', 'votingPeriod', 'proposalThreshold'].includes(paramType)) {
          throw new Error('Invalid parameter type');
        }
        
        target = contractConfig.governorAddress; // Governor updates itself
        const funcName = 'set' + paramType.charAt(0).toUpperCase() + paramType.slice(1);
        const iface = new ethers.Interface([`function ${funcName}(uint256 new${funcName.substring(3)})`]);
        calldata = iface.encodeFunctionData(funcName, [newValue.toString()]);
      } else if (template === 'buy_nft') {
        const { nftContract, tokenId, price } = params;
        target = nftContract || '0x0000000000000000000000000000000000000000';
        const iface = new ethers.Interface(['function buyNFT(uint256 tokenId) payable']);
        calldata = iface.encodeFunctionData('buyNFT', [tokenId || 1]);
        value = price ? ethers.parseEther(price.toString()).toString() : '0';
      }

      const ipfsData = {
        description,
        template,
        params,
        target,
        value,
        calldata,
        direction: template === 'treasury_transfer' ? 'withdrawal' : 'general',
        proposerAddress: address,
        timestamp: Date.now()
      };

      // Upload metadata to mock IPFS
      const ipfsRes = await fetch('http://localhost:5000/ipfs/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ipfsData)
      });
      
      const { cid } = await ipfsRes.json();
      if (!cid) throw new Error('Failed to upload metadata to IPFS');

      const GOVERNOR_ABI = [
        'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) public returns (uint256)',
        'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)'
      ];

      const governorContract = new ethers.Contract(contractConfig.governorAddress, GOVERNOR_ABI, signer);
      const proposeTx = await governorContract.propose(
        [target || NULL_TARGET],
        [BigInt(value || 0)],
        [calldata],
        cid
      );

      const receipt = await proposeTx.wait();

      const governorIface = new ethers.Interface(GOVERNOR_ABI);
      const proposalCreatedTopic = ethers.id('ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)');
      let onChainProposalId;

      for (const log of receipt.logs) {
        if (log.topics[0] !== proposalCreatedTopic) continue;
        try {
          const parsed = governorIface.parseLog(log);
          if (parsed?.name === 'ProposalCreated') onChainProposalId = parsed.args[0].toString();
        } catch {
          try {
            const decoded = governorIface.decodeEventLog('ProposalCreated', log.data, log.topics);
            onChainProposalId = decoded[0].toString();
          } catch {}
        }
      }

      if (!onChainProposalId) throw new Error('ProposalCreated event not found.');

      alert('Proposal Submitted Successfully! Metadata stored on IPFS. Immutable hash recorded on-chain.');
      navigate(`/cast-vote?proposalId=${onChainProposalId}`);
    } catch (error) {
      console.error('[propose] Error:', error);
      alert(error.message || 'Failed to create proposal');
    } finally {
      setIsSubmitting(false);
    }
  };

  const proposerChecking = isCheckingProposer || (!!address && govBalance === null);
  const proposerOk       = !!address && govBalance !== null && govBalance !== '0';
  const descriptionOk    = description.trim() !== '';
  const isFinalReady     = proposerOk && descriptionOk;

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Propose Action</h1>
        <p className="page-subtitle">
          Draft a governance proposal for the DAO to vote on using templates for common actions.
        </p>
      </div>

      <div className="glass-panel" style={{ padding: '32px' }}>
        <form onSubmit={handleCreateProposal} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

          <div className="form-group">
            <label className="form-label" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Proposal Template</label>
            <div style={{ position: 'relative' }}>
              <select 
                className="form-input" 
                value={template} 
                onChange={e => { setTemplate(e.target.value); setParams({}); }}
                style={{ appearance: 'none' }}
              >
                <option value="signaling">Signaling (Text-only)</option>
                <option value="treasury_transfer">Treasury Transfer (Send ETH)</option>
                <option value="parameter_change">Update DAO Parameter</option>
                <option value="buy_nft">Buy NFT (Demo)</option>
              </select>
              <ChevronDown size={18} style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} pointerEvents="none" />
            </div>
          </div>

          {template === 'treasury_transfer' && (
            <div className="content-grid" style={{ gap: '16px', gridTemplateColumns: '1fr 1fr', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div>
                <label className="form-label">Recipient Address</label>
                <input type="text" className="form-input" placeholder="0x..." value={params.recipient || ''} onChange={e => handleParamChange('recipient', e.target.value)} required />
              </div>
              <div>
                <label className="form-label">Amount (ETH)</label>
                <input type="number" step="0.001" className="form-input" placeholder="1.5" value={params.amount || ''} onChange={e => handleParamChange('amount', e.target.value)} required />
              </div>
            </div>
          )}

          {template === 'parameter_change' && (
            <div className="content-grid" style={{ gap: '16px', gridTemplateColumns: '1fr 1fr', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div>
                <label className="form-label">Parameter</label>
                <select className="form-input" value={params.paramType || ''} onChange={e => handleParamChange('paramType', e.target.value)} required>
                  <option value="" disabled>Select parameter</option>
                  <option value="votingDelay">Voting Delay (blocks)</option>
                  <option value="votingPeriod">Voting Period (blocks)</option>
                </select>
              </div>
              <div>
                <label className="form-label">New Value</label>
                <input type="number" className="form-input" placeholder="e.g. 50" value={params.newValue || ''} onChange={e => handleParamChange('newValue', e.target.value)} required />
              </div>
            </div>
          )}

          {template === 'buy_nft' && (
            <div className="content-grid" style={{ gap: '16px', gridTemplateColumns: '1fr 1fr 1fr', background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div>
                <label className="form-label">NFT Contract</label>
                <input type="text" className="form-input" placeholder="0x..." value={params.nftContract || ''} onChange={e => handleParamChange('nftContract', e.target.value)} required />
              </div>
              <div>
                <label className="form-label">Token ID</label>
                <input type="number" className="form-input" placeholder="1" value={params.tokenId || ''} onChange={e => handleParamChange('tokenId', e.target.value)} required />
              </div>
              <div>
                <label className="form-label">Price (ETH)</label>
                <input type="number" step="0.001" className="form-input" placeholder="0.5" value={params.price || ''} onChange={e => handleParamChange('price', e.target.value)} required />
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="description" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Proposal Description</label>
            <textarea
              id="description"
              className="form-input"
              rows={5}
              placeholder="# Markdown supported\nDescribe the rationale..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              style={{ resize: 'vertical', minHeight: '120px' }}
            />
          </div>

          <div className="glass-panel mt-2 mb-2" style={{ background: 'rgba(255,255,255,0.02)', padding: '16px' }}>
            <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--accent-secondary)' }}>
              <FileText size={16} />
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Proposal Lifecycle</span>
            </div>
            <p className="text-muted" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
              Calldata is automatically generated via the selected template. 
              Voting results are immutable and execution is fully governed on-chain.
            </p>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', padding: '16px', fontSize: '1.05rem', opacity: !isFinalReady || isSubmitting ? 0.6 : 1, marginTop: '12px' }}
            disabled={isSubmitting || !isFinalReady || proposerChecking}
          >
            <Send size={18} />
            {isSubmitting ? 'Submitting…' : proposerChecking ? 'Verifying membership…' : !address ? 'Connect a wallet to continue' : !proposerOk ? 'You need GOV tokens to propose' : !descriptionOk ? 'Enter a proposal description' : 'Create Proposal'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default CreateProposal;
