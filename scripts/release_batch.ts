import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

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
  const mint = new PublicKey(requireEnv("MINT"));
  const distributor = new PublicKey(requireEnv("DISTRIBUTOR"));

  if (!provider.wallet.publicKey.equals(distributor)) {
    throw new Error(
      `ANCHOR_WALLET must be the distributor. Expected ${distributor.toBase58()}, got ${provider.wallet.publicKey.toBase58()}`
    );
  }

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  const csv = loadAllocationCsv();
  const wallets = parseWallets(csv);

  const batchSize = 5;
  for (let i = 0; i < wallets.length; i += batchSize) {
    const slice = wallets.slice(i, i + batchSize);
    const atas = slice.map((w) =>
      getAssociatedTokenAddressSync(
        mint,
        w,
        false,
        anchor.utils.token.TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      )
    );

    const sig = await program.methods
      .batchRelease(slice)
      .accounts({
        scheduleState,
        recipients,
        vault,
        distributor: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })))
      .rpc();

    console.log(`batch_release ${i + 1}-${i + slice.length} tx: ${sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

