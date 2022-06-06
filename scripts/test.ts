import axios from 'axios';
import assert from "assert";
import { ethers, Contract } from "ethers";
import { Interface } from "ethers/lib/utils";
import * as dotenv from "dotenv";
dotenv.config();


const ORACLE_API_URL = 'http://localhost:8080'

interface TeleportGUID {
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

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  assert(value, `Please provide ${key} in .env file`);

  return value;
}

function decodeTeleportData(teleportData: string[]): TeleportGUID {
  const teleportGUID = {
    sourceDomain: teleportData[0],
    targetDomain: teleportData[1],
    receiver: teleportData[2],
    operator: teleportData[3],
    amount: teleportData[4],
    nonce: teleportData[5],
    timestamp: teleportData[6],
  };
  return teleportGUID;
}

async function fetchAttestations(txHash: string): Promise<{
  signatures: string,
  teleportGUID?: TeleportGUID,
}> {
  const response = await axios.get(ORACLE_API_URL, {
    params: {
      type: 'teleport',
      index: txHash,
    },
  });

  const results = response.data || [];

  const signatures = '0x' + results.map((oracle: OracleData) => oracle.signatures.ethereum.signature).join('');

  let teleportGUID = undefined;
  if (results.length > 0) {
    const teleportData = results[0].data.event.match(/.{64}/g).map((hex: string) => `0x${hex}`);
    teleportGUID = decodeTeleportData(teleportData);
  }

  const provider = ethers.getDefaultProvider("http://localhost:8545");
  const mnemonic = getRequiredEnv("MNEMONIC");
  const l1Signer = ethers.Wallet.fromMnemonic(mnemonic).connect(provider);

  const oracleAuth = new Contract(
    "0x70FEdb21fF40E8bAf9f1a631fA9c34F179f29442",
    new Interface([
      "function requestMint((bytes32,bytes32,bytes32,bytes32,uint128,uint80,uint48),bytes,uint256,uint256)",
      "function getGUIDHash((bytes32,bytes32,bytes32,bytes32,uint128,uint80,uint48)) view returns (bytes32)",
      "function signers(address) view returns(uint256)",
    ]),
    l1Signer
  );

  await oracleAuth.requestMint(
    Object.values(teleportGUID),
    signatures,
    0,
    0
  );

  return {
    signatures,
    teleportGUID,
  };
}

if (process.argv.length === 3) {
  fetchAttestations(process.argv[2]).then(console.log);
} else {
  console.log("Add transaction hash to arguments");
}
