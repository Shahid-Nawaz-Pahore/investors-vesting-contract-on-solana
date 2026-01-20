import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

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

function parseAllocations(csv: string): { wallet: PublicKey; allocation: BN }[] {
  const lines = csv.split(/\r?\n/);
  const entries: { wallet: PublicKey; allocation: BN }[] = [];
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (line.includes("wallet_pubkey")) continue;
    if (line.startsWith("-")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const wallet = parts[0];
    const allocation = parts[1];
    if (!wallet || !allocation) continue;
    entries.push({ wallet: new PublicKey(wallet), allocation: new BN(allocation) });
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

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const csv = loadAllocationCsv();
  const entries = parseAllocations(csv);

  console.log(`Parsed ${entries.length} recipient allocations`);

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  const batchSize = 10;
  for (let i = 0; i < entries.length; i += batchSize) {
    const slice = entries.slice(i, i + batchSize);
    const seal = i + batchSize >= entries.length;

    const sig = await program.methods
      .addRecipients(slice, seal)
      .accounts({
        scheduleState,
        recipients,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    console.log(
      `Added ${slice.length} recipients (seal=${seal}) tx: ${sig}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

