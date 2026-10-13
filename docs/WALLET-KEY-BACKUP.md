# Wallet key backup (beginner guide)

Payrail signs transactions with one wallet. If you lose its key you lose that wallet, its ERC-8004 agent
identity and its tagged history, and you cannot continue under the same address. A backup is therefore
not optional. This guide shows how to make one **without ever putting the key in the project, Git, OneDrive,
logs or chat**.

## 1. How Payrail finds the key

- The key is the value `PAYRAIL_PRIVATE_KEY` inside a small text file that is **outside the project**.
  The default location on this machine is `C:\Users\<you>\.payrail\rehearsal.env`.
- Commands that must sign load that file explicitly:
  `node --env-file=C:\Users\<you>\.payrail\rehearsal.env scripts/order.ts --service <id> --execute`
- Commands that only read (plans, balances, evidence) use the project's `.env`, which holds only your
  **public** address and never a key.
- If a key is loaded, the wallet address is **derived from the key**, and the app refuses to run if it
  differs from `PAYRAIL_WALLET_ADDRESS`.

## 2. What is already protected (checked)

- The key file is **not inside the project folder** and **not inside OneDrive**.
- Only your Windows account has permission to it.
- `.gitignore` excludes `.env`, `*.env`, `.payrail/`, key/keystore/PEM files and `receipts/`.
- A scan of every file in the project (including ignored folders) found **no copy of the key**.

## 3. How to make a backup (you do this; Payrail and the assistant never copy the key)

Pick **one primary** and, ideally, **one secondary** from different places:

| Option | How | Notes |
|---|---|---|
| Password manager (recommended) | Create a *Secure Note* titled "Payrail wallet key" and paste the single line from the key file | Use a trusted manager with a strong master password and 2-factor sign-in |
| Encrypted USB drive | Format with BitLocker To Go (Windows) or VeraCrypt, then copy the file onto it | Keep the drive somewhere safe, away from the laptop |
| Paper | Write the key by hand, twice, check every character, keep in a safe place | Easy to mistype; verify it (step 4) before trusting it |

**Do not:** email it to yourself, store it in OneDrive/Google Drive/Dropbox, take a screenshot, put it in a
chat or a GitHub repository, or keep it in this project folder.

To copy the file yourself: open File Explorer, go to `C:\Users\<you>\.payrail\`, and copy `rehearsal.env`
to your encrypted drive (or open it in Notepad and paste its single line into your password manager).
Close Notepad afterwards.

## 4. Verify the backup without showing the key

Use the checker. It prints only the **public** address and whether it matches:

```sh
node --env-file=<path to the backup file> scripts/check-key-file.ts --expect <your public wallet address>
```

You want to see `[PASS] this key belongs to the expected wallet …`. A `[MISMATCH]` or `[FAIL]` means the
backup is wrong: fix it and check again. If your backup is a note in a password manager, paste it into a
temporary file in a safe place, run the check, then **delete the temporary file**.

Do a restore test once: confirm you can read the backup on a different day, from the place you stored it.

## 5. If the key might be exposed

1. Stop using the wallet for new activity.
2. Move remaining funds to a new wallet that you create yourself.
3. Tell the organizers: the entry is tied to the old wallet.
4. Do not paste the key anywhere to "check" it. Use only `scripts/check-key-file.ts`.

## 6. What the assistant will and will not do

It will not read, print, copy, move or upload the key file, and will not create a replacement wallet.
It can only help you run the checker above and read its public output.
