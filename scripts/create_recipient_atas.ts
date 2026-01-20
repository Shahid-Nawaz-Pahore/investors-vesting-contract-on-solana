import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

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

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const mint = new PublicKey(requireEnv("MINT"));
  const payer = provider.wallet.publicKey;
  const connection = provider.connection;

  const csv = loadAllocationCsv();
  const wallets = parseWallets(csv);

  console.log(`Parsed ${wallets.length} recipient wallets`);

  const ataList = wallets.map((w) =>
    getAssociatedTokenAddressSync(mint, w, false, anchor.utils.token.TOKEN_PROGRAM_ID, anchor.utils.token.ASSOCIATED_PROGRAM_ID)
  );

  const missing: { wallet: PublicKey; ata: PublicKey }[] = [];
  for (let i = 0; i < ataList.length; i++) {
    const ata = ataList[i];
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      missing.push({ wallet: wallets[i], ata });
    }
  }

  console.log(`Missing ATAs: ${missing.length}`);
  if (missing.length === 0) {
    console.log("All ATAs already exist. Done.");
    return;
  }

  const batchSize = 8;
  for (let i = 0; i < missing.length; i += batchSize) {
    const slice = missing.slice(i, i + batchSize);
    const tx = new anchor.web3.Transaction();
    for (const { wallet, ata } of slice) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer,
          ata,
          wallet,
          mint,
          anchor.utils.token.TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        )
      );
    }
    const sig = await provider.sendAndConfirm(tx, []);
    console.log(`Created ${slice.length} ATAs: ${sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

//npx ts-node scripts/create_recipient_atas.ts