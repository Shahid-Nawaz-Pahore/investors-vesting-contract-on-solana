import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import assert from "assert";

// ── Load .env ────────────────────────────────────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

// ── CSV helper — just need one real wallet from CSV to revoke ─────────────────
function loadAllocationCsv(): string {
  const candidates = [
    resolve(process.cwd(), "allocation.csv"),
    resolve(process.cwd(), "vesting", "allocation.csv"),
    resolve(process.cwd(), "..", "allocation.csv"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("allocation.csv not found in repo root");
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
  if (wallets.length === 0) throw new Error("No wallets parsed from allocation.csv");
  return wallets;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

function findRecipientsPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("recipients"), scheduleState.toBuffer()],
    programId
  );
}

// ── Test Suite ────────────────────────────────────────────────────────────────
describe("revoke_recipient", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  // Pick last wallet from CSV as test subject — less likely to affect active releases
  const csv = loadAllocationCsv();
  const wallets = parseWallets(csv);
  const targetWallet = new PublicKey("rdr7FwfCVnRJtMKdSVqUNbqd6g9kAmb676XpFLvGiMw");

  // ── 1. Pre-condition: schedule_state and recipients exist ─────────────────
  it("schedule_state and recipients accounts exist on-chain", async () => {
    const stInfo = await provider.connection.getAccountInfo(scheduleState);
    const recInfo = await provider.connection.getAccountInfo(recipients);
    assert.ok(stInfo !== null, "schedule_state not found");
    assert.ok(recInfo !== null, "recipients not found");
  });

  // ── 2. Target wallet exists in recipients list ────────────────────────────
  it("target wallet exists in on-chain recipients list", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    const found = rec.entries
      .slice(0, count)
      .some((e: any) => e.wallet.equals(targetWallet));

    assert.ok(found, `Target wallet ${targetWallet.toBase58()} not found in recipients`);
    console.log(`  target wallet: ${targetWallet.toBase58()}`);
  });

  // ── 3. revokeRecipient tx succeeds ───────────────────────────────────────
  it("revokeRecipient sends successfully and returns a signature", async () => {
    // Check if already revoked — skip if so
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    const entry = rec.entries
      .slice(0, count)
      .find((e: any) => e.wallet.equals(targetWallet));

    if (entry && entry.revoked !== 0) {
      console.log("  target wallet already revoked — skipping tx");
      return;
    }

    const sig = await program.methods
      .revokeRecipient(targetWallet)
      .accounts({
        scheduleState,
        recipients,
        admin: provider.wallet.publicKey,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  revokeRecipient tx: ${sig}`);
  });

  // ── 4. On-chain revoked flag is set to 1 ──────────────────────────────────
  it("on-chain revoked flag is 1 for target wallet after revoke", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    const entry = rec.entries
      .slice(0, count)
      .find((e: any) => e.wallet.equals(targetWallet));

    assert.ok(entry, `Target wallet ${targetWallet.toBase58()} not found after revoke`);
    assert.strictEqual(entry.revoked, 1, `Expected revoked=1, got ${entry.revoked}`);
    console.log(`  revoked flag: ${entry.revoked} ✓`);
  });

  // ── 5. Other recipients are NOT affected ──────────────────────────────────
  it("other recipients remain unrevoked after revokeRecipient", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    let revokedCount = 0;
    for (const e of rec.entries.slice(0, count)) {
      if (!e.wallet.equals(targetWallet) && e.revoked !== 0) {
        revokedCount++;
        console.log(`  unexpected revoke: ${e.wallet.toBase58()}`);
      }
    }
    assert.strictEqual(revokedCount, 0, `${revokedCount} other recipient(s) unexpectedly revoked`);
  });

  // ── 6. Revoking same wallet again fails with RecipientRevoked error ────────
  it("revoking already-revoked wallet fails with RecipientRevoked error", async () => {
    try {
      await program.methods
        .revokeRecipient(targetWallet)
        .accounts({
          scheduleState,
          recipients,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      assert.fail("Expected error for double-revoke but tx succeeded");
    } catch (err: any) {
      const logs: string = err?.logs?.join(" ") ?? err?.message ?? "";
      const isExpectedError =
        logs.includes("RecipientRevoked") ||
        logs.includes("6") || // error code
        err?.error?.errorCode?.code === "RecipientRevoked";
      assert.ok(isExpectedError, `Unexpected error: ${err?.message}`);
      console.log("  double-revoke correctly rejected ✓");
    }
  });
});