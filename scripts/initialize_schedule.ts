import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

const cwd = process.cwd();
const envCandidates = [resolve(cwd, ".env"), resolve(cwd, "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const DECIMALS = 6;
const TOTAL_SUPPLY_UI = 200_000_000; // 200M tokens
const START_TS_UTC = "2026-04-11T00:00:00.000Z";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function toUnixTs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return Math.floor(ms / 1000);
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

  const program = anchor.workspace.vesting as anchor.Program;

  const mint = new PublicKey(requireEnv("MINT"));
  const distributor = new PublicKey(requireEnv("DISTRIBUTOR"));

  const startTs = toUnixTs(START_TS_UTC);
  const totalSupply = new BN(TOTAL_SUPPLY_UI).mul(new BN(10).pow(new BN(DECIMALS)));

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  const mintInfo = await getMint(provider.connection, mint);
  if (mintInfo.decimals !== DECIMALS) {
    throw new Error(`Mint decimals mismatch: expected ${DECIMALS}, got ${mintInfo.decimals}`);
  }

  const sig = await program.methods
    .initializeSchedule(distributor, new BN(startTs), totalSupply)
    .accounts({
      scheduleState,
      recipients,
      vault,
      mint,
      admin: provider.wallet.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("initializeSchedule tx:", sig);
  console.log("schedule_state:", scheduleState.toBase58());
  console.log("recipients:", recipients.toBase58());
  console.log("vault:", vault.toBase58());
  console.log("start_ts:", startTs, START_TS_UTC);
  console.log("total_supply:", totalSupply.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

//npx ts-node scripts/initialize_schedule.ts

