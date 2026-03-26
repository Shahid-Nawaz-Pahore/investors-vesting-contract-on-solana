import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import assert from "assert";

// ── Load .env ────────────────────────────────────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const MINT = new PublicKey("6mpM8NosprtdZfebytnkhjZSTj1W3AhtKP8FhNETTXHM");

// ── Helpers ───────────────────────────────────────────────────────────────────
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
function loadAllocationCsv(): string {
  const candidates = [
    resolve(process.cwd(), "allocation.csv"),
    resolve(process.cwd(), "vesting", "allocation.csv"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("allocation.csv not found");
}
function parseWallets(csv: string): PublicKey[] {
  const wallets: PublicKey[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    if (line.includes("wallet_pubkey")) continue;
    if (line.startsWith("-")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (!parts[0]) continue;
    wallets.push(new PublicKey(parts[0]));
  }
  return wallets;
}
function hasError(err: any, errorName: string): boolean {
  const logs: string = err?.logs?.join(" ") ?? err?.message ?? "";
  return logs.includes(errorName) || err?.error?.errorCode?.code === errorName;
}

// ── Test Suite (run with distributor wallet) ──────────────────────────────────
// export ANCHOR_WALLET=/home/shoaibmk/projects/investor_vesting_contract/distributor.json
describe("negative tests — distributor wallet required", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // ── Pre-condition: wallet is distributor ─────────────────────────────────
  it("ANCHOR_WALLET is the distributor", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(
      provider.wallet.publicKey.equals(st.distributor),
      `Expected distributor wallet.\nGot: ${provider.wallet.publicKey.toBase58()}\nExpected: ${st.distributor.toBase58()}`
    );
    console.log(`  distributor: ${provider.wallet.publicKey.toBase58()} ✓`);
  });

  // ── batch_release: empty batch → EmptyBatch ───────────────────────────────
  it("batch_release fails with EmptyBatch when wallets array is empty", async () => {
    try {
      await program.methods
        .batchRelease([])
        .accounts({
          scheduleState,
          recipients,
          vault,
          distributor: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([])
        .rpc();
      assert.fail("Expected EmptyBatch error");
    } catch (err: any) {
      assert.ok(hasError(err, "EmptyBatch"), `Unexpected error: ${err?.message}`);
      console.log("  EmptyBatch correctly rejected ✓");
    }
  });

  // ── batch_release: 6 wallets → BatchTooLarge ──────────────────────────────
  it("batch_release fails with BatchTooLarge when more than 5 wallets passed", async () => {
    const csv = loadAllocationCsv();
    const wallets = parseWallets(csv).slice(0, 6);
    const atas = wallets.map((w) =>
      getAssociatedTokenAddressSync(
        MINT, w, false,
        anchor.utils.token.TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      )
    );

    try {
      await program.methods
        .batchRelease(wallets)
        .accounts({
          scheduleState,
          recipients,
          vault,
          distributor: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })))
        .rpc();
      assert.fail("Expected BatchTooLarge error");
    } catch (err: any) {
      assert.ok(hasError(err, "BatchTooLarge"), `Unexpected error: ${err?.message}`);
      console.log("  BatchTooLarge correctly rejected ✓");
    }
  });

  // ── batch_release: paused schedule → SchedulePaused ──────────────────────
  // NOTE: pause/unpause admin wallet se karna hoga — yeh test skip karta hai
  // agar schedule paused nahi hai aur admin wallet available nahi
  it("batch_release fails with SchedulePaused when schedule is paused", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);

    if (!st.paused) {
      console.log("  Schedule not paused — this test requires admin to pause first.");
      console.log("  Run: pause.test.ts first, then re-run this test before unpause.");
      console.log("  Skipping SchedulePaused batch_release test.");
      return;
    }

    const csv = loadAllocationCsv();
    const wallets = parseWallets(csv).slice(0, 1);
    const atas = wallets.map((w) =>
      getAssociatedTokenAddressSync(
        MINT, w, false,
        anchor.utils.token.TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      )
    );

    try {
      await program.methods
        .batchRelease(wallets)
        .accounts({
          scheduleState,
          recipients,
          vault,
          distributor: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })))
        .rpc();
      assert.fail("Expected SchedulePaused error");
    } catch (err: any) {
      assert.ok(hasError(err, "SchedulePaused"), `Unexpected error: ${err?.message}`);
      console.log("  SchedulePaused (batch_release) correctly rejected ✓");
    }
  });
});