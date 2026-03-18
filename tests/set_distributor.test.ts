import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import assert from "assert";

// ── Load .env ────────────────────────────────────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const DISTRIBUTOR = new PublicKey("7iJdaPKi5y8r8rVeVNrGWrNMq177m2kUzvUnv8KcZSvC");

// ── PDA helper ───────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

// ── Test Suite ───────────────────────────────────────────────────────────────
describe("set_distributor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);

  // ── 1. schedule_state exists before test ─────────────────────────────────
  it("schedule_state exists on-chain", async () => {
    const info = await provider.connection.getAccountInfo(scheduleState);
    assert.ok(info !== null, "schedule_state not found — run initialize_schedule first");
  });

  // ── 2. setDistributor succeeds with a valid new distributor ───────────────
  it("setDistributor updates distributor to new valid address", async () => {
    // Use a random keypair as new distributor (valid — not admin, not PDA, not default)
    const newDistributor = Keypair.generate().publicKey;

    const sig = await program.methods
      .setDistributor(newDistributor)
      .accounts({
        scheduleState,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  setDistributor tx: ${sig}`);
    console.log(`  new distributor: ${newDistributor.toBase58()}`);

    // Verify on-chain
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(
      st.distributor.equals(newDistributor),
      `distributor not updated: expected ${newDistributor.toBase58()}, got ${st.distributor.toBase58()}`
    );
  });

  // ── 3. Restore original distributor from .env ─────────────────────────────
  it("restores original distributor back to DISTRIBUTOR from .env", async () => {
    const sig = await program.methods
      .setDistributor(DISTRIBUTOR)
      .accounts({
        scheduleState,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  restore distributor tx: ${sig}`);

    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(
      st.distributor.equals(DISTRIBUTOR),
      `distributor not restored: expected ${DISTRIBUTOR.toBase58()}, got ${st.distributor.toBase58()}`
    );
    console.log(`  distributor restored: ${st.distributor.toBase58()}`);
  });

  // ── 4. admin field unchanged after set_distributor ────────────────────────
  it("admin field remains unchanged after setDistributor", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(
      st.admin.equals(provider.wallet.publicKey),
      `admin changed unexpectedly: got ${st.admin.toBase58()}`
    );
  });
});