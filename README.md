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
