import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  createMintToInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

function anchorErrorCode(e: any): string | undefined {
  // Anchor commonly throws either:
  // - { error: { errorCode: { code } } }
  // - AnchorError (with .error.errorCode.code)
  // - plain Error / SendTransactionError
  const direct =
    e?.error?.errorCode?.code ??
    e?.errorCode?.code ??
    (typeof e?.errorCode === "string" ? e.errorCode : undefined);
  if (direct) return direct;

  // SendTransactionError / simulation failures often include logs that contain:
  // "Error Code: <CodeName>"
  const logs: string[] | undefined =
    e?.logs ??
    e?.error?.logs ??
    e?.error?.errorLogs ??
    e?.transactionLogs ??
    e?.simulationResponse?.value?.logs ??
    e?.simulationResponse?.logs ??
    e?.data?.logs;

  if (Array.isArray(logs)) {
    const joined = logs.join("\n");
    const m = joined.match(/Error Code:\s*([A-Za-z0-9_]+)/);
    if (m?.[1]) return m[1];
  }

  // Last resort: sometimes error message string contains the same "Error Code:" fragment.
  const msg = String(e?.message ?? e ?? "");
  const m2 = msg.match(/Error Code:\s*([A-Za-z0-9_]+)/);
  if (m2?.[1]) return m2[1];

  return undefined;
}

/**
 * Assumptions / notes:
 * - This program has a single global schedule PDA (seed: `schedule_state`), so tests run through
 *   the full lifecycle in-order within one validator instance (we cannot re-initialize a second
 *   schedule in a later test without restarting the validator).
 * - "ATA missing" is enforced by the account type `Account<TokenAccount>` in `release_to_recipient`,
 *   so a missing ATA fails at the Anchor account deserialization layer (framework error), not via
 *   a custom program error code.
 * - The on-chain code rejects distributor = admin / schedule_state PDA / vault PDA / recipients PDA / program id.
 */

async function rpcRequest(connection: any, method: string, params: any[]) {
  const fn = connection?._rpcRequest ?? connection?.rpcRequest;
  if (!fn) throw new Error("Connection RPC request method not found");
  const res = await fn.call(connection, method, params);
  if (res?.error) {
    const err = new Error(`${method} failed: ${JSON.stringify(res.error)}`) as any;
    err.rpcError = res.error;
    throw err;
  }
  return res?.result;
}

async function warpSlot(connection: any, targetSlot: number) {
  // Solana local validator "warp slot" RPC method name differs across releases/builds.
  const methods = ["warp_slot", "warpSlot"];
  let lastErr: any = null;
  for (const m of methods) {
    try {
      await rpcRequest(connection, m, [targetSlot]);
      return;
    } catch (e: any) {
      lastErr = e;
      // Only continue on "method not found". Anything else should fail fast.
      const code = e?.rpcError?.code;
      if (code !== -32601) throw e;
    }
  }
  throw new Error(
    `Validator RPC does not support slot warping (tried: ${methods.join(
      ", "
    )}). ` +
      `Run tests on Anchor's local validator with warp support, or switch to a bankrun-based test harness.` +
      (lastErr ? ` Last error: ${String(lastErr?.message ?? lastErr)}` : "")
  );
}

async function currentUnixTs(connection: any): Promise<number> {
  // On some local validators, `getBlockTime` may return null for early slots.
  // We keep this deterministic by polling with a bounded timeout (no dependency on warp RPC).
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const slot = await connection.getSlot();
    const bt = await connection.getBlockTime(slot);
    if (typeof bt === "number") return bt;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Unable to read current block time (getBlockTime kept returning null)");
}

async function hasWarpSupport(connection: any): Promise<boolean> {
  try {
    const slot = await connection.getSlot();
    await warpSlot(connection, slot + 1);
    return true;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("does not support slot warping")) return false;
    // If it failed for some other reason (RPC error), surface it.
    if (msg.includes("Method not found")) return false;
    throw e;
  }
}

