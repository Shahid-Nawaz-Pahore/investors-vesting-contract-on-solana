import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import assert from "assert";

// ── Load .env (same pattern as flow scripts) ─────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

// ── Constants ────────────────────────────────────────────────────────────────
const DECIMALS = 6;
const TOTAL_SUPPLY_UI = 200_000_000;
const START_TS_UTC = "2026-03-18T09:30:00.000Z";

const MINT = new PublicKey("ACF6FKww1NpsWbV9Hfw9GUerd3Goq53tKwQoKxKNgDyX");
const DISTRIBUTOR = new PublicKey("7iJdaPKi5y8r8rVeVNrGWrNMq177m2kUzvUnv8KcZSvC");

// ── Helpers ──────────────────────────────────────────────────────────────────
function toUnixTs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ISO date: ${iso}`);
  return Math.floor(ms / 1000);
}

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

// ── Test Suite ───────────────────────────────────────────────────────────────
describe("initialize_schedule", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const startTs = toUnixTs(START_TS_UTC);
  const totalSupply = new BN(TOTAL_SUPPLY_UI).mul(
    new BN(10).pow(new BN(DECIMALS))
  );

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // ── 1. Mint decimals match ────────────────────────────────────────────────
  it("mint has expected decimals", async () => {
    const mintInfo = await getMint(provider.connection, MINT);
    assert.strictEqual(
      mintInfo.decimals,
      DECIMALS,
      `Expected decimals ${DECIMALS}, got ${mintInfo.decimals}`
    );
  });

  // ── 2. PDA derivations are deterministic ─────────────────────────────────
  it("PDAs are derived deterministically", () => {
    const [ss] = findScheduleStatePda(program.programId);
    const [rec] = findRecipientsPda(program.programId, ss);
    const [vlt] = findVaultPda(program.programId, ss);

    assert.ok(ss.equals(scheduleState), "schedule_state PDA mismatch");
    assert.ok(rec.equals(recipients), "recipients PDA mismatch");
    assert.ok(vlt.equals(vault), "vault PDA mismatch");
  });

  // ── 3. initializeSchedule succeeds (skip if already initialized) ──────────
  it("initializeSchedule sends successfully and returns a signature", async () => {
    const existing = await provider.connection.getAccountInfo(scheduleState);
    if (existing !== null) {
      console.log("  schedule_state already initialized — skipping tx (account already in use)");
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

  // ── 4. On-chain state matches initialization inputs ───────────────────────
  it("schedule_state fields match initialization inputs", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);

    assert.ok(
      st.mint.equals(MINT),
      `mint mismatch: expected ${MINT.toBase58()}, got ${st.mint.toBase58()}`
    );
    assert.ok(
      st.admin.equals(provider.wallet.publicKey),
      "admin mismatch"
    );
    assert.ok(
      st.distributor.equals(DISTRIBUTOR),
      `distributor mismatch: expected ${DISTRIBUTOR.toBase58()}, got ${st.distributor.toBase58()}`
    );
    assert.ok(
      st.totalSupply.eq(totalSupply),
      `total_supply mismatch: expected ${totalSupply.toString()}, got ${st.totalSupply.toString()}`
    );

    const onChainStartTs: number = st.startTs.toNumber();
    assert.ok(onChainStartTs > 0, "start_ts should be a positive unix timestamp");
    console.log(`  on-chain start_ts: ${onChainStartTs} (${new Date(onChainStartTs * 1000).toISOString()})`);

    assert.strictEqual(st.releasedSupply.toNumber(), 0, "released_supply should be 0");
    assert.strictEqual(st.recipientCount, 0, "recipient_count should be 0");
    assert.strictEqual(st.sealed, false, "sealed should be false");
    assert.strictEqual(st.paused, false, "paused should be false");
  });
});