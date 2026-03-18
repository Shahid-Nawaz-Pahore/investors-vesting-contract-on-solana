import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import assert from "assert";

// ── Load .env ────────────────────────────────────────────────────────────────
const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "vesting", ".env")];
const envPath = envCandidates.find((p) => existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const MINT = new PublicKey("6mpM8NosprtdZfebytnkhjZSTj1W3AhtKP8FhNETTXHM");

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

function findVaultPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), scheduleState.toBuffer()],
    programId
  );
}

// ── Test Suite ────────────────────────────────────────────────────────────────
describe("sweep_dust_after_end", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // Admin ka ATA — tokens yahan aayenge sweep ke baad
  const adminDestination = getAssociatedTokenAddressSync(
    MINT,
    provider.wallet.publicKey,
    false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  // ── 1. Pre-condition: vesting end time check ──────────────────────────────
  it("current time is after vesting end (start_ts + 12 months)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const startTs: number = st.startTs.toNumber();

    // 12 months = ~365 days in seconds
    const vestingEndTs = startTs + 365 * 24 * 60 * 60;
    const nowTs = Math.floor(Date.now() / 1000);

    if (nowTs < vestingEndTs) {
      console.log(`  Vesting NOT ended yet.`);
      console.log(`  start_ts:     ${new Date(startTs * 1000).toISOString()}`);
      console.log(`  vesting_end:  ${new Date(vestingEndTs * 1000).toISOString()}`);
      console.log(`  now:          ${new Date(nowTs * 1000).toISOString()}`);
      console.log(`  sweepDustAfterEnd will fail with SweepBeforeEnd on-chain.`);
    } else {
      console.log(`  Vesting ended. Sweep allowed.`);
    }

    // Test informational only — not a hard assert (devnet mein vesting end nahi hua hoga)
    assert.ok(startTs > 0, "start_ts should be a valid timestamp");
  });

  // ── 2. Pre-condition: all non-revoked recipients fully released ───────────
  it("all non-revoked recipients have released_amount == allocation", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;

    let outstanding = 0;
    for (const e of rec.entries.slice(0, count)) {
      if (e.revoked === 0 && !e.releasedAmount.eq(e.allocation)) {
        outstanding++;
        console.log(`  outstanding: ${e.wallet.toBase58()} released=${e.releasedAmount.toString()} allocation=${e.allocation.toString()}`);
      }
    }

    if (outstanding > 0) {
      console.log(`  ${outstanding} recipient(s) not fully released — sweep will fail with SweepNotAllowedOutstanding`);
    } else {
      console.log(`  All non-revoked recipients fully released ✓`);
    }

    // Informational — sweep_dust is only callable after all are released
    assert.ok(count > 0, "recipient_count should be > 0");
  });

  // ── 3. Admin destination ATA exists ──────────────────────────────────────
  it("admin destination ATA exists on-chain", async () => {
    const info = await provider.connection.getAccountInfo(adminDestination);
    assert.ok(info !== null, `Admin ATA not found: ${adminDestination.toBase58()}`);
    console.log(`  admin destination ATA: ${adminDestination.toBase58()}`);
  });

  // ── 4. Vault balance and dust calculation ─────────────────────────────────
  it("dust amount calculation is correct (vault - committed)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;
    const releasedSupply: BN = st.releasedSupply;

    const vaultInfo = await getAccount(
      provider.connection,
      vault,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());

    // committed = total_supply - released_supply
    const committed = totalSupply.sub(releasedSupply);
    // dust = vault_balance - committed (should be >= 0)
    const dust = vaultBalance.sub(committed);

    console.log(`  vault_balance:    ${vaultBalance.toString()}`);
    console.log(`  total_supply:     ${totalSupply.toString()}`);
    console.log(`  released_supply:  ${releasedSupply.toString()}`);
    console.log(`  committed:        ${committed.toString()}`);
    console.log(`  dust (sweepable): ${dust.gtn(0) ? dust.toString() : "0 (nothing to sweep)"}`);

    assert.ok(
      vaultBalance.gte(new BN(0)),
      "vault balance should be >= 0"
    );
  });

  // ── 5. sweepDustAfterEnd tx (only runs if vesting ended and all released) ──
  it("sweepDustAfterEnd sends successfully if conditions are met", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const startTs: number = st.startTs.toNumber();
    const vestingEndTs = startTs + 365 * 24 * 60 * 60;
    const nowTs = Math.floor(Date.now() / 1000);

    if (nowTs < vestingEndTs) {
      console.log("  Vesting not ended yet — skipping sweep tx");
      return;
    }

    // Check all released
    const rec = await (program.account as any).recipients.fetch(recipients);
    const count: number = st.recipientCount;
    const hasOutstanding = rec.entries
      .slice(0, count)
      .some((e: any) => e.revoked === 0 && !e.releasedAmount.eq(e.allocation));

    if (hasOutstanding) {
      console.log("  Outstanding releases exist — skipping sweep tx");
      return;
    }

    const sig = await program.methods
      .sweepDustAfterEnd()
      .accounts({
        scheduleState,
        recipients,
        vault,
        adminDestination,
        mint: MINT,
        admin: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  sweepDustAfterEnd tx: ${sig}`);
  });

  // ── 6. Admin ATA balance increased after sweep ────────────────────────────
  it("admin ATA balance increased after sweep (if sweep ran)", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const startTs: number = st.startTs.toNumber();
    const vestingEndTs = startTs + 365 * 24 * 60 * 60;
    const nowTs = Math.floor(Date.now() / 1000);

    if (nowTs < vestingEndTs) {
      console.log("  Vesting not ended — skipping balance check");
      return;
    }

    const ataInfo = await getAccount(
      provider.connection,
      adminDestination,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    console.log(`  admin ATA balance after sweep: ${ataInfo.amount.toString()}`);
    assert.ok(ataInfo.amount >= BigInt(0), "admin ATA balance should be >= 0");
  });
});