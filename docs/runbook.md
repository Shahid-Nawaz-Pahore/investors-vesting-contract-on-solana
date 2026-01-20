# Vesting Runbook (Devnet/Mainnet)

## Prerequisites
- Solana CLI configured to the target cluster
- Anchor provider wallet set (admin for init/deposit/pause; distributor for release)
- `.env` file in `vesting/` with required variables

Required `.env` keys:
```
MINT=8SrFB8bhG65ii2iq3zs19EwmXWpja16vk1osyb2Lzsq1
DISTRIBUTOR=<DISTRIBUTOR_PUBKEY>
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
ANCHOR_WALLET=/path/to/admin.json   # admin for init/deposit/pause
```

Optional (used by some scripts):
```
ALLOCATION_CSV=/absolute/path/to/allocation.csv
NEW_DISTRIBUTOR=<NEW_DISTRIBUTOR_PUBKEY>
ACTION=pause|unpause
WALLET=<RECIPIENT_PUBKEY>
AMOUNT=<u64>
QUERY_ID=<u64>
```

## One-time setup
1) **Initialize schedule**
```
npx ts-node scripts/initialize_schedule.ts
```

2) **Create recipient ATAs**
```
npx ts-node scripts/create_recipient_atas.ts
```

3) **Add recipients + seal**
```
npx ts-node scripts/add_recipients.ts
```

5) **Deposit tokens into vault**
```
npx ts-node scripts/deposit_tokens.ts
```

## Monthly operations
Use the distributor wallet before running:
```
export ANCHOR_WALLET=/path/to/distributor.json
```

6) **Release monthly**
```
npx ts-node scripts/release_batch.ts
```

## Monitoring / Verification
7) **Verify on-chain totals**
```
npx ts-node scripts/verify_state.ts
```

8) **Emit vesting quote (single wallet)**
```
WALLET=<RECIPIENT_PUBKEY> npx ts-node scripts/emit_quote.ts
```

## Admin operations (optional)
9) **Rotate distributor**
```
NEW_DISTRIBUTOR=<NEW_PUBKEY> npx ts-node scripts/set_distributor.ts
```

10) **Pause or unpause**
```
ACTION=pause npx ts-node scripts/pause_unpause.ts
ACTION=unpause npx ts-node scripts/pause_unpause.ts
```

11) **Admin withdraw**
```
AMOUNT=<u64> QUERY_ID=<u64> npx ts-node scripts/admin_withdraw.ts
```

## Notes
- Release calls before `start_ts` will fail with `BeforeStart`.
- Missing ATAs will cause releases to fail.
- `release_batch` catches up if a month is missed (releases cumulative).

