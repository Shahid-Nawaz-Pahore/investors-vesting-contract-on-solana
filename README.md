# Commands

## Run tests (localnet)
```bash
cd vesting
anchor test
```

## Build
```bash
cd vesting
anchor build
```

## Deploy to devnet (PowerShell)
```powershell
solana config set --url https://api.devnet.solana.com
solana-keygen new -o C:\Users\premier\.config\solana\admin.json
solana config set --keypair C:\Users\premier\.config\solana\admin.json
solana airdrop 2

cd vesting
anchor deploy --provider.cluster https://api.devnet.solana.com
```

## Lock program upgradeability (devnet)
```powershell
solana program set-upgrade-authority <PROGRAM_ID> --final
```
