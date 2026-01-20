import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

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

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as any;
  const action = requireEnv("ACTION").toLowerCase();

  const [scheduleState] = findScheduleStatePda(program.programId);

  let sig: string;
  if (action === "pause") {
    sig = await program.methods
      .pause()
      .accounts({ scheduleState, admin: provider.wallet.publicKey })
      .rpc();
  } else if (action === "unpause") {
    sig = await program.methods
      .unpause()
      .accounts({ scheduleState, admin: provider.wallet.publicKey })
      .rpc();
  } else {
    throw new Error("ACTION must be 'pause' or 'unpause'");
  }

  console.log(`${action} tx: ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

