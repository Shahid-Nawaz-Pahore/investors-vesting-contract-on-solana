import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import assert from "assert";

// ── Load .env ────────────────────────────────────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

// ── PDA helper ───────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

// ── Test Suite ────────────────────────────────────────────────────────────────
describe("pause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);

  // ── 1. Pre-condition: schedule is not paused before test ──────────────────
  it("schedule_state is not paused before pause call", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);

    // Agar already paused hai toh pehle unpause karo
    if (st.paused) {
      const sig = await program.methods
        .unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      console.log(`  pre-test unpause tx: ${sig}`);
    }

    const stAfter = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(stAfter.paused, false, "schedule should not be paused before test");
    console.log(`  paused before: ${stAfter.paused}`);
  });

  // ── 2. pause tx succeeds ──────────────────────────────────────────────────
  it("pause sends successfully and returns a signature", async () => {
    const sig = await program.methods
      .pause()
      .accounts({
        scheduleState,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  pause tx: ${sig}`);
  });

  // ── 3. On-chain paused flag is true ───────────────────────────────────────
  it("schedule_state paused flag is true after pause", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.paused, true, "Expected paused=true after pause call");
    console.log(`  paused after: ${st.paused}`);
  });

  // ── 4. Other fields unchanged after pause ─────────────────────────────────
  it("admin, distributor, sealed fields unchanged after pause", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);

    assert.ok(
      st.admin.equals(provider.wallet.publicKey),
      "admin changed unexpectedly"
    );
    assert.strictEqual(st.sealed, true, "sealed should still be true");
    console.log(`  admin: ${st.admin.toBase58()} ✓`);
    console.log(`  sealed: ${st.sealed} ✓`);
  });

  // ── 5. Pausing already-paused schedule fails ──────────────────────────────
  it("pausing an already-paused schedule fails with SchedulePaused error", async () => {
    try {
      await program.methods
        .pause()
        .accounts({
          scheduleState,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      assert.fail("Expected error for double-pause but tx succeeded");
    } catch (err: any) {
      const logs: string = err?.logs?.join(" ") ?? err?.message ?? "";
      const isExpectedError =
        logs.includes("SchedulePaused") ||
        err?.error?.errorCode?.code === "SchedulePaused";
      assert.ok(isExpectedError, `Unexpected error: ${err?.message}`);
      console.log("  double-pause correctly rejected ✓");
    }
  });

  // ── 6. Restore: unpause after tests so other tests are not affected ────────
  it("unpause after test to restore schedule state", async () => {
    const sig = await program.methods
      .unpause()
      .accounts({
        scheduleState,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature for unpause");
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.paused, false, "Expected paused=false after restore");
    console.log(`  restore unpause tx: ${sig}`);
    console.log(`  paused restored to: ${st.paused}`);
  });
});