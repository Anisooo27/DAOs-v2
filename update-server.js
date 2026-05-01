const fs = require('fs');
let code = fs.readFileSync('backend/server.js', 'utf8');

// 1. Remove /vote endpoint
code = code.replace(/app\.post\('\/vote', async \(req, res\) => \{[\s\S]*?catch \(error\) \{[\s\S]*?\}\n\}\);/m, `app.post('/vote', (req, res) => {
  return res.status(410).json({ error: 'Voting is now fully decentralized and stored on-chain. Please use the frontend to cast votes directly via your wallet.' });
});`);

// 2. Remove $lookup and votes processing from /proposals
code = code.replace(/\{ \$lookup: \{ from: 'votes', localField: 'proposalId', foreignField: 'proposalId', as: 'votes' \} \},\s*/, '');
code = code.replace(/votes: \{ choice: 1, zkProofVersion: 1 \} /, '');
code = code.replace(/const tally = \{ '0': 0, '1': 0, '2': 0 \};[\s\S]*?if \(v\.zkProofVersion && v\.zkProofVersion !== 'v0-legacy'\) securedVotes\+\+;\n      \}\);\n      \/\/ Infer direction/m, '// Infer direction');
code = code.replace(/, results: tally/, '');
code = code.replace(/, securedVotes/, '');

// 3. Remove relayer voting from /submit
code = code.replace(/const allVotes\s*=\s*await Vote\.find[\s\S]*?console\.log\(`\[pushTally\] Vote tx: \$\{tx\.hash\}`\);\n      \} else \{\n        log\.push\('Already voted on-chain \(relayer vote direction already recorded\)\.'\);\n      \}/, `if (state === 1) { log.push('Closing voting period by advancing time...'); console.log(\`[pushTally] \${log[log.length - 1]}\`); }`);

// 4. Add Event listeners
if (!code.includes('setupEventListeners')) {
    code = code.replace(/start\(\);\s*$/, `start();

// Setup On-Chain Event Listeners for logging demo purposes
async function setupEventListeners() {
  try {
    const { governor } = await getGovernorSigner();
    governor.on('ProposalCreated', (proposalId, proposer, targets, values, signatures, calldatas, startBlock, endBlock, description) => {
      console.log(\`\\n[Event] ProposalCreated: \${proposalId.toString()} by \${proposer}\`);
    });
    governor.on('VoteCast', (voter, proposalId, support, weight, reason) => {
      console.log(\`\\n[Event] VoteCast: \${voter} voted \${support} on \${proposalId.toString()} with weight \${weight.toString()}\`);
    });
    governor.on('ProposalExecuted', (proposalId) => {
      console.log(\`\\n[Event] ProposalExecuted: \${proposalId.toString()}\`);
    });
    console.log('[Events] Listening to on-chain events: ProposalCreated, VoteCast, ProposalExecuted');
  } catch (err) {
    console.warn('[Events] Failed to setup event listeners:', err.message);
  }
}
setupEventListeners();`);
}

fs.writeFileSync('backend/server.js', code);
console.log('Update complete.');
