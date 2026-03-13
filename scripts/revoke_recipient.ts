import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

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

async function main() {
  // --- Wallet must be admin ---
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  // Wallet to revoke — pass as CLI arg: ts-node revoke_recipient.ts <WALLET_PUBKEY>
  const walletArg = process.argv[2];
  if (!walletArg) {
    throw new Error(
      "Missing wallet argument.\nUsage: npx ts-node scripts/revoke_recipient.ts <WALLET_PUBKEY>"
    );
  }

  let walletToRevoke: PublicKey;
  try {
    walletToRevoke = new PublicKey(walletArg);
  } catch {
    throw new Error(`Invalid wallet pubkey: ${walletArg}`);
  }

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  // Fetch on-chain state to confirm admin matches wallet
  const st = await (program.account as any).scheduleState.fetch(scheduleState);
  if (!provider.wallet.publicKey.equals(st.admin)) {
    throw new Error(
      `ANCHOR_WALLET must be the admin.\nExpected: ${st.admin.toBase58()}\nGot:      ${provider.wallet.publicKey.toBase58()}`
    );
  }

  console.log("Revoking recipient:", walletToRevoke.toBase58());
  console.log("Admin:             ", provider.wallet.publicKey.toBase58());
  console.log("schedule_state:    ", scheduleState.toBase58());

  const sig = await program.methods
    .revokeRecipient(walletToRevoke)
    .accounts({
      scheduleState,
      recipients,
      admin: provider.wallet.publicKey,
    })
    .rpc();

  console.log("revokeRecipient tx:", sig);
  console.log(`Recipient ${walletToRevoke.toBase58()} successfully revoked.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Usage:
// npx ts-node scripts/revoke_recipient.ts <WALLET_PUBKEY>