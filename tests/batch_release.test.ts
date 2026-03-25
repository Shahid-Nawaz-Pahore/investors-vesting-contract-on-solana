import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
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
const DISTRIBUTOR = new PublicKey("7iJdaPKi5y8r8rVeVNrGWrNMq177m2kUzvUnv8KcZSvC");
const BATCH_SIZE = 5;

// ── CSV helpers (same as flow script) ────────────────────────────────────────
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

function findVaultPda(programId: PublicKey, scheduleState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), scheduleState.toBuffer()],
    programId
  );
}

// ── Test Suite ────────────────────────────────────────────────────────────────
describe("batch_release", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;

  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // ── 1. Pre-condition: distributor wallet match ────────────────────────────
  it("ANCHOR_WALLET matches DISTRIBUTOR from .env", () => {
    assert.ok(
      provider.wallet.publicKey.equals(DISTRIBUTOR),
      `ANCHOR_WALLET must be the distributor.\nExpected: ${DISTRIBUTOR.toBase58()}\nGot:      ${provider.wallet.publicKey.toBase58()}`
    );
  });

  // ── 2. Pre-condition: schedule is sealed and not paused ───────────────────
  it("schedule_state is sealed and not paused before batch_release", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    assert.strictEqual(st.sealed, true, "schedule must be sealed");
    assert.strictEqual(st.paused, false, "schedule must not be paused");
    assert.ok(
      st.distributor.equals(DISTRIBUTOR),
      `on-chain distributor mismatch: ${st.distributor.toBase58()}`
    );
    console.log(`  released_supply before: ${st.releasedSupply.toString()}`);
  });

  // ── 3. Pre-condition: vault is fully funded ───────────────────────────────
  it("vault is fully funded before batch_release", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const vaultInfo = await getAccount(
      provider.connection,
      vault,
      "confirmed",
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
    const vaultBalance = new BN(vaultInfo.amount.toString());
    const totalSupply: BN = st.totalSupply;

    assert.ok(
      vaultBalance.eq(totalSupply),
      `vault not fully funded: balance ${vaultBalance.toString()} != total_supply ${totalSupply.toString()}`
    );
    console.log(`  vault balance: ${vaultBalance.toString()}`);
  });

  // ── 4. All recipient ATAs exist on-chain ──────────────────────────────────
  it("all recipient ATAs exist on-chain", async () => {
    const csv = loadAllocationCsv();
    const wallets = parseWallets(csv);

    let missing = 0;
    for (const wallet of wallets) {
      const ata = getAssociatedTokenAddressSync(
        MINT,
        wallet,
        false,
        anchor.utils.token.TOKEN_PROGRAM_ID,
        anchor.utils.token.ASSOCIATED_PROGRAM_ID
      );
      const info = await provider.connection.getAccountInfo(ata);
      if (info === null) {
        console.log(`  MISSING ATA for wallet: ${wallet.toBase58()}`);
        missing++;
      }
    }
    assert.strictEqual(missing, 0, `${missing} recipient ATA(s) missing on-chain`);
    console.log(`  All ${wallets.length} ATAs exist`);
  });

  // ── 5. batch_release batches succeed ─────────────────────────────────────
  it("batch_release sends all batches successfully", async () => {
    const csv = loadAllocationCsv();
    const wallets = parseWallets(csv);

    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      const slice = wallets.slice(i, i + BATCH_SIZE);
      const atas = slice.map((w) =>
        getAssociatedTokenAddressSync(
          MINT,
          w,
          false,
          anchor.utils.token.TOKEN_PROGRAM_ID,
          anchor.utils.token.ASSOCIATED_PROGRAM_ID
        )
      );

      const sig = await program.methods
        .batchRelease(slice)
        .accounts({
          scheduleState,
          recipients,
          vault,
          distributor: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(
          atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true }))
        )
        .rpc();

      assert.ok(sig, `Expected signature for batch ${i + 1}–${i + slice.length}`);
      console.log(`  batch [${i + 1}–${i + slice.length}] tx: ${sig}`);
    }
  });

  // ── 6. released_supply increased after all batches ────────────────────────
  it("released_supply increased after all batch_release calls", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const releasedSupply: BN = st.releasedSupply;

    assert.ok(
      releasedSupply.gtn(0),
      `released_supply should be > 0 after batch_release, got ${releasedSupply.toString()}`
    );
    console.log(`  released_supply after: ${releasedSupply.toString()}`);
  });

  // ── 7. Vault balance decreased after releases ─────────────────────────────
  it("vault balance decreased after batch_release", async () => {
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
    const expectedVault = totalSupply.sub(releasedSupply);

    assert.ok(
      vaultBalance.eq(expectedVault),
      `vault balance mismatch: expected ${expectedVault.toString()}, got ${vaultBalance.toString()}`
    );
    console.log(`  vault balance after: ${vaultBalance.toString()}`);
    console.log(`  total_supply:        ${totalSupply.toString()}`);
    console.log(`  released_supply:     ${releasedSupply.toString()}`);
  });
});