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

const MINT = new PublicKey("AD3yLbjtzi1UEuTooDMVc8aZga9YHi5BzTJpEJcEQtWp");

// ── PDA helpers ──────────────────────────────────────────────────────────────
function findScheduleStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("schedule_state")], programId);
}

function findVaultPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), scheduleState.toBuffer()],
    programId
  );
}

// ── Test Suite ───────────────────────────────────────────────────────────────
describe("deposit_tokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // Admin ka ATA — getAssociatedTokenAddressSync se derive hota hai (flow script wala tarika)
  const adminAta = getAssociatedTokenAddressSync(
    MINT,
    provider.wallet.publicKey,
    false,
    anchor.utils.token.TOKEN_PROGRAM_ID,
    anchor.utils.token.ASSOCIATED_PROGRAM_ID
  );

  // ── 1. Pre-conditions: schedule_state exists and is sealed ────────────────
  it("schedule_state exists and is sealed before deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.ok(st, "schedule_state not found — run initialize_schedule first");
    assert.strictEqual(st.sealed, true, "schedule must be sealed before deposit");
    console.log(`  total_supply: ${st.totalSupply.toString()}`);
  });

  // ── 2. Admin ATA exists and has enough balance ─────────────────────────────
  it("admin ATA exists and has sufficient balance for full deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;

    const ataInfo = await getAccount(
      provider.connection,
      adminAta,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );

    assert.ok(ataInfo, "Admin ATA not found");
    const ataBalance = new BN(ataInfo.amount.toString());
    assert.ok(
      ataBalance.gte(totalSupply),
      `Admin ATA balance ${ataBalance.toString()} is less than total_supply ${totalSupply.toString()}`
    );
    console.log(`  admin ATA balance: ${ataBalance.toString()}`);
    console.log(`  admin ATA: ${adminAta.toBase58()}`);
  });

  // ── 3. depositTokens tx succeeds (skip if vault already funded) ───────────
  it("depositTokens sends successfully and returns a signature", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;

    // Skip if vault already has the full amount
    const vaultInfo = await getAccount(
      provider.connection,
      vault,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());

    if (vaultBalance.eq(totalSupply)) {
      console.log("  vault already fully funded — skipping deposit tx");
      return;
    }

    const sig = await program.methods
      .depositTokens(totalSupply)
      .accounts({
        scheduleState,
        vault,
        adminTokenAccount: adminAta,
        admin: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    assert.ok(sig, "Expected a transaction signature");
    console.log(`  depositTokens tx: ${sig}`);
  });

  // ── 4. Vault balance equals total_supply after deposit ────────────────────
  it("vault balance equals total_supply after deposit", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const totalSupply: BN = st.totalSupply;

    const vaultInfo = await getAccount(
      provider.connection,
      vault,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());

    assert.ok(
      vaultBalance.eq(totalSupply),
      `vault balance ${vaultBalance.toString()} != total_supply ${totalSupply.toString()}`
    );
    console.log(`  vault balance: ${vaultBalance.toString()}`);
    console.log(`  vault: ${vault.toBase58()}`);
  });

  // ── 5. Vault mint matches schedule mint ───────────────────────────────────
  it("vault token account mint matches schedule mint", async () => {
    const vaultInfo = await getAccount(
      provider.connection,
      vault,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );

    assert.ok(
      vaultInfo.mint.equals(MINT),
      `vault mint mismatch: expected ${MINT.toBase58()}, got ${vaultInfo.mint.toBase58()}`
    );
  });
});