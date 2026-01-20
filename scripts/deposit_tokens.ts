import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
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

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [vault] = findVaultPda(program.programId, scheduleState);

  const adminAta = getAssociatedTokenAddressSync(
    mint,
    provider.wallet.publicKey,
    false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  const state = await program.account.scheduleState.fetch(scheduleState);
  const totalSupply = new BN(state.totalSupply.toString());

  const sig = await program.methods
    .depositTokens(totalSupply)
    .accounts({
      scheduleState,
      vault,
      adminTokenAccount: adminAta,
      admin: provider.wallet.publicKey,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`depositTokens tx: ${sig}`);
  console.log(`vault: ${vault.toBase58()}`);
  console.log(`amount: ${totalSupply.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

