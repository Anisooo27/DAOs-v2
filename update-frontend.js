const fs = require('fs');

// Patch CastVote.jsx
let castVotePath = 'frontend/src/pages/CastVote.jsx';
let castCode = fs.readFileSync(castVotePath, 'utf8');

castCode = castCode.replace(/import config from '\.\.\/config';/, "import config from '../config';\nconst GOVERNOR_ABI = ['function castVote(uint256 proposalId, uint8 support) external returns (uint256)'];");

// Replace handleSignAndVote
castCode = castCode.replace(/const handleSignAndVote = async \(\) => \{[\s\S]*?\}\s*};\s*return \(/, `const handleSignAndVote = async () => {
    if (!address) { alert('Please connect your wallet first.'); return; }
    if (!proposalId.trim() || choice === null) {
      alert('Please enter a Proposal ID and select a voting option.');
      return;
    }

    try {
      setIsCasting(true);
      setStatus(null);
      setProofDetails(null);

      const signer = await provider.getSigner();
      const configRes = await fetch('http://localhost:5000/config/contract');
      const configData = await configRes.json();
      
      const governorContract = new ethers.Contract(configData.governorAddress, GOVERNOR_ABI, signer);
      
      setStatus({ type: 'info', message: 'Waiting for transaction confirmation...' });
      const tx = await governorContract.castVote(proposalId.trim(), choice);
      await tx.wait();

      setStatus({ type: 'success', message: '✅ Vote cast successfully on-chain!' });
    } catch (error) {
      console.error('[vote] Error casting vote:', error);
      setStatus({ type: 'error', message: error.message || 'Error signing or submitting vote.' });
    } finally {
      setIsCasting(false);
    }
  };

  return (`);

// Update Header
castCode = castCode.replace(/<h1 className="page-title">Cast Off-Chain Vote<\/h1>\s*<p className="page-subtitle">\s*Your vote is secured with a cryptographic commitment — gasless, signed, and double-vote protected.\s*<\/p>/, `<h1 className="page-title">Cast On-Chain Vote</h1>
        <p className="page-subtitle">
          Voting results are immutable and stored on-chain. Cast your vote securely via MetaMask.
        </p>`);

// Remove ZKP Banner
castCode = castCode.replace(/\{\/\* ZKP Info Banner \*\/\}[\s\S]*?<\/div>/, '');

// Update Button
castCode = castCode.replace(/\{isCasting \? 'Generating proof & waiting for signature…' : !address \? 'Please connect a wallet to continue' : \(!govBalance \|\| govBalance === '0'\) \? 'No GOV Tokens — visit Membership to get tokens' : 'Generate Proof & Submit Vote'\}/, "{isCasting ? 'Confirming transaction…' : !address ? 'Please connect a wallet to continue' : (!govBalance || govBalance === '0') ? 'No GOV Tokens — visit Membership to get tokens' : 'Cast Vote On-Chain'}");

// Remove proof details
castCode = castCode.replace(/\{\/\* Proof Details \*\/\}[\s\S]*?\}\)/, '');

fs.writeFileSync(castVotePath, castCode);


// Patch Results.jsx
let resultsPath = 'frontend/src/pages/Results.jsx';
let resultsCode = fs.readFileSync(resultsPath, 'utf8');

// Update GOVERNOR_ABI
resultsCode = resultsCode.replace(/const GOVERNOR_ABI = \[[\s\S]*?\];/, `const GOVERNOR_ABI = [
              "function state(uint256 proposalId) public view returns (uint8)",
              "function quorum(uint256 blockNumber) public view returns (uint256)",
              "function proposalSnapshot(uint256 proposalId) public view returns (uint256)",
              "function proposalVotes(uint256 proposalId) public view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)"
            ];`);

// Add proposalVotes fetch
resultsCode = resultsCode.replace(/quorums\[p\.proposalId\] = q\.toString\(\);/, `quorums[p.proposalId] = q.toString();
                
                const votes = await governorContract.proposalVotes(p.proposalId);
                p.results = {
                  '0': Number(ethers.formatEther(votes[0])),
                  '1': Number(ethers.formatEther(votes[1])),
                  '2': Number(ethers.formatEther(votes[2]))
                };`);

// Remove shortId logic
resultsCode = resultsCode.replace(/p\.shortId\.toLowerCase\(\)\.includes\(searchQuery\.toLowerCase\(\)\)/, 'false');
resultsCode = resultsCode.replace(/\{proposal\.shortId && \([\s\S]*?\}\)/, '');

fs.writeFileSync(resultsPath, resultsCode);

console.log('Frontend update complete.');