async function warpToUnixTs(connection: any, targetTs: number) {
  // Warp slots until the validator's Clock unix_timestamp is >= targetTs.
  // Uses an approximate 400ms slot time; we correct via re-checking actual blocktime.
  for (let i = 0; i < 60; i++) {
    const slot = await connection.getSlot();
    const nowTs = await currentUnixTs(connection);
    if (nowTs >= targetTs) return;

    const deltaSeconds = targetTs - nowTs;
    const deltaSlots = Math.max(1, Math.ceil(deltaSeconds / 0.4));
    const targetSlot = slot + Math.min(deltaSlots, 200_000);
    await warpSlot(connection, targetSlot);
  }
  throw new Error(`warpToUnixTs timeout (targetTs=${targetTs})`);
}

async function waitUntilUnixTs(connection: any, targetTs: number, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const now = await currentUnixTs(connection);
    if (now >= targetTs) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for unix time >= ${targetTs}`);
}

function daysInMonthUtc(year: number, month1: number): number {
  // month1: 1-12
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function addMonthsClampedUtc(start: Date, monthsToAdd: number): Date {
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth(); // 0-11
  const d0 = start.getUTCDate();
  const sod =
    start.getUTCHours() * 3600 + start.getUTCMinutes() * 60 + start.getUTCSeconds();

  const base = y0 * 12 + m0;
  const next = base + monthsToAdd;
  const y = Math.floor(next / 12);
  const m0n = next % 12;
  const month1 = m0n + 1;

  const dim = daysInMonthUtc(y, month1);
  const d = Math.min(d0, dim);

  const hh = Math.floor(sod / 3600);
  const mm = Math.floor((sod % 3600) / 60);
  const ss = sod % 60;
  return new Date(Date.UTC(y, m0n, d, hh, mm, ss));
}

function nextUtc31stMidnight(afterTs: number): Date {
  // Find the next month (including current) that has a 31st, and return YYYY-MM-31 00:00:00 UTC.
  const after = new Date(afterTs * 1000);
  let y = after.getUTCFullYear();
  let m0 = after.getUTCMonth(); // 0-11

  for (let i = 0; i < 36; i++) {
    const y2 = y + Math.floor((m0 + i) / 12);
    const m02 = (m0 + i) % 12;
    const month1 = m02 + 1;
    if (daysInMonthUtc(y2, month1) === 31) {
      const d = new Date(Date.UTC(y2, m02, 31, 0, 0, 0));
      if (Math.floor(d.getTime() / 1000) > afterTs) return d;
    }
  }
  throw new Error("Unable to find next 31st within 36 months");
}

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
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), scheduleState.toBuffer()], programId);
}

describe("vesting (spec-authoritative)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Avoid importing `../target/types/vesting` so tests can compile even before `anchor build`
  // generates IDL/types into `target/`.
  // Cast to `any` to avoid very deep generic inference in Anchor TS types.
  const program = anchor.workspace.vesting as any;
  const connection = provider.connection;

  const DECIMALS = 6;

  let admin: Keypair;
  let distributor: Keypair;
  let mintAuthority: Keypair;
  let mintKp: Keypair;

  let scheduleState: PublicKey;
  let recipientsPda: PublicKey;
  let vaultPda: PublicKey;

  let adminMintAta: PublicKey;

  // small set for tests (batch cap is 5)
  let r1: Keypair;
  let r2: Keypair;
  let r3: Keypair;
  let r4: Keypair;
  let r5: Keypair;
  let r6: Keypair;
  let dummyAtas: PublicKey[];

  const totalSupply = new BN(200_000_000_000_000); // 200M * 10^6
  const DUMMY_COUNT_FOR_MAX_RECIPIENTS_TEST = 29; // 3 initial + 3 real + 29 dummy = 35

  // allocations sum to totalSupply
  const allocs = ((): BN[] => {
    const a1 = new BN(10_000_000_000_000);
    const a2 = new BN(10_000_000_000_000);
    const a3 = new BN(10_000_000_000_000);
    const a4 = new BN(10_000_000_000_000);
    const a5 = new BN(10_000_000_000_000);
    const sum5 = a1.add(a2).add(a3).add(a4).add(a5);
    const a6 = totalSupply.sub(sum5).sub(new BN(DUMMY_COUNT_FOR_MAX_RECIPIENTS_TEST));
    return [a1, a2, a3, a4, a5, a6];
  })();

  before(async () => {
    admin = Keypair.generate();
    distributor = Keypair.generate();
    mintAuthority = Keypair.generate();
    mintKp = Keypair.generate();

    r1 = Keypair.generate();
    r2 = Keypair.generate();
    r3 = Keypair.generate();
    r4 = Keypair.generate();
    r5 = Keypair.generate();
    r6 = Keypair.generate();

    // fund signers
    const lamports = 5 * anchor.web3.LAMPORTS_PER_SOL;
    for (const kp of [admin, distributor, mintAuthority, r1, r2, r3, r4, r5, r6]) {
      const sig = await connection.requestAirdrop(kp.publicKey, lamports);
      await connection.confirmTransaction(sig);
    }

    // derive PDAs
    [scheduleState] = findScheduleStatePda(program.programId);
    [recipientsPda] = findRecipientsPda(program.programId, scheduleState);
    [vaultPda] = findVaultPda(program.programId, scheduleState);

    // create mint
    const mintRent = await getMinimumBalanceForRentExemptMint(connection);
    const createMintTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: mintAuthority.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports: mintRent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKp.publicKey, DECIMALS, mintAuthority.publicKey, null)
    );
    await provider.sendAndConfirm(createMintTx, [mintAuthority, mintKp]);

    // admin ATA for minting and deposit
    adminMintAta = getAssociatedTokenAddressSync(mintKp.publicKey, admin.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const createAdminAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        adminMintAta,
        admin.publicKey,
        mintKp.publicKey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createAdminAtaTx, [admin]);

    // mint supply to admin
    const mintToTx = new anchor.web3.Transaction().add(
      createMintToInstruction(mintKp.publicKey, adminMintAta, mintAuthority.publicKey, BigInt(totalSupply.toString()))
    );
    await provider.sendAndConfirm(mintToTx, [mintAuthority]);
  });

  it("calendar month math parity (off-chain) - clamp + leap year + inclusivity", async () => {
    // These are pure parity tests for the same rule as on-chain `utils/time.rs`:
    // boundary_k = start + k months, day clamped; inclusive boundary.
    const start = new Date(Date.UTC(2024, 0, 31, 0, 0, 0)); // 2024-01-31 (leap year)
    const b1 = addMonthsClampedUtc(start, 1);
    expect(b1.toISOString()).to.equal("2024-02-29T00:00:00.000Z");
    const b2 = addMonthsClampedUtc(start, 2);
    expect(b2.toISOString()).to.equal("2024-03-31T00:00:00.000Z");

    const nonLeap = new Date(Date.UTC(2023, 0, 31, 0, 0, 0)); // 2023-01-31
    const feb = addMonthsClampedUtc(nonLeap, 1);
    expect(feb.toISOString()).to.equal("2023-02-28T00:00:00.000Z");

    // Inclusivity check: now == boundary is eligible (conceptual parity; on-chain is unit-tested).
    expect(b1.getTime()).to.equal(new Date(Date.UTC(2024, 1, 29, 0, 0, 0)).getTime());
  });

  it("initialize_schedule validation matrix", async () => {
    const nowTs = await currentUnixTs(connection);
    const startTsOk = new BN(nowTs + 60);

    // total_supply > 0
    try {
      await program.methods
        .initializeSchedule(distributor.publicKey, startTsOk, new BN(0))
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // start_ts > 0
    try {
      await program.methods
        .initializeSchedule(distributor.publicKey, new BN(0), totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidTimestamp");
    }

    // distributor != default pubkey
    try {
      await program.methods
        .initializeSchedule(SystemProgram.programId, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidPubkey");
    }

    // admin != distributor
    try {
      await program.methods
        .initializeSchedule(admin.publicKey, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // distributor not schedule_state PDA
    try {
      await program.methods
        .initializeSchedule(scheduleState, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // distributor not vault PDA (non-signable)
    try {
      await program.methods
        .initializeSchedule(vaultPda, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // distributor not recipients PDA (non-signable)
    try {
      await program.methods
        .initializeSchedule(recipientsPda, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // distributor not program id
    try {
      await program.methods
        .initializeSchedule(program.programId, startTsOk, totalSupply)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }
  });

  it("spec matrix (single schedule lifecycle)", async function () {
    const nowTs = await currentUnixTs(connection);
    const warpSupported = await hasWarpSupport(connection);

    // We keep the schedule start close to "now" so tests run fast on validators without warp.
    // Month-boundary and 12-month end-to-end tests require warp; see conditional section below.
    const startTsNum = nowTs + 12;
    const startTs = new BN(startTsNum);

    // init
    await program.methods
      .initializeSchedule(distributor.publicKey, startTs, totalSupply)
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        vault: vaultPda,
        mint: mintKp.publicKey,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // RecipientsNotSealed: release/batch must fail before sealing (even if other accounts are valid).
    {
      // `recipient_ata` is an Account<TokenAccount>, so it must exist; use adminMintAta.
      try {
        await program.methods
          .releaseToRecipient(r1.publicKey)
          .accounts({
            scheduleState,
            recipients: recipientsPda,
            vault: vaultPda,
            recipientAta: adminMintAta,
            mint: mintKp.publicKey,
            distributor: distributor.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([distributor])
          .rpc();
        expect.fail("should have failed");
      } catch (e: any) {
        expect(anchorErrorCode(e)).to.equal("RecipientsNotSealed");
      }

      try {
        await program.methods
          .batchRelease([r1.publicKey])
          .accounts({
            scheduleState,
            recipients: recipientsPda,
            vault: vaultPda,
            distributor: distributor.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([distributor])
          .rpc();
        expect.fail("should have failed");
      } catch (e: any) {
        expect(anchorErrorCode(e)).to.equal("RecipientsNotSealed");
      }
    }

    // add recipients: invalid allocation rejected
    try {
      await program.methods
        .addRecipients([{ wallet: r1.publicKey, allocation: new BN(0) }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidAllocation");
    }

    // access control: add_recipients is admin-only
    try {
      await program.methods
        .addRecipients([{ wallet: r1.publicKey, allocation: allocs[0] }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: distributor.publicKey })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("UnauthorizedAdmin");
    }

    // add recipients: duplicate within batch rejected
    try {
      await program.methods
        .addRecipients(
          [
            { wallet: r1.publicKey, allocation: allocs[0] },
            { wallet: r1.publicKey, allocation: allocs[0] },
          ],
          false
        )
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("DuplicateRecipient");
    }

    // add first batch (no seal); partial sums allowed
    await program.methods
      .addRecipients(
        [
          { wallet: r1.publicKey, allocation: allocs[0] },
          { wallet: r2.publicKey, allocation: allocs[1] },
          { wallet: r3.publicKey, allocation: allocs[2] },
        ],
        false
      )
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    // add recipients: sum cannot exceed total_supply at any point
    try {
      await program.methods
        .addRecipients([{ wallet: Keypair.generate().publicKey, allocation: totalSupply }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("AllocationSumExceedsTotalSupply");
    }

    try {
      await program.methods
        .addRecipients([{ wallet: r1.publicKey, allocation: allocs[0] }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("DuplicateRecipient");
    }

    // attempt seal early (sum mismatch)
    try {
      await program.methods
        .addRecipients([], true)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("AllocationSumMismatchAtSeal");
    }

    // Fill recipients up to 35 total, then verify 36th is rejected (RecipientListFull).
    const dummyWallets: PublicKey[] = [];
    for (let i = 0; i < DUMMY_COUNT_FOR_MAX_RECIPIENTS_TEST; i++) {
      dummyWallets.push(Keypair.generate().publicKey);
    }

    const remainingInputs = [
      { wallet: r4.publicKey, allocation: allocs[3] },
      { wallet: r5.publicKey, allocation: allocs[4] },
      { wallet: r6.publicKey, allocation: allocs[5] },
      ...dummyWallets.map((w) => ({ wallet: w, allocation: new BN(1) })),
    ];

    // Add in chunks to keep tx size reasonable.
    for (let i = 0; i < remainingInputs.length; i += 10) {
      await program.methods
        .addRecipients(remainingInputs.slice(i, i + 10), false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
    }

    // 36th should fail (list full, not sealed yet).
    try {
      await program.methods
        .addRecipients([{ wallet: Keypair.generate().publicKey, allocation: new BN(1) }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("RecipientListFull");
    }

    // Seal now that allocation sum matches total_supply.
    await program.methods
      .addRecipients([], true)
      .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    // sealed prevents further adds
    try {
      await program.methods
        .addRecipients([{ wallet: Keypair.generate().publicKey, allocation: new BN(1) }], false)
        .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("RecipientsSealed");
    }

    // set_distributor rejects vault PDA / recipients PDA
    try {
      await program.methods
        .setDistributor(vaultPda)
        .accounts({ scheduleState, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }
    try {
      await program.methods
        .setDistributor(recipientsPda)
        .accounts({ scheduleState, admin: admin.publicKey })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidConfig");
    }

    // deposit: wrong mint token account rejected
    {
      // Create a second mint + admin ATA (minimal) to ensure `admin_token_account.mint` mismatch.
      const mint2Authority = Keypair.generate();
      const mint2 = Keypair.generate();
      const sig = await connection.requestAirdrop(mint2Authority.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);

      const mintRent = await getMinimumBalanceForRentExemptMint(connection);
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: mint2Authority.publicKey,
          newAccountPubkey: mint2.publicKey,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint2.publicKey, DECIMALS, mint2Authority.publicKey, null)
      );
      await provider.sendAndConfirm(tx, [mint2Authority, mint2]);

      const adminAta2 = getAssociatedTokenAddressSync(
        mint2.publicKey,
        admin.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const createAta2 = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          adminAta2,
          admin.publicKey,
          mint2.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAta2, [admin]);

      try {
        await program.methods
          .depositTokens(new BN(1))
          .accounts({
            scheduleState,
            vault: vaultPda,
            adminTokenAccount: adminAta2,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([admin])
          .rpc();
        expect.fail("should have failed");
      } catch (e: any) {
        expect(anchorErrorCode(e)).to.equal("InvalidTokenMint");
      }
    }

    // access control: deposit_tokens is admin-only
    try {
      await program.methods
        .depositTokens(new BN(1))
        .accounts({
          scheduleState,
          vault: vaultPda,
          adminTokenAccount: adminMintAta,
          admin: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("UnauthorizedAdmin");
    }

    // deposit: over-deposit should fail
    try {
      await program.methods
        .depositTokens(totalSupply.add(new BN(1)))
        .accounts({
          scheduleState,
          vault: vaultPda,
          adminTokenAccount: adminMintAta,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("OverDeposit");
    }

    // deposit partial (allowed pre-start) to exercise VaultNotExactlyFunded guard after start.
    await program.methods
      .depositTokens(totalSupply.sub(new BN(1)))
      .accounts({
        scheduleState,
        vault: vaultPda,
        adminTokenAccount: adminMintAta,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // create recipient ATAs (policy: must pre-exist)
    const recipients = [r1, r2, r3, r4, r5, r6];
    const atas = recipients.map((kp) =>
      getAssociatedTokenAddressSync(mintKp.publicKey, kp.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    );
    const createAtasTx = new anchor.web3.Transaction();
    for (let i = 0; i < recipients.length; i++) {
      createAtasTx.add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          atas[i],
          recipients[i].publicKey,
          mintKp.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    await provider.sendAndConfirm(createAtasTx, [admin]);

    // release before start => BeforeStart (even though partially funded)
    try {
      await program.methods
        .releaseToRecipient(r1.publicKey)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          recipientAta: atas[0],
          mint: mintKp.publicKey,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("BeforeStart");
    }

    // Advance to start (immediate unlock at boundary is eligible).
    if (warpSupported) {
      await warpToUnixTs(connection, startTsNum);
    } else {
      await waitUntilUnixTs(connection, startTsNum, 30_000);
    }

    // First release after start must reject if vault not exactly funded when released_supply == 0.
    try {
      await program.methods
        .releaseToRecipient(r1.publicKey)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          recipientAta: atas[0],
          mint: mintKp.publicKey,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("VaultNotExactlyFunded");
    }

    // Top-up the missing 1 unit via a direct SPL transfer (destination does not require PDA authority).
    // This is only for testing the guard without getting stuck (deposit_tokens is forbidden after start).
    {
      const topUpIx = createTransferInstruction(
        adminMintAta,
        vaultPda,
        admin.publicKey,
        BigInt(1),
        [],
        TOKEN_PROGRAM_ID
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(topUpIx), [admin]);
    }

    // deposit after start must fail
    try {
      await program.methods
        .depositTokens(new BN(1))
        .accounts({
          scheduleState,
          vault: vaultPda,
          adminTokenAccount: adminMintAta,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("DepositAfterStart");
    }

    // release_to_recipient: wrong ATA rejected (must be canonical ATA)
    try {
      await program.methods
        .releaseToRecipient(r2.publicKey)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          recipientAta: adminMintAta, // wrong (exists, same mint)
          mint: mintKp.publicKey,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidRecipientAta");
    }

    // release_to_recipient: ATA missing (framework-level failure)
    // Use a dummy recipient that is in the on-chain list but whose ATA was never created.
    {
      const missingOwner = dummyWallets[0];
      const missingAta = getAssociatedTokenAddressSync(
        mintKp.publicKey,
        missingOwner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      try {
        await program.methods
          .releaseToRecipient(missingOwner)
          .accounts({
            scheduleState,
            recipients: recipientsPda,
            vault: vaultPda,
            recipientAta: missingAta, // does not exist on-chain
            mint: mintKp.publicKey,
            distributor: distributor.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([distributor])
          .rpc();
        expect.fail("should have failed");
    } catch (e: any) {
      // Anchor framework error (account missing/uninitialized) can vary by release.
      const code = anchorErrorCode(e);
      if (code) {
        expect(["AccountNotInitialized", "AccountNotFound"].includes(code)).to.equal(true);
      } else {
        const msg = String(e?.message ?? e);
        expect(msg).to.match(/AccountNotInitialized|AccountNotFound|account.*not.*initialized|could not find account/i);
      }
    }

    // create ATAs for dummy wallets in manageable batches so all recipients can be paid
    dummyAtas = [];
    for (let i = 0; i < dummyWallets.length; i += 8) {
      const tx = new anchor.web3.Transaction();
      for (let j = i; j < Math.min(i + 8, dummyWallets.length); j++) {
        const owner = dummyWallets[j];
        const ata = getAssociatedTokenAddressSync(
          mintKp.publicKey,
          owner,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        dummyAtas.push(ata);
        tx.add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,
            ata,
            owner,
            mintKp.publicKey,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      await provider.sendAndConfirm(tx, [admin]);
    }
    }

    // access control: release_to_recipient is distributor-only
    try {
      await program.methods
        .releaseToRecipient(r2.publicKey)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          recipientAta: atas[1],
          mint: mintKp.publicKey,
          distributor: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("UnauthorizedDistributor");
    }

    // single release: should transfer monthly amount (floor allocation/12)
    const before1 = await getAccount(connection, atas[0]);
    await program.methods
      .releaseToRecipient(r1.publicKey)
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        vault: vaultPda,
        recipientAta: atas[0],
        mint: mintKp.publicKey,
        distributor: distributor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([distributor])
      .rpc();
    const after1 = await getAccount(connection, atas[0]);
    const expectedMonthly = BigInt(allocs[0].div(new BN(12)).toString());
    expect(after1.amount - before1.amount).to.equal(expectedMonthly);

    // idempotency: re-call should no-op
    const beforeAgain = await getAccount(connection, atas[0]);
    await program.methods
      .releaseToRecipient(r1.publicKey)
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        vault: vaultPda,
        recipientAta: atas[0],
        mint: mintKp.publicKey,
        distributor: distributor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([distributor])
      .rpc();
    const afterAgain = await getAccount(connection, atas[0]);
    expect(afterAgain.amount - beforeAgain.amount).to.equal(BigInt(0));

    // pause blocks release (accrual continues)
    await program.methods
      .pause()
      .accounts({ scheduleState, admin: admin.publicKey })
      .signers([admin])
      .rpc();
    try {
      await program.methods
        .releaseToRecipient(r2.publicKey)
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          recipientAta: atas[1],
          mint: mintKp.publicKey,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("SchedulePaused");
    }

    // unpause enables catch-up releases
    await program.methods
      .unpause()
      .accounts({ scheduleState, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    // After unpause, release should succeed (month_index >= 1). We assert at least one tranche.
    const before3m = await getAccount(connection, atas[2]);
    await program.methods
      .releaseToRecipient(r3.publicKey)
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        vault: vaultPda,
        recipientAta: atas[2],
        mint: mintKp.publicKey,
        distributor: distributor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([distributor])
      .rpc();
    const after3m = await getAccount(connection, atas[2]);
    expect(after3m.amount > before3m.amount).to.equal(true);

    // batch size > 5 rejected
    try {
      await program.methods
        .batchRelease([r1.publicKey, r2.publicKey, r3.publicKey, r4.publicKey, r5.publicKey, r6.publicKey])
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(atas.map((a) => ({ pubkey: a, isSigner: false, isWritable: true })))
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("BatchTooLarge");
    }

    // atomic batch failure: pass one wrong ATA (use admin ATA instead of r3 ATA)
    const before2 = await getAccount(connection, atas[1]);
    const before3 = await getAccount(connection, atas[2]);
    try {
      await program.methods
        .batchRelease([r2.publicKey, r3.publicKey])
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: atas[1], isSigner: false, isWritable: true },
          { pubkey: adminMintAta, isSigner: false, isWritable: true }, // wrong
        ])
        .signers([distributor])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("InvalidRecipientAta");
    }
    const after2 = await getAccount(connection, atas[1]);
    const after3 = await getAccount(connection, atas[2]);
    expect(after2.amount - before2.amount).to.equal(BigInt(0));
    expect(after3.amount - before3.amount).to.equal(BigInt(0));

    // valid batch works (r2 + r5)
    {
      const beforeR2 = await getAccount(connection, atas[1]);
      const beforeR5 = await getAccount(connection, atas[4]);
      await program.methods
        .batchRelease([r2.publicKey, r5.publicKey])
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          distributor: distributor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: atas[1], isSigner: false, isWritable: true },
          { pubkey: atas[4], isSigner: false, isWritable: true },
        ])
        .signers([distributor])
        .rpc();
      const afterR2 = await getAccount(connection, atas[1]);
      const afterR5 = await getAccount(connection, atas[4]);
      // At/after start, r2 and r5 should receive at least one tranche.
      expect(afterR2.amount > beforeR2.amount).to.equal(true);
      expect(afterR5.amount > beforeR5.amount).to.equal(true);
    }

    // revoke one small dummy recipient: releases become no-op
    const revokedWallet = dummyWallets[0];
    const revokedAta = dummyAtas[0];
    await program.methods
      .revokeRecipient(revokedWallet)
      .accounts({ scheduleState, recipients: recipientsPda, admin: admin.publicKey })
      .signers([admin])
      .rpc();
    // create a tiny release attempt (will be no-op)
    await program.methods
      .releaseToRecipient(revokedWallet)
      .accounts({
        scheduleState,
        recipients: recipientsPda,
        vault: vaultPda,
        recipientAta: revokedAta,
        mint: mintKp.publicKey,
        distributor: distributor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([distributor])
      .rpc();
    const revokedAccount = await getAccount(connection, revokedAta);
    expect(revokedAccount.amount).to.equal(BigInt(0));

    // emit quote: should not mutate state (we just ensure tx succeeds)
    // Ensure no state mutation: compare serialized account buffers.
    const recipientsBefore = await connection.getAccountInfo(recipientsPda);
    expect(recipientsBefore).to.not.equal(null);
    await program.methods
      .emitVestingQuote(r2.publicKey)
      .accounts({ scheduleState, recipients: recipientsPda })
      .rpc();
    const recipientsAfter = await connection.getAccountInfo(recipientsPda);
    expect(recipientsAfter).to.not.equal(null);
    expect(recipientsAfter!.data.equals(recipientsBefore!.data)).to.equal(true);

    // Full 12-period release with warp (only if validator supports warp)
    if (warpSupported) {
      const startDate = new Date(startTsNum * 1000);
      const allRecipients = [
        { wallet: r1.publicKey, ata: atas[0] },
        { wallet: r2.publicKey, ata: atas[1] },
        { wallet: r3.publicKey, ata: atas[2] },
        { wallet: r4.publicKey, ata: atas[3] },
        { wallet: r5.publicKey, ata: atas[4] },
        { wallet: r6.publicKey, ata: atas[5] },
        ...dummyWallets.map((w, i) => ({ wallet: w, ata: dummyAtas[i] })),
      ].filter((p) => !p.wallet.equals(revokedWallet));

      for (let k = 0; k < 12; k++) {
        const boundary = Math.floor(addMonthsClampedUtc(startDate, k).getTime() / 1000);
        await warpToUnixTs(connection, boundary);

        for (let i = 0; i < allRecipients.length; i += 5) {
          const slice = allRecipients.slice(i, i + 5);
          await program.methods
            .batchRelease(slice.map((s) => s.wallet))
            .accounts({
              scheduleState,
              recipients: recipientsPda,
              vault: vaultPda,
              distributor: distributor.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .remainingAccounts(slice.map((s) => ({ pubkey: s.ata, isSigner: false, isWritable: true })))
            .signers([distributor])
            .rpc();
        }
      }

      // Verify all non-revoked recipients are fully released and vault holds only revoked allocation.
      const rec = await program.account.recipients.fetch(recipientsPda);
      let outstanding = BigInt(0);
      for (const e of rec.entries as any[]) {
        if (new PublicKey(e.wallet).equals(revokedWallet)) {
          outstanding += BigInt(e.allocation.toString());
          expect(e.releasedAmount.toString()).to.equal("0");
        } else {
          expect(e.releasedAmount.toString()).to.equal(e.allocation.toString());
        }
      }

      const vaultState = await getAccount(connection, vaultPda);
      expect(vaultState.amount).to.equal(outstanding);
    }

    // sweep before end must fail
    try {
      await program.methods
        .sweepDustAfterEnd()
        .accounts({
          scheduleState,
          recipients: recipientsPda,
          vault: vaultPda,
          adminDestination: adminMintAta,
          mint: mintKp.publicKey,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      expect.fail("should have failed");
    } catch (e: any) {
      expect(anchorErrorCode(e)).to.equal("SweepBeforeEnd");
    }

    // NOTE: Full end-to-end "after 12 calendar months" scenarios (sweep-after-end success, exact
    // month boundary +/−1s, etc.) require a warp-capable validator or a bankrun/program-test harness.
    // Your validator RPC does not support warping, so those long-horizon cases are covered by:
    // - Rust unit tests in `programs/vesting/src/utils/time.rs` (authoritative month math)
    // - Off-chain parity tests in this file (see `calendar month math parity` test)
  });
});


