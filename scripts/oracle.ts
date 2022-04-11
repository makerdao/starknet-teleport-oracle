import { isEqual, zip } from "lodash";
import axios from "axios";
import http from "http";
import url from "url";
import assert from "assert";
import { BigNumber, Wallet, utils } from "ethers";
import { arrayify, hashMessage, keccak256 } from "ethers/lib/utils";
import * as dotenv from "dotenv";
dotenv.config();

type Transaction = any;
type TransactionReceipt = any;

type Block = {
  block_hash?: string;
  parent_block_hash: string;
  status: string;
  block_number: BigInt;
  state_root?: string;
  timestamp: BigInt;
  transactions: Array<Transaction>;
  transaction_receipts: Array<TransactionReceipt>;
};

type TransactionSummary = Transaction & {
  block_number: string;
  receipt: TransactionReceipt;
};

interface Event {
  data: string[];
  from_address: string;
  keys: string[];
}

interface OracleData {
  data: { event: string; hash: string }
  signatures: {
    ethereum: {
      signature: string
    }
  }
}

interface WormholeGUID {
  sourceDomain: string;
  targetDomain: string;
  receiver: string;
  operator: string;
  amount: string;
  nonce: string;
  timestamp: string;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  assert(value, `Please provide ${key} in .env file`);

  return value;
}

async function transaction(
  server: string,
  txHash: string
): Promise<Transaction> {
  const url = `https://${server}/feeder_gateway/get_transaction_receipt?transactionHash=${txHash}`;
  const response = await axios.get(url);
  return response.data as Transaction;
}

const MASK_250 = BigInt(2 ** 250 - 1);
function getSelectorFromName(name: string) {
  return `0x${(BigInt(keccak256(Buffer.from(name))) % MASK_250).toString(16)}`;
}

function toHex(x: string) {
  return `0x${BigInt(x).toString(16)}`;
}

function filterEvent(event: Event): boolean {
  return event.from_address === toHex(getRequiredEnv("WORMHOLE_GATEWAY_ADDRESS")) &&
    event.keys[0] === getSelectorFromName("WormholeInitialized");
}

async function signWormholeData(
  wormholeData: string,
  signers: any
): Promise<{ signHash: string; signatures: string[] }> {
  signers = signers.sort((s1: any, s2: any) => {
    const bn1 = BigNumber.from(s1.address);
    const bn2 = BigNumber.from(s2.address);
    if (bn1.lt(bn2)) return -1;
    if (bn1.gt(bn2)) return 1;
    return 0;
  });

  const guidHash = keccak256(wormholeData);
  const signatures = await Promise.all(
    signers.map((signer: any) => signer.signMessage(arrayify(guidHash)))
  );
  const signHash = hashMessage(arrayify(guidHash));
  return { signHash, signatures };
}

function toBytes32(x: string): string {
  return `0x${x.slice(2).padStart(64, '0')}`;
}

export async function attestationsFromEvent(event: Event): Promise<OracleData[]> {
  const message = utils.defaultAbiCoder.encode(
    ["bytes32", "bytes32", "bytes32", "bytes32", "uint128", "uint80", "uint48"],
    [
      toBytes32(event.data[0]),
      toBytes32(event.data[1]),
      toBytes32(event.data[2]),
      toBytes32(event.data[3]),
      ...event.data.slice(4),
    ]);

  const oracleMnemonic = getRequiredEnv("ORACLE_MNEMONIC");
  const oracleWallet = Wallet.fromMnemonic(oracleMnemonic);
  const signers = [oracleWallet];
  const { signatures } = await signWormholeData(message, signers);
  const hash = keccak256(message).slice(2);
  return signatures.map((signature, i) => ({
    timestamp: (new Date()).getTime(),
    "signatures": {
      ethereum: {
        signer: signers[i].address.slice(2),
        signature: signature.slice(2),
      },
    },
    data: {
      event: message.slice(2),
      hash,
    },
  }));
}

http.createServer(async (req, res) => {
  try {
    const params = url.parse(req.url, true).query;
    assert(params.type === "wormhole");
    const txHash = params.index.toString();

    const sequencer = getRequiredEnv("STARKNET_SEQUENCER");
    const tx = await transaction(sequencer, txHash);
    const wormholeEvent = tx.events.filter(filterEvent)[0];
    if (!wormholeEvent) {
      throw Error("Wormhole event not found");
    }
    const attestations = await attestationsFromEvent(wormholeEvent);
    res.write(JSON.stringify(attestations));
    res.end();
  } catch (err) {
    console.log(err.message);
    res.write(JSON.stringify(null));
    res.end();
  }
}).listen(8080);
