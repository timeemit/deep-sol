import { strict as assert } from 'assert';
import { v4 as uuidv4 } from 'uuid';

import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import path from 'path';

import {getPayer, getRpcUrl, createKeypairFromFile} from './utils';

const web3 = require("@solana/web3.js");
const {struct, seq, u8, u32, f32, ns64} = require("@solana/buffer-layout");
const {Buffer} = require('buffer');

/**
 * Connection to the network
 */
let connection: Connection;

/**
 * Keypair associated to the fees' payer
 */
let payer: Keypair;

/*
 * RPC url is read from an environment variable
 */
const rpcUrl = process.env.RPC_URL;

const KEYPAIRS: Array<Array<number>> = JSON.parse(process.env.KEYPAIRS || "");
assert.ok(KEYPAIRS);

/*
 * Implements the expected payloads struct to request a lift to the compute limit
 */
const computeBudgetRequestStruct = struct([
  u8('instruction'),
  u32('units'),
  u32('additional_fee'),
]);

/*
 * Implements the expected payload struct to send into the DCGAN program:
 */
function getDcganPayloadStruct(size: number): typeof seq {
  return seq(f32(), size);
}

/*
 * Implements the expected payload struct to send into the DCGAN program:
 */
function getDcganResultStruct(size: number): typeof seq { 
  return seq(f32(), size);
}

function getMaxAccountSize(): number {
  return 768;
}

/**
 * Establish a connection to the cluster
 */
export async function establishConnection(): Promise<void> {
  let fallbackRpcUrl = rpcUrl || await getRpcUrl();
  connection = new Connection(fallbackRpcUrl, 'confirmed');
  const version = await connection.getVersion();
  console.log('Connection to cluster established:', rpcUrl, version);
}

/**
 * Establish an account to pay for everything
 */
export async function establishPayer(): Promise<void> {
  // Calculate the cost of sending transactions
  const {feeCalculator} = await connection.getRecentBlockhash();
  const max_size = getMaxAccountSize();
  let fees = await connection.getMinimumBalanceForRentExemption(
    getDcganResultStruct(max_size).span,
  );
  fees += feeCalculator.lamportsPerSignature * 100; // wag

  if (!payer) {
    payer = Keypair.generate()

    // If current balance is not enough to pay for fees, request an airdrop
    const sig = await connection.requestAirdrop(
      payer.publicKey,
      1000 * fees,
    );
    console.log('Requesting', 1000 * fees, 'in airdrop to', payer.publicKey.toBase58(), 'in transaction', sig);
    await connection.confirmTransaction(sig);
  }

  const lamports = await connection.getBalance(payer.publicKey);
  console.log(
    'Using account',
    payer.publicKey.toBase58(),
    'containing',
    lamports / LAMPORTS_PER_SOL,
    'SOL to pay for fees',
  );
}

async function createAccount(programId: PublicKey): Promise<PublicKey> {
  const seed = uuidv4().slice(0, 8);
  const programAccountPubkey = await PublicKey.createWithSeed(
    payer.publicKey,
    seed,
    programId,
  );

  const createdAccount = await connection.getAccountInfo(programAccountPubkey);
  if (createdAccount === null) {
    const space = getDcganResultStruct(getMaxAccountSize()).span;
    console.log(
      'Creating account',
      programAccountPubkey.toBase58(),
      'to persist',
      getDcganResultStruct(getMaxAccountSize()).span,
      'bytes into',
    );

    const lamports = await connection.getMinimumBalanceForRentExemption(space);

    const transaction = new Transaction().add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer.publicKey,
        basePubkey: payer.publicKey,
        seed,
        newAccountPubkey: programAccountPubkey,
        lamports,
        space,
        programId,
      }),
    );
    await sendAndConfirmTransaction(connection, transaction, [payer]);
  }

  return programAccountPubkey;
}


/**
 * Execute Onnx Program
 */
export async function executeOnnx(pipelineInput: PipelineInput): Promise<void> {
  const programKeypair = pipelineInput.programKeypair;
  let programAccountPubkey = pipelineInput.programAccountPubkey; 

  /*
   * Establish Compute Budget Payload
   */
  let allocateParams = { instruction: 0, units: 1400000, additional_fee: 1 };
  let allocateData = Buffer.alloc(computeBudgetRequestStruct.span);
  computeBudgetRequestStruct.encode(allocateParams, allocateData);

  /*
   * Bump Compute Budget Instruction
   */
  const allocate = new web3.TransactionInstruction({
    keys: [{pubkey: payer.publicKey, isSigner: false, isWritable: false}],
    programId: 'ComputeBudget111111111111111111111111111111',
    data: allocateData,
  });

  /*
   * Establish Onnx Compute Budget Payload
   */
  let onnxParams = pipelineInput.params;
  let dcganPayloadStruct = getDcganPayloadStruct(onnxParams.length);
  let onnxData = Buffer.alloc(dcganPayloadStruct.span);
  dcganPayloadStruct.encode(onnxParams, onnxData);

  /*
   * Keys
   */
  
  const keys = [{pubkey: programAccountPubkey, isSigner: false, isWritable: true}]
  if (pipelineInput.prevProgramAccountPubkey) {
    keys.push({pubkey: pipelineInput.prevProgramAccountPubkey, isSigner: false, isWritable: false});
  }
  console.log('Executing ONNX with keys', keys.map((key) => key.pubkey.toBase58()));

  /*
   * Execute Onnx Program
   */
  const instruction = new TransactionInstruction({
    keys,
    programId: programKeypair.publicKey,
    data: onnxData,
  });

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(allocate).add(instruction),
    [payer],
  );
}

interface PipelineInput {
  programKeypair: Keypair;
  params: Array<number>;
  programAccountPubkey: PublicKey;
  prevProgramAccountPubkey: PublicKey | null;
}

export async function executeOnnxPipeline(params: Array<number>): Promise<Report> {
  const programKeypairs = KEYPAIRS.map((keypair) => Keypair.fromSecretKey(Uint8Array.from(keypair)));
  const programAccountPubkeys = await Promise.all(programKeypairs.map((keypair) => createAccount(keypair.publicKey)));
  console.log('Program accounts created');
  let output_promise = executeOnnx({
    programKeypair: programKeypairs[0],
    params,
    programAccountPubkey: programAccountPubkeys[0],
    prevProgramAccountPubkey: null,
  });

  KEYPAIRS.slice(1).forEach((keys, i) => {
    output_promise = output_promise.then(pipelineInput => {
      console.log("Executing input of model #", i + 1);
      return executeOnnx({
        programKeypair: programKeypairs[i + 1],
        params: [],
        programAccountPubkey: programAccountPubkeys[i + 1],
        prevProgramAccountPubkey: programAccountPubkeys[i],
      });
    });
  });

  return output_promise.then(() => report(programAccountPubkeys[programAccountPubkeys.length - 1]));;
}

interface Report {
  result: Array<number>;
}

/**
 * Report the number of times the greeted account has been said hello to
 */
export async function report(programAccountPubkey: PublicKey): Promise<Report> {
  const accountInfo = await connection.getAccountInfo(programAccountPubkey);
  if (accountInfo === null) {
    throw 'Error: cannot find the greeted account';
  }
  return {result: getDcganResultStruct(256).decode(accountInfo.data)};
}
