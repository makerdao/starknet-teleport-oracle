import { isEqual, zip } from "lodash";
import http from "http";
import {
  distinct,
  distinctUntilKeyChanged,
  filter,
  interval,
  map,
  mergeMap,
  Observable,
  from,
  of,
  startWith,
  switchMap,
  tap,
  combineAll,
} from "rxjs";
import { ajax } from "rxjs/ajax";
import xhr from "xhr2";
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

function transactionsFromBlock(b: Block): Array<TransactionSummary> {
  return zip(b.transactions, b.transaction_receipts).map(
    ([transaction, receipt]) => ({
      ...transaction,
      receipt,
      parent_block_hash: b.parent_block_hash,
    })
  );
}

function eventsFromTransaction({
  block_hash,
  transaction_hash,
  parent_block_hash,
  events,
  transaction_index,
}: TransactionSummary): Array<Event> {
  return events.map((e, i) => ({
    block_hash,
    parent_block_hash,
    transaction_hash,
    transaction_index,
    log_index: i,
    ...e,
  }));
}

function block(
  server: string,
  blockNumber: BigInt | "pending"
): Observable<Block> {
  const url = `https://${server}/feeder_gateway/get_block?blockNumber=${blockNumber}`;
  return ajax({ url, createXHR: () => new xhr() }).pipe(
    map(({ response }) => response as Block)
  );
}

function transaction(
  server: string,
  txHash: string
): Observable<Transaction> {
  const url = `https://${server}/feeder_gateway/get_transaction_receipt?transactionHash=${txHash}`;
  return ajax({ url, createXHR: () => new xhr() }).pipe(
    map(({ response }) => response as Transaction)
  );
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
  const { signatures } = await signWormholeData(message, [oracleWallet, oracleWallet]);
  const hash = keccak256(message).slice(2);
  return signatures.map(signature => ({
    "signatures": {
      ethereum: {
        signature: signature.slice(2),
      },
    },
    data: {
      event: message.slice(2),
      hash,
    },
  }));
}

function events(server: string, period = 10000) {
  return interval(period).pipe(
    startWith(0),
    switchMap(() => block(server, "pending")),
    distinctUntilKeyChanged("transactions", isEqual),
    mergeMap((block) => of(...transactionsFromBlock(block))),
    distinct(),
    mergeMap((t) => of(...eventsFromTransaction(t))),
    distinct(),
    filter((e) => filterEvent(e)),
    distinct(),
    mergeMap((e) => of(attestationsFromEvent(e)))
  );
}


function getParams(req) {
  let q=req.url.split('?'),result={};
  if(q.length>=2){
      q[1].split('&').forEach((item)=>{
           try {
             result[item.split('=')[0]]=item.split('=')[1];
           } catch (e) {
             result[item.split('=')[0]]='';
           }
      })
  }
  return result;
}

http.createServer((req, res) => {
  const params = getParams(req);
  assert(params["type"] === "wormhole");
  const txHash = params["index"];
  
  const result = from(txHash).pipe(
    switchMap(() => transaction(alphaGoerli, txHash)),
    mergeMap((t) => of(...eventsFromTransaction(t))),
    filter((e) => filterEvent(e)),
    mergeMap((e) => of(attestationsFromEvent(e))),
    // combineAll()
  );

  result.subscribe(async x => {
    const y = await x;
    res.write(JSON.stringify(y));
    res.end();
  });
}).listen(8080);

const alphaGoerli = "alpha4.starknet.io";
const alphaMainet = "alpha-mainnet.starknet.io";
