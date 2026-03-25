# Note:

To run tests via `anchor test`, follow these steps:

1. Create a new token.
2. Create admin ATA and mint 200 million supply to admin ATA.
3. Replace tokens address in the entire project.
4. Before running `anchor test`, set the timer in line 26.


# Commands

## Run tests (localnet)
```bash
anchor test
```

## Build
```bash
anchor build
```

## Deploy to devnet (PowerShell)
```powershell
solana config set --url https://api.devnet.solana.com
solana-keygen new -o 
solana config set --keypair 
solana airdrop 2

cd vesting
anchor deploy --provider.cluster https://api.devnet.solana.com
```

## Lock program upgradeability (devnet)
```powershell
solana program set-upgrade-authority <PROGRAM_ID> --final
```
