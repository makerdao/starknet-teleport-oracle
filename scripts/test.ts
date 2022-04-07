import axios from 'axios';

const ORACLE_API_URL = 'http://localhost:8080'

interface WormholeGUID {
  sourceDomain: string;
  targetDomain: string;
  receiver: string;
  operator: string;
  amount: string;
  nonce: string;
  timestamp: string;
}

interface OracleData {
  data: { event: string; hash: string }
  signatures: {
    ethereum: {
      signature: string
    }
  }
}

function decodeWormholeData(wormholeData: string[]): WormholeGUID {
  const wormholeGUID = {
    sourceDomain: wormholeData[0],
    targetDomain: wormholeData[1],
    receiver: wormholeData[2],
    operator: wormholeData[3],
    amount: wormholeData[4],
    nonce: wormholeData[5],
    timestamp: wormholeData[6],
  };
  return wormholeGUID;
}

async function fetchAttestations(txHash: string): Promise<{
  signatures: string,
  wormholeGUID?: WormholeGUID,
}> {
  const response = await axios.get(ORACLE_API_URL, {
    params: {
      type: 'wormhole',
      index: txHash,
    },
  });

  const results = response.data || [];

  const signatures = '0x' + results.map((oracle: OracleData) => oracle.signatures.ethereum.signature).join('');

  let wormholeGUID = undefined;
  if (results.length > 0) {
    const wormholeData = results[0].data.event.match(/.{64}/g).map((hex: string) => `0x${hex}`);
    wormholeGUID = decodeWormholeData(wormholeData);
  }

  return {
    signatures,
    wormholeGUID,
  };
}

if (process.argv.length === 3) {
  fetchAttestations(process.argv[2]).then(console.log);
} else {
  console.log("Add transaction hash to arguments");
}
