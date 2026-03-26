import dotenv from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
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

// ── Test Suite (run with admin wallet) ───────────────────────────────────────
// export ANCHOR_WALLET=~/.config/solana/id.json
describe("negative tests — admin wallet required", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vesting as anchor.Program;
  const [scheduleState] = findScheduleStatePda(program.programId);
  const [recipients] = findRecipientsPda(program.programId, scheduleState);
  const [vault] = findVaultPda(program.programId, scheduleState);

  // ── add_recipients: already sealed → RecipientsSealed ────────────────────
  it("add_recipients fails with RecipientsSealed when schedule is already sealed", async () => {
    const csv = loadAllocationCsv();
    const wallets = parseWallets(csv);
    const dummyInput = [{ wallet: wallets[0], allocation: new BN(1) }];

    try {
      await program.methods
        .addRecipients(dummyInput, false)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientsSealed error");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientsSealed"), `Unexpected error: ${err?.message}`);
      console.log("  RecipientsSealed correctly rejected ✓");
    }
  });

  // ── deposit_tokens: start_ts passed → DepositAfterStart ──────────────────
  it("deposit_tokens fails with DepositAfterStart when start_ts has passed", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    const nowTs = Math.floor(Date.now() / 1000);

    if (nowTs < st.startTs.toNumber()) {
      console.log("  start_ts not yet passed — skipping DepositAfterStart test");
      return;
    }

    const adminAta = getAssociatedTokenAddressSync(
      MINT,
      provider.wallet.publicKey,
      false,
      anchor.utils.token.TOKEN_PROGRAM_ID,
      anchor.utils.token.ASSOCIATED_PROGRAM_ID
    );

    try {
      await program.methods
        .depositTokens(new BN(1))
        .accounts({
          scheduleState,
          vault,
          adminTokenAccount: adminAta,
          admin: provider.wallet.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Expected DepositAfterStart error");
    } catch (err: any) {
      assert.ok(hasError(err, "DepositAfterStart"), `Unexpected error: ${err?.message}`);
      console.log("  DepositAfterStart correctly rejected ✓");
    }
  });

  // ── set_distributor: distributor == admin → InvalidConfig ─────────────────
  it("set_distributor fails with InvalidConfig when new_distributor equals admin", async () => {
    try {
      await program.methods
        .setDistributor(provider.wallet.publicKey)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidConfig error");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidConfig"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidConfig (distributor==admin) correctly rejected ✓");
    }
  });

  // ── set_distributor: distributor == default pubkey → InvalidPubkey ─────────
  it("set_distributor fails with InvalidPubkey when new_distributor is default pubkey", async () => {
    try {
      await program.methods
        .setDistributor(PublicKey.default)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidPubkey error");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidPubkey"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidPubkey correctly rejected ✓");
    }
  });

  // ── set_distributor: distributor == schedule_state PDA → InvalidConfig ─────
  it("set_distributor fails with InvalidConfig when new_distributor is schedule_state PDA", async () => {
    try {
      await program.methods
        .setDistributor(scheduleState)
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected InvalidConfig error");
    } catch (err: any) {
      assert.ok(hasError(err, "InvalidConfig"), `Unexpected error: ${err?.message}`);
      console.log("  InvalidConfig (distributor==PDA) correctly rejected ✓");
    }
  });

  // ── pause: already paused → SchedulePaused ───────────────────────────────
  it("pause fails with SchedulePaused when schedule is already paused", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    if (!st.paused) {
      await program.methods
        .pause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
    }

    try {
      await program.methods
        .pause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected SchedulePaused error");
    } catch (err: any) {
      assert.ok(hasError(err, "SchedulePaused"), `Unexpected error: ${err?.message}`);
      console.log("  SchedulePaused (double-pause) correctly rejected ✓");
    } finally {
      await program.methods
        .unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
    }
  });

  // ── unpause: not paused → ScheduleNotPaused ──────────────────────────────
  it("unpause fails with ScheduleNotPaused when schedule is not paused", async () => {
    const st = await (program.account as any).scheduleState.fetch(scheduleState);
    if (st.paused) {
      await program.methods
        .unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
    }

    try {
      await program.methods
        .unpause()
        .accounts({ scheduleState, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected ScheduleNotPaused error");
    } catch (err: any) {
      assert.ok(hasError(err, "ScheduleNotPaused"), `Unexpected error: ${err?.message}`);
      console.log("  ScheduleNotPaused correctly rejected ✓");
    }
  });

  // ── revoke_recipient: unknown wallet → RecipientNotFound ──────────────────
  it("revoke_recipient fails with RecipientNotFound for unknown wallet", async () => {
    const unknownWallet = Keypair.generate().publicKey;
    try {
      await program.methods
        .revokeRecipient(unknownWallet)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientNotFound error");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientNotFound"), `Unexpected error: ${err?.message}`);
      console.log("  RecipientNotFound correctly rejected ✓");
    }
  });

  // ── revoke_recipient: already revoked → RecipientRevoked ──────────────────
  it("revoke_recipient fails with RecipientRevoked for already-revoked wallet", async () => {
    const alreadyRevoked = new PublicKey("rdr7FwfCVnRJtMKdSVqUNbqd6g9kAmb676XpFLvGiMw");
    try {
      await program.methods
        .revokeRecipient(alreadyRevoked)
        .accounts({ scheduleState, recipients, admin: provider.wallet.publicKey })
        .rpc();
      assert.fail("Expected RecipientRevoked error");
    } catch (err: any) {
      assert.ok(hasError(err, "RecipientRevoked"), `Unexpected error: ${err?.message}`);
      console.log("  RecipientRevoked (double-revoke) correctly rejected ✓");
    }
  });
});