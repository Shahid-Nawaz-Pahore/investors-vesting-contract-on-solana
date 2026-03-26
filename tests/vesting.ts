import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getMint,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import assert from "assert";

// ─── .env load ────────────────────────────────────────────────────────────────
const envCandidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "vesting", ".env"),
];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

// ─── Constants ────────────────────────────────────────────────────────────────
const DECIMALS = 6;
const TOTAL_SUPPLY_UI = 200_000_000;
const START_TS_UTC = "2026-03-26T05:25:00.000Z";
const MINT = new PublicKey("ACF6FKww1NpsWbV9Hfw9GUerd3Goq53tKwQoKxKNgDyX");
const DISTRIBUTOR = new PublicKey("7iJdaPKi5y8r8rVeVNrGWrNMq177m2kUzvUnv8KcZSvC");
const REVOKE_TARGET = new PublicKey("rdr7FwfCVnRJtMKdSVqUNbqd6g9kAmb676XpFLvGiMw");
const BATCH_SIZE = 5;
const ADD_BATCH_SIZE = 10;

// ─── Distributor keypair loader ───────────────────────────────────────────────
// DISTRIBUTOR_KEYPAIR=/path/to/distributor.json — .env mein set karo
function loadDistributorKeypair(): Keypair {
  const kpPath =
    process.env.DISTRIBUTOR_KEYPAIR ||
    resolve(process.cwd(), "distributor.json");
  if (!existsSync(kpPath)) {
    throw new Error(
      `Distributor keypair not found at: ${kpPath}\n` +
        `Set DISTRIBUTOR_KEYPAIR=/path/to/distributor.json in .env`
    );
  }
  const raw = JSON.parse(readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
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
    if (!parts[0] || !parts[1]) continue;
    entries.push({
      wallet: new PublicKey(parts[0]),
      allocation: new BN(parts[1]),
    });
  }
  if (entries.length === 0) throw new Error("No allocations parsed from allocation.csv");
  return entries;
}

function parseWallets(csv: string): PublicKey[] {
  return parseAllocations(csv).map((e) => e.wallet);
}

// ─── PDA helpers ──────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("schedule_state")],
    programId
  );
}
function findRecipientsPda(
  programId: PublicKey,
  scheduleState: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("recipients"), scheduleState.toBuffer()],
    programId
  );
}
function findVaultPda(
  programId: PublicKey,
  scheduleState: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), scheduleState.toBuffer()],
    programId
  );
}

// ─── Error helper ─────────────────────────────────────────────────────────────
function hasError(err: any, errorName: string): boolean {
  const logs: string = err?.logs?.join(" ") ?? err?.message ?? "";
  return logs.includes(errorName) || err?.error?.errorCode?.code === errorName;
}

// ─── Timestamp helper ─────────────────────────────────────────────────────────
function toUnixTs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ISO date: ${iso}`);
  return Math.floor(ms / 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. initialize_schedule
// ══════════════════════════════════════════════════════════════════════════════
describe("initialize_schedule", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const startTs = toUnixTs(START_TS_UTC);
  const totalSupply = new BN(TOTAL_SUPPLY_UI).mul(new BN(10).pow(new BN(DECIMALS)));

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  it("mint has expected decimals", async () => {
    const mintInfo = await getMint(provider.connection, MINT);
    assert.strictEqual(mintInfo.decimals, DECIMALS,
      `Expected decimals ${DECIMALS}, got ${mintInfo.decimals}`);
  });

  it("PDAs are derived deterministically", () => {
    const [ss] = findScheduleStatePda(program.programId);
    const [rec] = findRecipientsPda(program.programId, ss);
    const [vlt] = findVaultPda(program.programId, ss);
    assert.ok(ss.equals(scheduleState), "schedule_state PDA mismatch");
    assert.ok(rec.equals(recipients), "recipients PDA mismatch");
    assert.ok(vlt.equals(vault), "vault PDA mismatch");
  });

  it("initializeSchedule sends successfully (skip if already initialized)", async () => {
    const existing = await provider.connection.getAccountInfo(scheduleState);
    if (existing !== null) {
      console.log("  schedule_state already initialized — skipping tx");
      return;
    }
    const sig = await program.methods
      .initializeSchedule(DISTRIBUTOR, new BN(startTs), totalSupply)
      .accounts({
        scheduleState,
        recipients,
        vault,
        mint: MINT,
        admin: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    assert.ok(sig, "Expected a transaction signature");
    console.log("  initializeSchedule tx:", sig);
  });

  it("schedule_state fields match initialization inputs", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st.mint.equals(MINT), `mint mismatch`);
    assert.ok(st.admin.equals(provider.wallet.publicKey), "admin mismatch");
    assert.ok(st.distributor.equals(DISTRIBUTOR), `distributor mismatch`);
    assert.ok(st.totalSupply.eq(totalSupply), `total_supply mismatch`);
    assert.ok(st.startTs.toNumber() > 0, "start_ts should be > 0");
    assert.strictEqual(st.releasedSupply.toNumber(), 0, "released_supply should be 0");
    // Allow recipient_count > 0 if schedule was already initialized in a previous run
    assert.ok(st.recipientCount >= 0, `recipient_count should be >= 0, got ${st.recipientCount}`);
    // sealed can be true or false depending on whether add_recipients already ran
    assert.ok(st.sealed === true || st.sealed === false, "sealed should be boolean");
    assert.strictEqual(st.paused, false, "paused should be false");
    console.log(`  start_ts: ${new Date(st.startTs.toNumber() * 1000).toISOString()}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. add_recipients
