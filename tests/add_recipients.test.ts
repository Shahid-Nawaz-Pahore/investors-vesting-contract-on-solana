import dotenv from "dotenv";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import assert from "assert";

// ── Load .env (same pattern as flow scripts) ─────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

// ── CSV loader (same logic as flow script) ───────────────────────────────────
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

function parseAllocations(csv: string): { wallet: PublicKey; allocation: BN }[] {
  const entries: { wallet: PublicKey; allocation: BN }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    if (line.includes("wallet_pubkey")) continue;
    if (line.startsWith("-")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const wallet = parts[0];
    const allocation = parts[1];
    if (!wallet || !allocation) continue;
    entries.push({ wallet: new PublicKey(wallet), allocation: new BN(allocation) });
  }
  if (entries.length === 0) throw new Error("No allocations parsed from allocation.csv");
  return entries;
}

// ── PDA helpers ──────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

function findRecipientsPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("recipients"), scheduleState.toBuffer()],
    programId
  );
}

// ── Test Suite ───────────────────────────────────────────────────────────────
describe("add_recipients", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  const BATCH_SIZE = 10;
  let allEntries: { wallet: PublicKey; allocation: BN }[] = [];

  // ── 1. CSV parse ──────────────────────────────────────────────────────────
  it("CSV parses without errors and has at least one entry", () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    assert.ok(allEntries.length > 0, "Expected at least one allocation entry");
    console.log(`  Parsed ${allEntries.length} entries from allocation.csv`);
  });

  // ── 2. No duplicate wallets in CSV ────────────────────────────────────────
  it("CSV has no duplicate wallet addresses", () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    const seen = new Set<string>();
    for (const e of allEntries) {
      const key = e.wallet.toBase58();
      assert.ok(!seen.has(key), `Duplicate wallet in CSV: ${key}`);
      seen.add(key);
    }
  });

  // ── 3. All allocations are positive ──────────────────────────────────────
  it("every allocation in CSV is greater than zero", () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    for (const e of allEntries) {
      assert.ok(
        e.allocation.gtn(0),
        `Zero allocation for wallet: ${e.wallet.toBase58()}`
      );
    }
  });

  // ── 4. Allocation sum does not exceed total_supply ────────────────────────
  it("sum of all allocations does not exceed schedule total_supply", async () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;

    let sum = new BN(0);
    for (const e of allEntries) {
      sum = sum.add(e.allocation);
    }

    assert.ok(
      sum.lte(totalSupply),
      `Allocation sum ${sum.toString()} exceeds total_supply ${totalSupply.toString()}`
    );
    console.log(`  Allocation sum: ${sum.toString()}`);
    console.log(`  Total supply:   ${totalSupply.toString()}`);
  });

  // ── 5. schedule_state is initialized before adding recipients ─────────────
  it("schedule_state account exists on-chain before add_recipients", async () => {
    const info = await provider.connection.getAccountInfo(scheduleState);
    assert.ok(info !== null, "schedule_state not found — run initialize_schedule first");
  });

  // ── 6. add_recipients batches succeed (skip if already sealed) ────────────
  it("add_recipients batches send successfully and last batch seals the schedule", async () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    // Skip if already sealed
    const stBefore = await (program.account as any).scheduleState.fetch(scheduleState);
    if (stBefore.sealed) {
      console.log("  schedule_state already sealed — skipping add_recipients txs");
      return;
    }

    for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
      const slice = allEntries.slice(i, i + BATCH_SIZE);
      const seal = i + BATCH_SIZE >= allEntries.length;

      const sig = await program.methods
        .addRecipients(slice, seal)
        .accounts({
          scheduleState,
          recipients,
          admin: provider.wallet.publicKey,
        })
        .rpc();

      assert.ok(sig, `Expected signature for batch starting at index ${i}`);
      console.log(`  Batch [${i}–${i + slice.length - 1}] seal=${seal} tx: ${sig}`);
    }
  });

  // ── 7. On-chain recipient_count matches CSV entries ───────────────────────
  it("on-chain recipient_count matches number of CSV entries", async () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(
      st.recipientCount,
      allEntries.length,
      `recipient_count on-chain: ${st.recipientCount}, CSV entries: ${allEntries.length}`
    );
    console.log(`  recipient_count on-chain: ${st.recipientCount}`);
  });

  // ── 8. schedule is sealed after all batches ───────────────────────────────
  it("schedule_state is sealed after all recipients added", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.sealed, true, "Expected sealed=true after all batches");
  });

  // ── 9. On-chain recipient entries match CSV data ──────────────────────────
  it("on-chain recipient entries match CSV wallet and allocation values", async () => {
    const csv = loadAllocationCsv();
    allEntries = parseAllocations(csv);

    const recipientsAccount = await (program.account as any).recipients.fetch(recipients);
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const count: number = st.recipientCount;

    // Build a map from on-chain entries for easy lookup
    const onChainMap = new Map<string, { allocation: BN; releasedAmount: BN; revoked: number }>();
    for (let i = 0; i < count; i++) {
      const e = recipientsAccount.entries[i];
      onChainMap.set(e.wallet.toBase58(), {
        allocation: e.allocation,
        releasedAmount: e.releasedAmount,
        revoked: e.revoked,
      });
    }

    for (const csvEntry of allEntries) {
      const key = csvEntry.wallet.toBase58();
      const onChain = onChainMap.get(key);

      assert.ok(onChain !== undefined, `Wallet ${key} not found on-chain`);
      assert.ok(
        onChain!.allocation.eq(csvEntry.allocation),
        `Allocation mismatch for ${key}: on-chain ${onChain!.allocation.toString()}, CSV ${csvEntry.allocation.toString()}`
      );
      assert.strictEqual(onChain!.releasedAmount.toNumber(), 0, `released_amount should be 0 for ${key}`);
      assert.strictEqual(onChain!.revoked, 0, `revoked should be 0 for ${key}`);
    }

    console.log(`  Verified ${allEntries.length} recipient entries match CSV`);
  });
});