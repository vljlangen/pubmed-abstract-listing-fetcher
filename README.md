# PubMed Abstract Listing Fetcher

Build a **single continuous HTML page** of PubMed abstracts from a plain-text reference list (one non-empty line per reference). Optional **desktop app** (Windows / macOS) packages the same engine with a simple UI and a ZIP export (HTML, PDF, TXT).

**Latest downloads (GitHub Releases):**  
[https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)

That **`/releases/latest`** URL always points at the **newest** release, so you can link it from a website or email without updating the link for each version. Individual file names under **Assets** still include the version (for example `…1.0.0.exe`); open the page and pick the file for your computer.

---

## 1) Windows (PC)

1. Open **[Releases → Latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)**.
2. Under **Assets**, download the **portable `.exe`** (x64).
3. Run the `.exe`. Paste references or choose a `.txt` file, then use **Get abstracts & save ZIP** when prompted to save the bundle.

If Windows SmartScreen warns about an unknown publisher, you may need **More info → Run anyway** (expected for unsigned builds).

---

## 2) macOS

1. Open **[Releases → Latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)**.
2. Under **Assets**, download the **`.dmg` for your Mac**:
   - **Apple Silicon (M1 / M2 / M3 / …):** choose the DMG whose name includes **`arm64`** (if both are offered).
   - **Intel Macs:** choose the **x64 / Intel** DMG (often the one **without** `arm64` in the name—check the release notes on the page).
3. Open the DMG, drag the app to **Applications**, launch it from there the first time. If Gatekeeper blocks it, use **Right-click → Open** once.

---

## 3) Linux (and anyone who prefers the command line)

No Electron build is required. Use **Node.js 20+** and the script in this repository.

1. Clone or copy the repo and `cd` into it.
2. Put your references in a file named **`references.txt`** in **the same directory** (or pass explicit paths—see below).
3. Run:

```bash
node pubmed_abstracts.js
```

Defaults:

- Input: **`references.txt`**
- Output: **`pubmed_abstracts.html`** (written in the **current working directory**)

Custom paths:

```bash
node pubmed_abstracts.js path/to/references.txt path/to/output.html
```

Optional: set **`NCBI_API_KEY`** (and **`NCBI_CONTACT_EMAIL`**) in the environment for higher NCBI rate limits and polite identification.

---

## License

See [`LICENSE`](LICENSE) (MIT).

---

## Building the desktop app from source

Requires Node.js and npm. From the repo root:

```bash
npm install
npm run dist:mac      # Apple Silicon DMG + ZIP (on Apple Silicon Mac)
npm run dist:mac-x64  # Intel Mac DMG + ZIP
npm run dist:win      # Windows x64 portable .exe
```

Artifacts appear under `dist-electron/` (ignored by git).