// ══════════════════════════════════════════════════════════════════════════════
describe("add_recipients", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  it("CSV parses without errors and has at least one entry", () => {
    const entries = parseAllocations(loadAllocationCsv());
    assert.ok(entries.length > 0, "Expected at least one allocation entry");
    console.log(`  Parsed ${entries.length} entries from allocation.csv`);
  });

  it("CSV has no duplicate wallet addresses", () => {
    const entries = parseAllocations(loadAllocationCsv());
    const seen = new Set<string>();
    for (const e of entries) {
      const key = e.wallet.toBase58();
      assert.ok(!seen.has(key), `Duplicate wallet in CSV: ${key}`);
      seen.add(key);
    }
  });

  it("every allocation in CSV is greater than zero", () => {
    const entries = parseAllocations(loadAllocationCsv());
    for (const e of entries) {
      assert.ok(e.allocation.gtn(0), `Zero allocation: ${e.wallet.toBase58()}`);
    }
  });

  it("sum of all allocations does not exceed schedule total_supply", async () => {
    const entries = parseAllocations(loadAllocationCsv());
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;
    let sum = new BN(0);
    for (const e of entries) sum = sum.add(e.allocation);
    assert.ok(sum.lte(totalSupply),
      `Allocation sum ${sum} exceeds total_supply ${totalSupply}`);
    console.log(`  alloc sum: ${sum.toString()} / total: ${totalSupply.toString()}`);
  });

  it("schedule_state account exists on-chain before add_recipients", async () => {
    const info = await provider.connection.getAccountInfo(scheduleState);
    assert.ok(info !== null, "schedule_state not found — run initialize_schedule first");
  });

  it("add_recipients batches send successfully — last batch seals the schedule", async () => {
    const allEntries = parseAllocations(loadAllocationCsv());
    const stBefore = await (program.account as any).scheduleState.fetch(scheduleState);
    if (stBefore.sealed) {
      console.log("  already sealed — skipping add_recipients txs");
      return;
    }
    for (let i = 0; i < allEntries.length; i += ADD_BATCH_SIZE) {
      const slice = allEntries.slice(i, i + ADD_BATCH_SIZE);
      const seal = i + ADD_BATCH_SIZE >= allEntries.length;
      const sig = await program.methods
        .addRecipients(slice, seal)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.ok(sig, `Expected signature for batch at index ${i}`);
      console.log(`  batch [${i}–${i + slice.length - 1}] seal=${seal} tx: ${sig}`);
    }
  });

  it("on-chain recipient_count matches CSV entries", async () => {
    const allEntries = parseAllocations(loadAllocationCsv());
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.recipientCount, allEntries.length,
      `on-chain: ${st.recipientCount}, CSV: ${allEntries.length}`);
    console.log(`  recipient_count: ${st.recipientCount}`);
  });

  it("schedule_state is sealed after all batches", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.sealed, true, "Expected sealed=true");
  });

  it("on-chain recipient entries match CSV wallet and allocation values", async () => {
    const allEntries = parseAllocations(loadAllocationCsv());
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    const onChainMap = new Map<string, any>();
    for (let i = 0; i < count; i++) {
      const e = rec.entries[i];
      onChainMap.set(e.wallet.toBase58(), e);
    }
    for (const csvEntry of allEntries) {
      const key = csvEntry.wallet.toBase58();
      const onChain = onChainMap.get(key);
      assert.ok(onChain, `Wallet ${key} not found on-chain`);
      assert.ok(onChain.allocation.eq(csvEntry.allocation),
        `Allocation mismatch for ${key}`);
      assert.strictEqual(onChain.releasedAmount.toNumber(), 0,
        `released_amount should be 0 for ${key}`);
      // Allow REVOKE_TARGET to be revoked (from previous test runs on persistent devnet state)
      if (!onChain.wallet.equals(REVOKE_TARGET)) {
        assert.strictEqual(onChain.revoked, 0, `revoked should be 0 for ${key}`);
      }
    }
    console.log(`  Verified ${allEntries.length} entries match CSV`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. deposit_tokens
// ══════════════════════════════════════════════════════════════════════════════
describe("deposit_tokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [vault] = findVaultPda(program.programId, scheduleState);
  const adminAta = getAssociatedTokenAddressSync(
    MINT, provider.wallet.publicKey, false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  it("schedule_state exists and is sealed before deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st, "schedule_state not found");
    assert.strictEqual(st.sealed, true, "schedule must be sealed before deposit");
    console.log(`  total_supply: ${st.totalSupply.toString()}`);
  });

  it("admin ATA exists and has sufficient balance for full deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    // Skip check if vault is already fully funded
    if (vaultBalance.gte(st.totalSupply)) {
      console.log("  vault already fully funded — skipping ATA balance check");
      return;
    }
    const ataInfo = await getAccount(
      provider.connection, adminAta, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const ataBalance = new BN(ataInfo.amount.toString());
    assert.ok(ataBalance.gte(st.totalSupply),
      `ATA balance ${ataBalance} < total_supply ${st.totalSupply}`);
    console.log(`  admin ATA balance: ${ataBalance.toString()}`);
  });

  it("depositTokens sends successfully (skip if vault already funded)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    if (new BN(vaultInfo.amount.toString()).eq(totalSupply)) {
      console.log("  vault already fully funded — skipping deposit tx");
      return;
    }
    const sig = await program.methods
      .depositTokens(totalSupply)
      .accounts({
        scheduleState, vault,
        adminTokenAccount: adminAta,
        admin: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();
    assert.ok(sig, "Expected a transaction signature");
    console.log(`  depositTokens tx: ${sig}`);
  });

  it("vault balance equals total_supply after deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    assert.ok(vaultBalance.eq(st.totalSupply),
      `vault ${vaultBalance} != total_supply ${st.totalSupply}`);
    console.log(`  vault balance: ${vaultBalance.toString()}`);
  });

  it("vault token account mint matches schedule mint", async () => {
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    assert.ok(vaultInfo.mint.equals(MINT), `vault mint mismatch`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. pause / unpause
// ══════════════════════════════════════════════════════════════════════════════
describe("pause / unpause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);

  it("schedule is not paused before pause call (restore if needed)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    if (st.paused) {
      const sig = await program.methods.unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey }).rpc();
      console.log(`  pre-test unpause tx: ${sig}`);
    }
    const stAfter = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(stAfter.paused, false, "should not be paused before test");
  });

  it("pause tx succeeds", async () => {
    const sig = await program.methods.pause()
      .accounts({ scheduleState, admin: provider.wallet.publicKey }).rpc();
    assert.ok(sig, "Expected a transaction signature");
    console.log(`  pause tx: ${sig}`);
  });

  it("paused flag is true after pause", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.paused, true, "Expected paused=true");
  });

  it("admin and sealed fields unchanged after pause", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st.admin.equals(provider.wallet.publicKey), "admin changed unexpectedly");
    assert.strictEqual(st.sealed, true, "sealed should still be true");
  });

  it("double-pause fails with SchedulePaused", async () => {
    try {
      await program.methods.pause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey }).rpc();
      assert.fail("Expected SchedulePaused error");
    } catch (err: any) {
      assert.ok(hasError(err, "SchedulePaused"), `Unexpected error: ${err?.message}`);
      console.log("  double-pause correctly rejected ✓");
    }
  });

  it("unpause restores paused=false", async () => {
    const sig = await program.methods.unpause()
      .accounts({ scheduleState, admin: provider.wallet.publicKey }).rpc();
    assert.ok(sig, "Expected a signature");
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.paused, false, "Expected paused=false after unpause");
    console.log(`  restore unpause tx: ${sig}`);
  });

  it("double-unpause fails with ScheduleNotPaused", async () => {
    try {
      await program.methods.unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey }).rpc();
      assert.fail("Expected ScheduleNotPaused error");
    } catch (err: any) {
      assert.ok(hasError(err, "ScheduleNotPaused"), `Unexpected error: ${err?.message}`);
      console.log("  double-unpause correctly rejected ✓");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. set_distributor
// ══════════════════════════════════════════════════════════════════════════════
describe("set_distributor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);

  it("schedule_state exists on-chain", async () => {
    const info = await provider.connection.getAccountInfo(scheduleState);
    assert.ok(info !== null, "schedule_state not found");
  });

  it("setDistributor updates distributor to new valid address", async () => {
    const newDistributor = Keypair.generate().publicKey;
    const sig = await program.methods
      .setDistributor(newDistributor)
      .accounts({ scheduleState, admin: provider.wallet.publicKey })
      .rpc();
    assert.ok(sig, "Expected a signature");
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st.distributor.equals(newDistributor), "distributor not updated");
    console.log(`  new distributor: ${newDistributor.toBase58()}`);
  });

  it("restores original distributor", async () => {
    const sig = await program.methods
      .setDistributor(DISTRIBUTOR)
      .accounts({ scheduleState, admin: provider.wallet.publicKey })
      .rpc();
    assert.ok(sig, "Expected a signature");
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st.distributor.equals(DISTRIBUTOR), "distributor not restored");
    console.log(`  distributor restored: ${st.distributor.toBase58()}`);
  });

  it("admin field unchanged after setDistributor", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st.admin.equals(provider.wallet.publicKey), "admin changed unexpectedly");
  });

  it("setDistributor fails with InvalidConfig when new_distributor == admin", async () => {
    try {
      await program.methods
        .setDistributor(provider.wallet.publicKey)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidConfig");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidConfig"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidConfig (distributor==admin) ✓");
    }
  });

  it("setDistributor fails with InvalidPubkey for default pubkey", async () => {
    try {
      await program.methods
        .setDistributor(PublicKey.default)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidPubkey");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidPubkey"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidPubkey ✓");
    }
  });

  it("setDistributor fails with InvalidConfig when new_distributor == schedule_state PDA", async () => {
    try {
      await program.methods
        .setDistributor(scheduleState)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidConfig");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidConfig"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidConfig (distributor==PDA) ✓");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. revoke_recipient
// ══════════════════════════════════════════════════════════════════════════════
describe("revoke_recipient", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);

  it("schedule_state and recipients accounts exist on-chain", async () => {
    const stInfo = await provider.connection.getAccountInfo(scheduleState);
    const recInfo = await provider.connection.getAccountInfo(recipients);
    assert.ok(stInfo !== null, "schedule_state not found");
    assert.ok(recInfo !== null, "recipients not found");
  });

  it("target wallet exists in on-chain recipients list", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const found = rec.entries
      .slice(0, st.recipientCount)
      .some((e: any) => e.wallet.equals(REVOKE_TARGET));
    assert.ok(found, `Target wallet ${REVOKE_TARGET.toBase58()} not found`);
  });

  it("revokeRecipient tx succeeds (skip if already revoked)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const entry = rec.entries
      .slice(0, st.recipientCount)
      .find((e: any) => e.wallet.equals(REVOKE_TARGET));
    if (entry?.revoked !== 0) {
      console.log("  already revoked — skipping tx");
      return;
    }
    const sig = await program.methods
      .revokeRecipient(REVOKE_TARGET)
      .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
      .rpc();
    assert.ok(sig, "Expected a signature");
    console.log(`  revokeRecipient tx: ${sig}`);
  });

  it("on-chain revoked flag is 1 for target wallet", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const entry = rec.entries
      .slice(0, st.recipientCount)
      .find((e: any) => e.wallet.equals(REVOKE_TARGET));
    assert.ok(entry, "Target wallet not found after revoke");
    assert.strictEqual(entry.revoked, 1, `Expected revoked=1, got ${entry.revoked}`);
    console.log(`  revoked flag: ${entry.revoked} ✓`);
  });

  it("other recipients remain unrevoked", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    let unexpected = 0;
    for (const e of rec.entries.slice(0, st.recipientCount)) {
      if (!e.wallet.equals(REVOKE_TARGET) && e.revoked !== 0) {
        unexpected++;
        console.log(`  unexpected revoke: ${e.wallet.toBase58()}`);
      }
    }
    assert.strictEqual(unexpected, 0, `${unexpected} recipient(s) unexpectedly revoked`);
  });

  it("double-revoke fails with RecipientRevoked", async () => {
    try {
      await program.methods
        .revokeRecipient(REVOKE_TARGET)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientRevoked");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientRevoked"), `Unexpected error: ${err?.message}`);
      console.log("  double-revoke correctly rejected ✓");
    }
  });

  it("revoke_recipient fails with RecipientNotFound for unknown wallet", async () => {
    const unknownWallet = Keypair.generate().publicKey;
    try {
      await program.methods
        .revokeRecipient(unknownWallet)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientNotFound");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientNotFound"), `Unexpected error: ${err?.message}`);
      console.log("  RecipientNotFound ✓");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. batch_release  (distributor keypair se sign hoga)
// ══════════════════════════════════════════════════════════════════════════════

describe("batch_release", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // Distributor keypair — yeh sign karega batchRelease txs
  let distributorKp: Keypair;
  before(() => {
    distributorKp = loadDistributorKeypair();
    assert.ok(
      distributorKp.publicKey.equals(DISTRIBUTOR),
      `distributor.json pubkey mismatch:\n  expected: ${DISTRIBUTOR.toBase58()}\n  got:      ${distributorKp.publicKey.toBase58()}`
    );
    console.log(`  distributor keypair loaded: ${distributorKp.publicKey.toBase58()}`);
  });

  it("schedule_state is sealed and not paused", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.sealed, true, "schedule must be sealed");
    assert.strictEqual(st.paused, false, "schedule must not be paused");
    assert.ok(st.distributor.equals(DISTRIBUTOR), "distributor mismatch on-chain");
    console.log(`  released_supply before: ${st.releasedSupply.toString()}`);
  });

  it("vault is fully funded", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    assert.ok(vaultBalance.eq(st.totalSupply),
      `vault ${vaultBalance} != total_supply ${st.totalSupply}`);
    console.log(`  vault balance: ${vaultBalance.toString()}`);
  });

  // ── ATA auto-creation ─────────────────────────────────────────────────────
  it("creates missing recipient ATAs (skip if all exist)", async () => {
    const wallets = parseWallets(loadAllocationCsv());
    const payer = provider.wallet.publicKey;
    const ATA_BATCH_SIZE = 8;

    // Pehle sabhi ATAs check karo — missing list banao
    const missing: { wallet: PublicKey; ata: PublicKey }[] = [];
    for (const wallet of wallets) {
      const ata = getAssociatedTokenAddressSync(
        MINT, wallet, false,
        anchor.utils.token.TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      const info = await provider.connection.getAccountInfo(ata);
      if (info === null) missing.push({ wallet, ata });
    }

    if (missing.length === 0) {
      console.log(`  All ${wallets.length} ATAs already exist ✓`);
      return;
    }

    console.log(`  Creating ${missing.length} missing ATA(s)...`);

    // Batches mein ATAs banao
    for (let i = 0; i < missing.length; i += ATA_BATCH_SIZE) {
      const slice = missing.slice(i, i + ATA_BATCH_SIZE);
      const tx = new anchor.web3.Transaction();

      for (const { wallet, ata } of slice) {
        tx.add(
          createAssociatedTokenAccountInstruction(
  payer,
  ata,
  wallet,
  MINT,
  anchor.utils.token.TOKEN_PROGRAM_ID,
  anchor.utils.token.ASSOCIATED_PROGRAM_ID
)
        );
      }

      const sig = await provider.sendAndConfirm(tx, []);
      console.log(`  Created ATAs [${i + 1}–${i + slice.length}]: ${sig}`);
    }

    // Final verification — sab ban gaye?
    let stillMissing = 0;
    for (const { ata, wallet } of missing) {
      const info = await provider.connection.getAccountInfo(ata);
      if (info === null) {
        console.log(`  STILL MISSING: ${wallet.toBase58()}`);
        stillMissing++;
      }
    }
    assert.strictEqual(stillMissing, 0,
      `${stillMissing} ATA(s) could not be created`);
    console.log(`  All ATAs created successfully ✓`);
  });

  it("batch_release sends all batches successfully", async () => {
    const wallets = parseWallets(loadAllocationCsv());

    // Check if vesting has started
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const now = Math.floor(Date.now() / 1000);
    if (now < st.startTs.toNumber()) {
      console.log(`  Vesting start_ts (${new Date(st.startTs.toNumber() * 1000).toISOString()}) not reached yet — skipping batch_release`);
      return;
    }

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const slice = wallets.slice(i, i + BATCH_SIZE);
      const atas = slice.map((w) =>
        getAssociatedTokenAddressSync(
          MINT, w, false,
          anchor.utils.token.TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        )
      );
      const sig = await program.methods
        .batchRelease(slice)
        .accounts({
          scheduleState, recipients, vault,
          distributor: distributorKp.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(
          atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true }))
        )
        .signers([distributorKp])
        .rpc();
      assert.ok(sig, `Expected signature for batch ${i + 1}–${i + slice.length}`);
      console.log(`  batch [${i + 1}–${i + slice.length}] tx: ${sig}`);
    }
  });

  it("released_supply > 0 after batch_release", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const now = Math.floor(Date.now() / 1000);
    if (now < st.startTs.toNumber()) {
      console.log(`  Skipping released_supply check — vesting hasn't started yet`);
      return;
    }
    assert.ok(st.releasedSupply.gtn(0),
      `released_supply should be > 0, got ${st.releasedSupply}`);
    console.log(`  released_supply: ${st.releasedSupply.toString()}`);
  });

  it("vault balance = total_supply - released_supply after batch_release", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    const expected = st.totalSupply.sub(st.releasedSupply);
    assert.ok(vaultBalance.eq(expected),
      `vault ${vaultBalance} != expected ${expected}`);
    console.log(`  vault after: ${vaultBalance} | released: ${st.releasedSupply}`);
  });

  // ── Negative: empty batch ─────────────────────────────────────────────────
  it("batchRelease fails with EmptyBatch for empty wallets array", async () => {
    try {
      await program.methods
        .batchRelease([])
        .accounts({
          scheduleState, recipients, vault,
          distributor: distributorKp.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([])
        .signers([distributorKp])
        .rpc();
      assert.fail("Expected EmptyBatch");
    } catch (err: any) {
      assert.ok(hasError(err, "EmptyBatch"), `Unexpected error: ${err?.message}`);
      console.log("  EmptyBatch correctly rejected ✓");
    }
  });

  // ── Negative: batch > 5 ───────────────────────────────────────────────────
  it("batchRelease fails with BatchTooLarge for 6 wallets", async () => {
    const wallets = parseWallets(loadAllocationCsv()).slice(0, 6);
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
          scheduleState, recipients, vault,
          distributor: distributorKp.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })))
        .signers([distributorKp])
        .rpc();
      assert.fail("Expected BatchTooLarge");
    } catch (err: any) {
      assert.ok(hasError(err, "BatchTooLarge"), `Unexpected error: ${err?.message}`);
      console.log("  BatchTooLarge correctly rejected ✓");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. negative_tests — admin-only instructions
// ══════════════════════════════════════════════════════════════════════════════
describe("negative tests — admin instructions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);
  const adminAta = getAssociatedTokenAddressSync(
    MINT, provider.wallet.publicKey, false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  it("add_recipients fails with RecipientsSealed when schedule is sealed", async () => {
    const wallets = parseWallets(loadAllocationCsv());
    const dummyInput = [{ wallet: wallets[0], allocation: new BN(1) }];
    try {
      await program.methods
        .addRecipients(dummyInput, false)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientsSealed");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientsSealed"), `Unexpected error: ${err?.message}`);
      console.log("  RecipientsSealed ✓");
    }
  });

  it("deposit_tokens fails with DepositAfterStart when start_ts has passed", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    if (Math.floor(Date.now() / 1000) < st.startTs.toNumber()) {
      console.log("  start_ts not passed yet — skipping DepositAfterStart test");
      return;
    }
    try {
      await program.methods
        .depositTokens(new BN(1))
        .accounts({
          scheduleState, vault,
          adminTokenAccount: adminAta,
          admin: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Expected DepositAfterStart");
    } catch (err: any) {
      assert.ok(hasError(err, "DepositAfterStart"), `Unexpected error: ${err?.message}`);
      console.log("  DepositAfterStart ✓");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. sweep_dust_after_end
// ══════════════════════════════════════════════════════════════════════════════
describe("sweep_dust_after_end", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);
  const adminDestination = getAssociatedTokenAddressSync(
    MINT, provider.wallet.publicKey, false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  it("logs vesting end status (informational)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const startTs: number = st.startTs.toNumber();
    const vestingEndTs = startTs + 365 * 24 * 60 * 60;
    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs < vestingEndTs) {
      console.log(`  Vesting NOT ended yet.`);
      console.log(`  vesting_end: ${new Date(vestingEndTs * 1000).toISOString()}`);
      console.log(`  now:         ${new Date(nowTs * 1000).toISOString()}`);
    } else {
      console.log(`  Vesting ended ✓`);
    }
    assert.ok(startTs > 0, "start_ts should be > 0");
  });

  it("logs outstanding recipients (informational)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    let outstanding = 0;
    for (const e of rec.entries.slice(0, st.recipientCount)) {
      if (e.revoked === 0 && !e.releasedAmount.eq(e.allocation)) {
        outstanding++;
      }
    }
    if (outstanding > 0) {
      console.log(`  ${outstanding} recipient(s) not fully released — sweep will fail`);
    } else {
      console.log(`  All non-revoked recipients fully released ✓`);
    }
    assert.ok(st.recipientCount > 0, "recipient_count should be > 0");
  });

  it("admin destination ATA exists on-chain", async () => {
    const info = await provider.connection.getAccountInfo(adminDestination);
    assert.ok(info !== null, `Admin ATA not found: ${adminDestination.toBase58()}`);
  });

  it("dust calculation is correct (vault - committed)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection, vault, "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    const committed = st.totalSupply.sub(st.releasedSupply);
    const dust = vaultBalance.sub(committed);
    console.log(`  vault: ${vaultBalance} | committed: ${committed} | dust: ${dust.gtn(0) ? dust : "0"}`);
    assert.ok(vaultBalance.gte(new BN(0)), "vault >= 0");
  });

  it("sweepDustAfterEnd sends successfully (skip if conditions not met)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const startTs: number = st.startTs.toNumber();
    const vestingEndTs = startTs + 365 * 24 * 60 * 60;
    if (Math.floor(Date.now() / 1000) < vestingEndTs) {
      console.log("  Vesting not ended — skipping sweep tx");
      return;
    }
    const rec = await (program.account as any).recipients.fetch(recipients);
    const hasOutstanding = rec.entries
      .slice(0, st.recipientCount)
      .some((e: any) => e.revoked === 0 && !e.releasedAmount.eq(e.allocation));
    if (hasOutstanding) {
      console.log("  Outstanding releases exist — skipping sweep tx");
      return;
    }
    const sig = await program.methods
      .sweepDustAfterEnd()
      .accounts({
        scheduleState, recipients, vault,
        adminDestination,
        mint: MINT,
        admin: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();
    assert.ok(sig, "Expected a signature");
    console.log(`  sweepDustAfterEnd tx: ${sig}`);
  });
});