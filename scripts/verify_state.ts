import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const DEFAULT_ALLOCATION_PATHS = [
  resolve(process.cwd(), "allocation.csv"),
  resolve(process.cwd(), "vesting", "allocation.csv"),
  resolve(process.cwd(), "..", "allocation.csv"),
  resolve(process.cwd(), "..", "vesting", "allocation.csv"),
  resolve(process.cwd(), "..", "..", "allocation.csv"),
];

function loadAllocationCsv(): string {
  const envPathVar = process.env.ALLOCATION_CSV;
  if (envPathVar && existsSync(envPathVar)) {
    return readFileSync(envPathVar, "utf8");
  }
  for (const p of DEFAULT_ALLOCATION_PATHS) {
    if (existsSync(p)) {
      return readFileSync(p, "utf8");
    }
  }
  throw new Error(
    "allocation.csv not found. Set ALLOCATION_CSV or place allocation.csv in repo root."
  );
}

function parseAllocations(csv: string): { wallet: PublicKey; allocation: bigint }[] {
  const lines = csv.split(/\r?\n/);
  const entries: { wallet: PublicKey; allocation: bigint }[] = [];
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (line.includes("wallet_pubkey")) continue;
    if (line.startsWith("-")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const wallet = parts[0];
    const allocation = parts[1];
    if (!wallet || !allocation) continue;
    entries.push({ wallet: new PublicKey(wallet), allocation: BigInt(allocation) });
  }
  if (entries.length === 0) {
    throw new Error("No allocations parsed from allocation.csv");
  }
  return entries;
}

function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

function findRecipientsPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("recipients"), scheduleState.toBuffer()],
    programId
  );
}

function findVaultPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), scheduleState.toBuffer()],
    programId
  );
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as any;
  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  const state = await program.account.scheduleState.fetch(scheduleState);
  const rec = await program.account.recipients.fetch(recipients);

  const csv = loadAllocationCsv();
  const entries = parseAllocations(csv);
  const csvSum = entries.reduce((acc, e) => acc + e.allocation, 0n);

  const releasedSum = (rec.entries as any[])
    .slice(0, Number(state.recipientCount))
    .reduce((acc, e) => acc + BigInt(e.releasedAmount.toString()), 0n);

  const allocSum = (rec.entries as any[])
    .slice(0, Number(state.recipientCount))
    .reduce((acc, e) => acc + BigInt(e.allocation.toString()), 0n);

  const vaultAccount = await getAccount(provider.connection, vault);

  console.log("schedule_state:", scheduleState.toBase58());
  console.log("recipients:", recipients.toBase58());
  console.log("vault:", vault.toBase58());
  console.log("recipient_count:", Number(state.recipientCount));
  console.log("total_supply:", state.totalSupply.toString());
  console.log("released_supply:", state.releasedSupply.toString());
  console.log("alloc_sum_onchain:", allocSum.toString());
  console.log("released_sum_onchain:", releasedSum.toString());
  console.log("alloc_sum_csv:", csvSum.toString());
  console.log("vault_amount:", vaultAccount.amount.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

