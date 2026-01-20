import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
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

function parseWallets(csv: string): PublicKey[] {
  const lines = csv.split(/\r?\n/);
  const wallets: PublicKey[] = [];
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (line.includes("wallet_pubkey")) continue;
    if (line.startsWith("-")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const wallet = parts[0];
    if (!wallet) continue;
    wallets.push(new PublicKey(wallet));
  }
  if (wallets.length === 0) {
    throw new Error("No wallets parsed from allocation.csv");
  }
  return wallets;
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

  const program = anchor.workspace.vesting as any;
  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  const singleWallet = process.env.WALLET ? new PublicKey(process.env.WALLET) : null;
  const wallets = singleWallet ? [singleWallet] : parseWallets(loadAllocationCsv());

  for (const wallet of wallets) {
    const sig = await program.methods
      .emitVestingQuote(wallet)
      .accounts({ scheduleState, recipients })
      .rpc();
    console.log(`emit_quote ${wallet.toBase58()} tx: ${sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

