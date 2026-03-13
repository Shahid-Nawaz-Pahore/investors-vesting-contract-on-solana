import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const cwd = process.cwd();
const envCandidates = [resolve(cwd, ".env"), resolve(cwd, "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
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

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // Fetch on-chain state to confirm admin matches wallet
  const st = await (program.account as any).scheduleState.fetch(scheduleState);
  if (!provider.wallet.publicKey.equals(st.admin)) {
    throw new Error(
      `ANCHOR_WALLET must be the admin.\nExpected: ${st.admin.toBase58()}\nGot:      ${provider.wallet.publicKey.toBase58()}`
    );
  }

  // Admin destination ATA — admin ka apna token account jahan dust jayegi
  const adminDestination = getAssociatedTokenAddressSync(
    mint,
    provider.wallet.publicKey,
    false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  console.log("Admin:             ", provider.wallet.publicKey.toBase58());
  console.log("schedule_state:    ", scheduleState.toBase58());
  console.log("vault:             ", vault.toBase58());
  console.log("admin_destination: ", adminDestination.toBase58());
  console.log("mint:              ", mint.toBase58());

  const sig = await program.methods
    .sweepDustAfterEnd()
    .accounts({
      scheduleState,
      recipients,
      vault,
      adminDestination,
      mint,
      admin: provider.wallet.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("sweepDustAfterEnd tx:", sig);
  console.log("Dust swept successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Usage:
// npx ts-node scripts/sweep_dust_after_end.ts